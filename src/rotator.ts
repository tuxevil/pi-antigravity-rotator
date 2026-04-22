// Account rotation and token management with per-model routing

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
	type AccountRuntime,
	type AccountStatus,
	type Config,
	type GoogleQuotaResponse,
	type ModelQuota,
	type ModelRotationState,
	type PersistedState,
	type ProAdvisorAction,
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
import { getStatePath } from "./paths.js";

const STATE_FILE = getStatePath();

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
			flagged: false,
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
				account.flagged = saved.flagged ?? false;
				}
			}
			// Cap any stale cooldowns to 30 min max from now
			const maxCooldown = 30 * 60 * 1000;
			const now = Date.now();
			for (const account of this.accounts) {
				if (account.cooldownUntil > now + maxCooldown) {
					account.cooldownUntil = now + maxCooldown;
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
			flagged: account.flagged,
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
						// Only rotate if there's a healthy account to rotate to
						const hasHealthy = this.accounts.some(
							(a, idx) => idx !== mState.activeAccountIndex && this.isAvailable(a, Date.now()),
						);
						if (hasHealthy) {
							this.log(
								`${account.config.label || account.config.email} [${modelKey}]: quota dropped ${drop}% (${mState.quotaAtRotationStart}% -> ${modelQuota}%), rotating`,
							);
							await this.rotateModel(modelKey);
						} else {
							this.log(
								`${account.config.label || account.config.email} [${modelKey}]: quota dropped ${drop}% but no healthy accounts available, staying`,
							);
							mState.quotaAtRotationStart = modelQuota; // Reset baseline
						}
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

			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					const errorText = await response.text();
					this.log(`${account.config.email}: quota API returned ${response.status}, flagging account`);
					this.markFlagged(account, `Quota API ${response.status}: ${errorText.slice(0, 300)}`);
				}
				return;
			}

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
	//   1 (highest) = 5h timer -> drain Pro quota before reset to maximize the +40% recharge
	//   2           = 7d timer -> already ticking, use it
	//   3 (lowest)  = fresh -> no timer yet, save for when others are exhausted
	private getModelTimerPriority(account: AccountRuntime, modelKey: string): number {
		const type = this.getModelTimerType(account, modelKey);
		if (type === "5h") return 1;
		if (type === "7d") return 2;
		return 3;
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
			// Check if this account has quota for the requested model
			if (modelKey) {
				const quota = this.getModelQuota(current, modelKey);
				if (quota === 0) {
					this.log(
						`${current.config.label || current.config.email} [${modelKey}]: 0% quota, skipping`,
					);
					return this.rotateModel(modelKey);
				}
			}
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
				const quota = this.getModelQuota(account, modelKey);

				// Skip accounts with 0% quota for this model (they will 429)
				if (quota === 0) continue;

				const priority = this.getModelTimerPriority(account, modelKey);

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
		account.flagged = false;
		account.consecutiveErrors = 0;
		account.lastError = null;
		account.cooldownUntil = 0;
		this.saveState();
		this.log(`${email}: re-enabled`);
		return true;
	}

	resetAllCooldowns(): number {
		let count = 0;
		for (const account of this.accounts) {
			if (account.cooldownUntil > Date.now()) {
				account.cooldownUntil = 0;
				account.quotaExhaustedAt = 0;
				count++;
			}
		}
		if (count > 0) {
			this.saveState();
			this.log(`Reset cooldowns on ${count} accounts`);
		}
		return count;
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
		if (account.flagged) return false;
		if (account.cooldownUntil > now) return false;
		return true;
	}

	// Mark an account as flagged for infringement/abuse. Immediately excluded from rotation.
	markFlagged(account: AccountRuntime, reason: string): void {
		account.flagged = true;
		account.lastError = reason;
		this.log(`${account.config.email}: FLAGGED - ${reason}`);
		this.saveState();
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
			if (a.flagged) {
				status = "flagged";
			} else if (a.disabled) {
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
				proDetected: this.isProAccount(a),
				familyManager: !!a.config.familyManager,
			};
		});

		return {
			proxyPort: this.config.proxyPort,
			requestsPerRotation: this.config.requestsPerRotation,
			activeAccounts,
			totalRequestsAllAccounts: this.accounts.reduce((sum, a) => sum + a.totalRequests, 0),
			uptime: now - this.startTime,
			accounts,
			proAdvisor: this.getProAdvisor(),
		};
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	private log(msg: string): void {
		const ts = new Date().toISOString().slice(11, 19);
		console.log(`[${ts}] [rotator] ${msg}`);
	}

	// =========================================================================
	// Pro Family Sharing Advisor
	// =========================================================================

	// Model keys relevant for Pro advisor decisions (ignore Flash)
	private static PRO_ADVISOR_MODELS = ["gemini-3.1-pro", "claude-opus-4-6-thinking"];

	private isProAccount(account: AccountRuntime): boolean {
		return account.quota.some((q) => q.timerType === "5h");
	}

	private getProAdvisor(): StatusResponse["proAdvisor"] {
		const maxSlots = this.config.proSlots ?? 6;
		const proAccounts = this.accounts.filter((a) => !a.disabled && !a.flagged && this.isProAccount(a));
		const currentProCount = proAccounts.length;
		const actions: ProAdvisorAction[] = [];

		// Suggest "remove-pro" for Pro accounts (not family manager) with 0% on all advisor models
		for (const account of proAccounts) {
			if (account.config.familyManager) continue;
			const advisorQuotas = account.quota.filter((q) =>
				AccountRotator.PRO_ADVISOR_MODELS.some((m) => q.modelKey.includes(m) || m.includes(q.modelKey)),
			);
			if (advisorQuotas.length === 0) continue;
			const allExhausted = advisorQuotas.every((q) => q.percentRemaining === 0);
			if (allExhausted) {
				actions.push({
					type: "remove-pro",
					email: account.config.email,
					label: account.config.label || account.config.email,
					reason: "Pro quota exhausted on G3Pro and Claude",
				});
			}
		}

		// Suggest "add-pro" for Free accounts with 0% quota and long reset, if slots available
		const slotsAvailable = maxSlots - currentProCount + actions.filter((a) => a.type === "remove-pro").length;
		if (slotsAvailable > 0) {
			const candidates: { account: AccountRuntime; maxResetMs: number }[] = [];

			for (const account of this.accounts) {
				if (account.disabled || account.flagged) continue;
				if (this.isProAccount(account)) continue;

				const advisorQuotas = account.quota.filter((q) =>
					AccountRotator.PRO_ADVISOR_MODELS.some((m) => q.modelKey.includes(m) || m.includes(q.modelKey)),
				);
				if (advisorQuotas.length === 0) continue;

				// Only suggest if at least one advisor model is at 0%
				const hasExhausted = advisorQuotas.some((q) => q.percentRemaining === 0);
				if (!hasExhausted) continue;

				// Find the longest reset time among exhausted models
				let maxResetMs = 0;
				for (const q of advisorQuotas) {
					if (q.percentRemaining === 0 && q.resetTime) {
						const resetMs = new Date(q.resetTime).getTime() - Date.now();
						if (resetMs > maxResetMs) maxResetMs = resetMs;
					}
				}

				// Only suggest if reset is > 24h away (otherwise not worth the Pro slot)
				if (maxResetMs > 24 * 60 * 60 * 1000) {
					candidates.push({ account, maxResetMs });
				}
			}

			// Sort by longest reset time first (maximizes benefit)
			candidates.sort((a, b) => b.maxResetMs - a.maxResetMs);

			for (const { account, maxResetMs } of candidates.slice(0, slotsAvailable)) {
				const days = Math.floor(maxResetMs / (24 * 60 * 60 * 1000));
				const hours = Math.floor((maxResetMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
				actions.push({
					type: "add-pro",
					email: account.config.email,
					label: account.config.label || account.config.email,
					reason: `0% quota, resets in ${days}d ${hours}h`,
				});
			}
		}

		return { currentProCount, maxProSlots: maxSlots, actions };
	}
}
