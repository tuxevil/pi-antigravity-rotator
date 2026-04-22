// Account rotation and token management with per-model routing

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	type AccountRuntime,
	type AccountStatus,
	type Config,
	type GoogleQuotaResponse,
	type ModelQuota,
	type ModelRotationState,
	type PersistedState,
	type StatusResponse,
	CLIENT_ID,
	CLIENT_SECRET,
	TOKEN_URL,
	LONG_TIMER_MS,
	QUOTA_API_URL,
	QUOTA_USER_AGENT,
	QUOTA_MODEL_KEYS,
	resolveQuotaModelKey,
} from "./types.js";

const STATE_FILE = join(dirname(new URL(import.meta.url).pathname), "..", "state.json");

export class AccountRotator {
	private accounts: AccountRuntime[] = [];
	// Per-model active account tracking
	private modelState = new Map<string, ModelRotationState>();
	// Fallback for requests where model can't be resolved
	private defaultIndex = 0;
	private startTime = Date.now();
	private quotaPollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private config: Config) {
		this.initAccounts();
		this.loadState();
		this.startQuotaPolling();
	}

	private initAccounts(): void {
		this.accounts = this.config.accounts.map((config) => ({
			config,
			accessToken: null,
			tokenExpires: 0,
			requestsSinceRotation: 0,
			totalRequests: 0,
			cooldownUntil: 0,
			quotaExhaustedAt: 0,
			quota: [],
			lastQuotaPoll: 0,
			lastUsed: 0,
			lastError: null,
			consecutiveErrors: 0,
			disabled: false,
		}));
	}

	private loadState(): void {
		if (!existsSync(STATE_FILE)) return;
		try {
			const raw = readFileSync(STATE_FILE, "utf-8");
			const state: PersistedState = JSON.parse(raw);

			// Load per-model account assignments
			if (state.modelAccounts) {
				for (const [model, idx] of Object.entries(state.modelAccounts)) {
					this.modelState.set(model, {
						activeAccountIndex: Math.min(idx, this.accounts.length - 1),
						quotaAtRotationStart: -1,
					});
				}
			}
			// Legacy fallback
			if (state.currentIndex !== undefined) {
				this.defaultIndex = Math.min(state.currentIndex, this.accounts.length - 1);
			}

			for (const account of this.accounts) {
				const saved = state.accounts[account.config.email];
				if (saved) {
					account.totalRequests = saved.totalRequests;
					account.cooldownUntil = saved.cooldownUntil;
					account.quotaExhaustedAt = saved.quotaExhaustedAt;
					account.disabled = saved.disabled;
				}
			}
			this.log("Loaded state from disk");
		} catch {
			this.log("Could not load state, starting fresh");
		}
	}

	saveState(): void {
		const modelAccounts: Record<string, number> = {};
		for (const [model, state] of this.modelState.entries()) {
			modelAccounts[model] = state.activeAccountIndex;
		}

		const state: PersistedState = {
			modelAccounts,
			currentIndex: this.defaultIndex,
			accounts: {},
		};
		for (const account of this.accounts) {
			state.accounts[account.config.email] = {
				totalRequests: account.totalRequests,
				cooldownUntil: account.cooldownUntil,
				quotaExhaustedAt: account.quotaExhaustedAt,
				disabled: account.disabled,
			};
		}
		try {
			writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
		} catch (err) {
			this.log(`Failed to save state: ${err}`);
		}
	}

	// =========================================================================
	// Quota Polling
	// =========================================================================

	private startQuotaPolling(): void {
		const intervalMs = this.config.quotaPollIntervalMs || 300_000;
		this.log(`Quota polling every ${Math.round(intervalMs / 1000)}s`);

		// Initial poll (delayed 2s to allow token refresh first)
		setTimeout(() => this.pollAllQuotas(), 2000);

		this.quotaPollTimer = setInterval(() => this.pollAllQuotas(), intervalMs);
	}

	stopQuotaPolling(): void {
		if (this.quotaPollTimer) {
			clearInterval(this.quotaPollTimer);
			this.quotaPollTimer = null;
		}
	}

	private async pollAllQuotas(): Promise<void> {
		const available = this.accounts.filter((a) => !a.disabled);
		for (const account of available) {
			try {
				await this.ensureValidToken(account);
				await this.fetchQuota(account);
			} catch {
				// Token refresh or quota fetch failed, skip this account
			}
		}

		// Check per-model quota-based rotation
		if (this.config.rotateOnQuotaDrop > 0) {
			for (const [modelKey, mState] of this.modelState.entries()) {
				const account = this.accounts[mState.activeAccountIndex];
				if (!account) continue;

				const modelQuota = this.getModelQuota(account, modelKey);
				if (modelQuota < 0) continue; // No data yet

				if (mState.quotaAtRotationStart < 0) {
					// First reading for this rotation
					mState.quotaAtRotationStart = modelQuota;
					this.log(
						`${account.config.label || account.config.email} [${modelKey}]: baseline quota ${modelQuota}%`,
					);
				} else {
					const drop = mState.quotaAtRotationStart - modelQuota;
					if (drop >= this.config.rotateOnQuotaDrop) {
						this.log(
							`${account.config.label || account.config.email} [${modelKey}]: quota dropped ${drop}% (${mState.quotaAtRotationStart}% -> ${modelQuota}%), rotating`,
						);
						await this.rotateModel(modelKey);
					}
				}
			}
		}
	}

	private async fetchQuota(account: AccountRuntime): Promise<void> {
		if (!account.accessToken) return;

		try {
			const response = await fetch(QUOTA_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${account.accessToken}`,
					"User-Agent": QUOTA_USER_AGENT,
				},
				body: JSON.stringify({ project: account.config.projectId }),
				signal: AbortSignal.timeout(8000),
			});

			if (!response.ok) return;

			const data = (await response.json()) as GoogleQuotaResponse;
			account.quota = this.extractQuotas(data);
			account.lastQuotaPoll = Date.now();
		} catch {
			// Network error, skip
		}
	}

	private extractQuotas(data: GoogleQuotaResponse): ModelQuota[] {
		const quotas: ModelQuota[] = [];
		const now = Date.now();

		for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
			let modelInfo = data.models[config.key];

			if (!modelInfo) {
				for (const altKey of config.altKeys) {
					modelInfo = data.models[altKey];
					if (modelInfo) break;
				}
			}

			if (modelInfo?.quotaInfo) {
				const resetTime = modelInfo.quotaInfo.resetTime ?? null;
				let timerType: ModelQuota["timerType"] = "fresh";

				if (resetTime) {
					const resetMs = new Date(resetTime).getTime();
					if (resetMs > now) {
						const durationMs = resetMs - now;
						timerType = durationMs < 6 * 60 * 60 * 1000 ? "5h" : "7d";
					}
				}

				quotas.push({
					modelKey: config.key,
					displayName: config.display,
					percentRemaining: Math.round((modelInfo.quotaInfo.remainingFraction ?? 0) * 100),
					resetTime,
					timerType,
				});
			}
		}

		return quotas;
	}

	// Get quota % for a specific model on an account. Returns -1 if no data.
	private getModelQuota(account: AccountRuntime, modelKey: string): number {
		const q = account.quota.find((q) => q.modelKey === modelKey);
		return q ? q.percentRemaining : -1;
	}

	// Get timer type for a specific model on an account
	private getModelTimerType(account: AccountRuntime, modelKey: string): "fresh" | "5h" | "7d" {
		const q = account.quota.find((q) => q.modelKey === modelKey);
		return q?.timerType ?? "fresh";
	}

	// Timer priority for a specific model:
	//   1 (highest) = fresh -> start the 7d clock ASAP
	//   2           = 7d timer -> already ticking, use it
	//   3 (lowest)  = 5h timer -> short-lived, save for last
	private getModelTimerPriority(account: AccountRuntime, modelKey: string): number {
		const type = this.getModelTimerType(account, modelKey);
		if (type === "5h") return 3;
		if (type === "7d") return 2;
		return 1;
	}

	// =========================================================================
	// Account Selection (per-model)
	// =========================================================================

	// Get the active account for a specific model.
	// model is the raw model name from the request body.
	async getActiveAccount(model?: string): Promise<AccountRuntime | null> {
		const now = Date.now();
		if (this.accounts.length === 0) return null;

		const modelKey = model ? resolveQuotaModelKey(model) : null;
		const idx = modelKey
			? (this.modelState.get(modelKey)?.activeAccountIndex ?? this.defaultIndex)
			: this.defaultIndex;

		const current = this.accounts[idx];
		if (current && this.isAvailable(current, now)) {
			await this.ensureValidToken(current);
			return current;
		}

		// Current unavailable, find next
		return modelKey ? this.rotateModel(modelKey) : this.rotateDefault();
	}

	// Rotate a specific model to the best available account.
	async rotateModel(modelKey: string, now: number = Date.now()): Promise<AccountRuntime | null> {
		const currentIdx = this.modelState.get(modelKey)?.activeAccountIndex ?? -1;

		let best: AccountRuntime | null = null;
		let bestPriority = Infinity;
		let bestQuota = -2;
		let bestExhausted: AccountRuntime | null = null;
		let bestExhaustedCooldown = Infinity;

		for (let i = 0; i < this.accounts.length; i++) {
			if (i === currentIdx) continue;
			const account = this.accounts[i];

			if (this.isAvailable(account, now)) {
				const priority = this.getModelTimerPriority(account, modelKey);
				const quota = this.getModelQuota(account, modelKey);

				if (priority < bestPriority || (priority === bestPriority && quota > bestQuota)) {
					best = account;
					bestPriority = priority;
					bestQuota = quota;
				}
			} else if (!account.disabled && account.cooldownUntil > now) {
				const remaining = account.cooldownUntil - now;
				if (remaining < bestExhaustedCooldown) {
					bestExhaustedCooldown = remaining;
					bestExhausted = account;
				}
			}
		}

		if (best) {
			const newIdx = this.accounts.indexOf(best);
			const quota = this.getModelQuota(best, modelKey);
			const timerType = this.getModelTimerType(best, modelKey);
			this.modelState.set(modelKey, {
				activeAccountIndex: newIdx,
				quotaAtRotationStart: quota,
			});
			this.log(
				`[${modelKey}] Rotated to ${best.config.label || best.config.email} [${timerType}] (quota: ${quota >= 0 ? quota + "%" : "unknown"})`,
			);
			this.saveState();
			await this.ensureValidToken(best);
			return best;
		}

		if (bestExhausted) {
			const newIdx = this.accounts.indexOf(bestExhausted);
			this.modelState.set(modelKey, {
				activeAccountIndex: newIdx,
				quotaAtRotationStart: -1,
			});
			this.log(
				`[${modelKey}] All accounts exhausted. Using ${bestExhausted.config.email} (cooldown: ${Math.ceil(bestExhaustedCooldown / 1000)}s)`,
			);
			await this.ensureValidToken(bestExhausted);
			return bestExhausted;
		}

		this.log(`[${modelKey}] All accounts disabled or unavailable`);
		return null;
	}

	// Fallback rotation when model can't be resolved
	private async rotateDefault(now: number = Date.now()): Promise<AccountRuntime | null> {
		let best: AccountRuntime | null = null;
		let bestExhausted: AccountRuntime | null = null;
		let bestExhaustedCooldown = Infinity;

		for (let i = 0; i < this.accounts.length; i++) {
			if (i === this.defaultIndex) continue;
			const account = this.accounts[i];
			if (this.isAvailable(account, now)) {
				best = account;
				break;
			} else if (!account.disabled && account.cooldownUntil > now) {
				const remaining = account.cooldownUntil - now;
				if (remaining < bestExhaustedCooldown) {
					bestExhaustedCooldown = remaining;
					bestExhausted = account;
				}
			}
		}

		const selected = best || bestExhausted;
		if (selected) {
			this.defaultIndex = this.accounts.indexOf(selected);
			this.log(`[default] Rotated to ${selected.config.label || selected.config.email}`);
			this.saveState();
			await this.ensureValidToken(selected);
		}
		return selected || null;
	}

	// Force rotation for a model (called from proxy on 429 etc.)
	async rotateToNext(model?: string): Promise<AccountRuntime | null> {
		const modelKey = model ? resolveQuotaModelKey(model) : null;
		return modelKey ? this.rotateModel(modelKey) : this.rotateDefault();
	}

	// Record a successful request. Returns true if rotation is needed.
	recordRequest(account: AccountRuntime): boolean {
		account.requestsSinceRotation++;
		account.totalRequests++;
		account.lastUsed = Date.now();
		account.consecutiveErrors = 0;
		account.lastError = null;

		const shouldRotate = account.requestsSinceRotation >= this.config.requestsPerRotation;
		if (shouldRotate) {
			account.requestsSinceRotation = 0;
			this.log(
				`${account.config.label || account.config.email}: hit rotation threshold (${this.config.requestsPerRotation})`,
			);
		}
		this.saveState();
		return shouldRotate;
	}

	// Mark an account as exhausted (429 or quota exceeded)
	markExhausted(account: AccountRuntime, cooldownMs: number): void {
		const now = Date.now();
		account.cooldownUntil = now + cooldownMs;
		account.quotaExhaustedAt = now;

		this.log(
			`${account.config.label || account.config.email}: EXHAUSTED, cooldown ${Math.ceil(cooldownMs / 1000)}s`,
		);
		this.saveState();
	}

	markError(account: AccountRuntime, error: string): void {
		account.lastError = error;
		account.consecutiveErrors++;
		if (account.consecutiveErrors >= 5) {
			account.disabled = true;
			this.log(`${account.config.email}: DISABLED after ${account.consecutiveErrors} consecutive errors`);
		}
		this.saveState();
	}

	enableAccount(email: string): boolean {
		const account = this.accounts.find((a) => a.config.email === email);
		if (!account) return false;
		account.disabled = false;
		account.consecutiveErrors = 0;
		account.lastError = null;
		account.cooldownUntil = 0;
		this.saveState();
		this.log(`${email}: re-enabled`);
		return true;
	}

	async ensureValidToken(account: AccountRuntime): Promise<void> {
		const now = Date.now();
		if (account.accessToken && account.tokenExpires > now) {
			return;
		}

		this.log(`Refreshing token for ${account.config.label || account.config.email}...`);
		try {
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					client_secret: CLIENT_SECRET,
					refresh_token: account.config.refreshToken,
					grant_type: "refresh_token",
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				const msg = `Token refresh failed (${response.status}): ${errorText}`;
				this.markError(account, msg);
				throw new Error(msg);
			}

			const data = (await response.json()) as {
				access_token: string;
				expires_in: number;
			};

			account.accessToken = data.access_token;
			account.tokenExpires = now + data.expires_in * 1000 - 5 * 60 * 1000;
			account.consecutiveErrors = 0;
			this.log(`Token refreshed for ${account.config.label || account.config.email}`);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Token refresh failed")) {
				throw err;
			}
			const msg = `Token refresh error: ${err instanceof Error ? err.message : String(err)}`;
			this.markError(account, msg);
			throw new Error(msg);
		}
	}

	private isAvailable(account: AccountRuntime, now: number): boolean {
		if (account.disabled) return false;
		if (account.cooldownUntil > now) return false;
		return true;
	}

	getStatus(): StatusResponse {
		const now = Date.now();

		// Build per-model active account map
		const activeAccounts: Record<string, string> = {};
		for (const [model, mState] of this.modelState.entries()) {
			const account = this.accounts[mState.activeAccountIndex];
			if (account) {
				activeAccounts[model] = account.config.email;
			}
		}

		const accounts: AccountStatus[] = this.accounts.map((a) => {
			// Determine which models this account is active for
			const activeForModels: string[] = [];
			for (const [model, mState] of this.modelState.entries()) {
				if (this.accounts[mState.activeAccountIndex] === a) {
					activeForModels.push(model);
				}
			}

			let status: AccountStatus["status"];
			if (a.disabled) {
				status = "disabled";
			} else if (a.consecutiveErrors > 0 && !a.disabled) {
				status = "error";
			} else if (a.cooldownUntil > now) {
				status = "cooldown";
			} else if (activeForModels.length > 0) {
				status = "active";
			} else {
				status = "ready";
			}

			return {
				email: a.config.email,
				label: a.config.label || a.config.email,
				type: a.config.type || "free",
				status,
				activeForModels,
				requestsSinceRotation: a.requestsSinceRotation,
				totalRequests: a.totalRequests,
				cooldownUntil: a.cooldownUntil,
				cooldownRemaining: Math.max(0, a.cooldownUntil - now),
				lastUsed: a.lastUsed,
				lastError: a.lastError,
				consecutiveErrors: a.consecutiveErrors,
				hasValidToken: !!(a.accessToken && a.tokenExpires > now),
				quota: a.quota,
			};
		});

		return {
			proxyPort: this.config.proxyPort,
			requestsPerRotation: this.config.requestsPerRotation,
			activeAccounts,
			totalRequestsAllAccounts: this.accounts.reduce((sum, a) => sum + a.totalRequests, 0),
			uptime: now - this.startTime,
			accounts,
		};
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	private log(msg: string): void {
		const ts = new Date().toISOString().slice(11, 19);
		console.log(`[${ts}] [rotator] ${msg}`);
	}
}
