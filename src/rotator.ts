// Account rotation and token management with per-model routing

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
	type AccountConfig,
	type AccountRuntime,
	type AccountStatus,
	type Config,
	type GoogleQuotaResponse,
	type ModelQuota,
	type ModelRotationState,
	type PersistedState,
	type ProAdvisorAction,
	type StatusResponse,
	TOKEN_URL,
	LONG_TIMER_MS,
	QUOTA_API_URL,
	QUOTA_USER_AGENT,
	QUOTA_MODEL_KEYS,
	resolveQuotaModelKey,
} from "./types.js";
import { getStatePath } from "./paths.js";
import { saveAccountsConfig } from "./account-store.js";
import { getOAuthClientConfig } from "./oauth.js";

const STATE_FILE = getStatePath();

export class AccountRotator {
	private accounts: AccountRuntime[] = [];
	// Per-model active account tracking
	private modelState = new Map<string, ModelRotationState>();
	// Fallback for requests where model can't be resolved
	private defaultIndex = 0;
	private startTime = Date.now();
	private quotaPollTimer: ReturnType<typeof setInterval> | null = null;
	private protectivePauseUntil = 0;
	private protectivePauseReason: string | null = null;
	private allowFreshWindowStarts = true;
	private recentEvents: StatusResponse["recentEvents"] = [];
	private static readonly RECENT_EVENT_LIMIT = 40;

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
			inFlightRequests: 0,
			allowFreshWindowStartsOverride: false,
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
			this.protectivePauseUntil = state.protectivePauseUntil ?? 0;
			this.protectivePauseReason = state.protectivePauseReason ?? null;
			this.allowFreshWindowStarts = state.allowFreshWindowStarts ?? true;

			for (const account of this.accounts) {
				const saved = state.accounts[account.config.email];
				if (saved) {
					account.totalRequests = saved.totalRequests;
					account.cooldownUntil = saved.cooldownUntil;
					account.quotaExhaustedAt = saved.quotaExhaustedAt;
					account.disabled = saved.disabled;
					account.flagged = saved.flagged ?? false;
					account.allowFreshWindowStartsOverride = saved.allowFreshWindowStartsOverride ?? false;
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
			protectivePauseUntil: this.protectivePauseUntil,
			protectivePauseReason: this.protectivePauseReason,
			allowFreshWindowStarts: this.allowFreshWindowStarts,
			accounts: {},
		};
		for (const account of this.accounts) {
			state.accounts[account.config.email] = {
				totalRequests: account.totalRequests,
				cooldownUntil: account.cooldownUntil,
				quotaExhaustedAt: account.quotaExhaustedAt,
				disabled: account.disabled,
				flagged: account.flagged,
				allowFreshWindowStartsOverride: account.allowFreshWindowStartsOverride,
			};
		}
			try {
				writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
			} catch (err) {
				this.log(`Failed to save state: ${err}`, "error");
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
		if (this.isProtectivePauseActive(Date.now())) {
			return;
		}
		const available = this.accounts.filter((a) => !a.disabled && !a.flagged);
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
	//   1 (highest) = 5h timer -> only class with hard quota loss if underused before reset
	//   2           = 7d timer -> already ticking, keep those long windows moving
	//   3 (lowest)  = fresh -> no visible timer is running yet
	private getModelTimerPriority(account: AccountRuntime, modelKey: string): number {
		const type = this.getModelTimerType(account, modelKey);
		if (type === "5h") return 1;
		if (type === "7d") return 2;
		return 3;
	}

	private isFreshWindowAllowed(account: AccountRuntime, modelKey: string): boolean {
		if (this.allowFreshWindowStarts) return true;
		if (account.allowFreshWindowStartsOverride) return true;
		return this.getModelTimerType(account, modelKey) !== "fresh";
	}

	private isEffectiveFreshWindowAllowed(account: AccountRuntime): boolean {
		return this.allowFreshWindowStarts || account.allowFreshWindowStartsOverride;
	}

	private isTimedWindow(account: AccountRuntime, modelKey: string): boolean {
		return this.getModelTimerType(account, modelKey) !== "fresh";
	}

	private hasTimedCandidate(modelKey: string, now: number, excludeIdx: number = -1): boolean {
		return this.accounts.some((account, idx) => {
			if (idx === excludeIdx) return false;
			if (!this.isAvailable(account, now)) return false;
			if (this.getModelQuota(account, modelKey) === 0) return false;
			return this.isTimedWindow(account, modelKey);
		});
	}

	private pickBestModelAccount(modelKey: string, now: number, excludeIdx: number = -1): AccountRuntime | null {
		let best: AccountRuntime | null = null;
		let bestPriority = Infinity;
		let bestQuota = -2;
		let bestDistance = Infinity;

		for (let i = 0; i < this.accounts.length; i++) {
			if (i === excludeIdx) continue;
			const account = this.accounts[i];
			if (!this.isAvailable(account, now)) continue;

			const quota = this.getModelQuota(account, modelKey);
			if (quota === 0) continue;
			if (!this.isFreshWindowAllowed(account, modelKey)) continue;

			const priority = this.getModelTimerPriority(account, modelKey);
			const distance =
				excludeIdx >= 0 ? (i - excludeIdx + this.accounts.length) % this.accounts.length : i + 1;
			if (
				priority < bestPriority ||
				(priority === bestPriority && quota > bestQuota) ||
				(priority === bestPriority && quota === bestQuota && distance < bestDistance)
			) {
				best = account;
				bestPriority = priority;
				bestQuota = quota;
				bestDistance = distance;
			}
		}

		return best;
	}

	// =========================================================================
	// Account Selection (per-model)
	// =========================================================================

	// Get the active account for a specific model.
	// model is the raw model name from the request body.
	async getActiveAccount(model?: string): Promise<AccountRuntime | null> {
		const now = Date.now();
		if (this.accounts.length === 0) return null;
		if (this.isProtectivePauseActive(now)) return null;

		const modelKey = model ? resolveQuotaModelKey(model) : null;
		const state = modelKey ? this.modelState.get(modelKey) : null;
		const idx = state?.activeAccountIndex ?? this.defaultIndex;

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
				if (!this.isFreshWindowAllowed(current, modelKey)) {
					const label = current.config.label || current.config.email;
					this.log(
						this.hasTimedCandidate(modelKey, now, idx)
							? `${label} [${modelKey}]: skipping fresh window because fresh starts are disabled and timed buckets are available`
							: `${label} [${modelKey}]: fresh window blocked by operator toggle`,
						"warn",
					);
					return this.rotateModel(modelKey);
				}
			}
			this.startRequest(current);
			try {
				await this.ensureValidToken(current);
				return current;
			} catch (err) {
				this.finishRequest(current);
				throw err;
			}
		}

		// Current unavailable, or no per-model assignment yet
		if (modelKey) {
			return this.rotateModel(modelKey, now, state ? idx : -1);
		}
		return this.rotateDefault();
	}

	// Rotate a specific model to the best available account.
	async rotateModel(
		modelKey: string,
		now: number = Date.now(),
		excludeIdx: number = this.modelState.get(modelKey)?.activeAccountIndex ?? -1,
	): Promise<AccountRuntime | null> {
		const best = this.pickBestModelAccount(modelKey, now, excludeIdx);

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
			this.startRequest(best);
			try {
				await this.ensureValidToken(best);
				return best;
			} catch (err) {
				this.finishRequest(best);
				throw err;
			}
		}

		if (!this.allowFreshWindowStarts && this.accounts.some((account, idx) => {
			if (idx === excludeIdx) return false;
			if (!this.isAvailable(account, now)) return false;
			if (this.getModelQuota(account, modelKey) === 0) return false;
			return this.getModelTimerType(account, modelKey) === "fresh";
		})) {
			this.log(
				`[${modelKey}] Fresh windows are available but blocked by operator toggle; keeping routing on existing timed buckets only`,
				"warn",
			);
			return null;
		}

		const shortestCooldown = this.accounts.reduce<number | null>((bestRemaining, account) => {
			if (account.disabled || account.flagged || account.cooldownUntil <= now) return bestRemaining;
			const remaining = account.cooldownUntil - now;
			if (bestRemaining === null || remaining < bestRemaining) return remaining;
			return bestRemaining;
		}, null);

		if (shortestCooldown !== null) {
			this.log(
				`[${modelKey}] All accounts exhausted. Waiting ${Math.ceil(shortestCooldown / 1000)}s for cooldown`,
			);
		} else {
			this.log(`[${modelKey}] All accounts disabled or unavailable`);
		}
		return null;
	}

	// Fallback rotation when model can't be resolved
	private async rotateDefault(now: number = Date.now()): Promise<AccountRuntime | null> {
		let best: AccountRuntime | null = null;

		for (let i = 0; i < this.accounts.length; i++) {
			if (i === this.defaultIndex) continue;
			const account = this.accounts[i];
			if (this.isAvailable(account, now)) {
				best = account;
				break;
			}
		}

		if (best) {
			this.defaultIndex = this.accounts.indexOf(best);
			this.log(`[default] Rotated to ${best.config.label || best.config.email}`);
			this.saveState();
			this.startRequest(best);
			try {
				await this.ensureValidToken(best);
				return best;
			} catch (err) {
				this.finishRequest(best);
				throw err;
			}
		}

		const shortestCooldown = this.accounts.reduce<number | null>((bestRemaining, account) => {
			if (account.disabled || account.flagged || account.cooldownUntil <= now) return bestRemaining;
			const remaining = account.cooldownUntil - now;
			if (bestRemaining === null || remaining < bestRemaining) return remaining;
			return bestRemaining;
		}, null);

		if (shortestCooldown !== null) {
			this.log(`[default] All accounts exhausted. Waiting ${Math.ceil(shortestCooldown / 1000)}s for cooldown`);
		} else {
			this.log("[default] All accounts disabled or unavailable");
		}
		return null;
	}

	// Force rotation for a model (called from proxy on 429 etc.)
	async rotateToNext(model?: string): Promise<AccountRuntime | null> {
		if (this.isProtectivePauseActive(Date.now())) return null;
		const modelKey = model ? resolveQuotaModelKey(model) : null;
		return modelKey ? this.rotateModel(modelKey) : this.rotateDefault();
	}

	// Record a successful request. Returns true if rotation is needed.
	recordRequest(account: AccountRuntime, model?: string): boolean {
		account.requestsSinceRotation++;
		account.totalRequests++;
		account.lastUsed = Date.now();
		account.consecutiveErrors = 0;
		account.lastError = null;

		const shouldRotate =
			this.shouldUseRequestCountRotation(account, model) &&
			account.requestsSinceRotation >= this.config.requestsPerRotation;
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
				"warn",
			);
		this.saveState();
	}

	markError(account: AccountRuntime, error: string): void {
		account.lastError = error;
			account.consecutiveErrors++;
			if (account.consecutiveErrors >= 5) {
				account.disabled = true;
				this.log(`${account.config.email}: DISABLED after ${account.consecutiveErrors} consecutive errors`, "error");
			}
		this.saveState();
	}

	enableAccount(email: string): boolean {
			const account = this.accounts.find((a) => a.config.email === email);
			if (!account) return false;
			if (account.flagged) {
				this.log(`${email}: refused re-enable because account is flagged; resolve the provider block first`, "warn");
				return false;
			}
		account.disabled = false;
		account.flagged = false;
		account.consecutiveErrors = 0;
		account.lastError = null;
		account.cooldownUntil = 0;
		this.saveState();
		this.log(`${email}: re-enabled`);
		return true;
	}

	setAllowFreshWindowStarts(enabled: boolean): boolean {
		if (this.allowFreshWindowStarts === enabled) return false;
		this.allowFreshWindowStarts = enabled;
		this.saveState();
		this.log(
			enabled
				? "Operator enabled fresh window starts; the rotator may seed new timer windows again"
				: "Operator disabled fresh window starts; the rotator will only use buckets whose timers are already running",
			"warn",
		);
		return true;
	}

	setAccountAllowFreshWindowStartsOverride(email: string, enabled: boolean): boolean {
		const account = this.accounts.find((a) => a.config.email === email);
		if (!account) return false;
		if (account.allowFreshWindowStartsOverride === enabled) return true;
		account.allowFreshWindowStartsOverride = enabled;
		this.saveState();
		this.log(
			enabled
				? `${email}: operator override enabled fresh window starts for this account`
				: `${email}: operator override cleared; this account now follows the global fresh-window policy`,
			"warn",
		);
		return true;
	}

	async ensureValidToken(account: AccountRuntime): Promise<void> {
		const now = Date.now();
		if (account.accessToken && account.tokenExpires > now) {
			return;
		}

		this.log(`Refreshing token for ${account.config.label || account.config.email}...`);
		try {
			const oauth = getOAuthClientConfig();
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: oauth.clientId,
					client_secret: oauth.clientSecret,
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
		if (account.inFlightRequests >= (this.config.maxConcurrentRequestsPerAccount ?? 1)) return false;
		return true;
	}

	// Mark an account as flagged for infringement/abuse. Immediately excluded from rotation.
	markFlagged(account: AccountRuntime, reason: string): void {
			account.flagged = true;
			account.lastError = reason;
			account.inFlightRequests = 0;
			this.log(`${account.config.email}: FLAGGED - ${reason}`, "error");
			if (this.shouldTriggerProtectivePause(reason)) {
				this.protectivePauseUntil = Date.now() + (this.config.protectivePauseMs ?? 6 * 60 * 60 * 1000);
				this.protectivePauseReason = `${account.config.email}: ${reason}`;
				this.log(
					`Protective pause enabled for ${Math.ceil((this.protectivePauseUntil - Date.now()) / 1000)}s after serious provider flag`,
					"warn",
				);
			}
		this.saveState();
	}

	startRequest(account: AccountRuntime): void {
		account.inFlightRequests++;
	}

	finishRequest(account: AccountRuntime): void {
		account.inFlightRequests = Math.max(0, account.inFlightRequests - 1);
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
				inFlightRequests: a.inFlightRequests,
				proDetected: this.isProAccount(a),
				familyManager: !!a.config.familyManager,
				allowFreshWindowStartsOverride: a.allowFreshWindowStartsOverride,
				effectiveFreshWindowStartsAllowed: this.isEffectiveFreshWindowAllowed(a),
			};
		});

		const routingHealth = this.getRoutingHealth(now, accounts);

		return {
			proxyPort: this.config.proxyPort,
			requestsPerRotation: this.config.requestsPerRotation,
			activeAccounts,
			totalRequestsAllAccounts: this.accounts.reduce((sum, a) => sum + a.totalRequests, 0),
			uptime: now - this.startTime,
			protectivePauseUntil: this.protectivePauseUntil,
			protectivePauseRemaining: Math.max(0, this.protectivePauseUntil - now),
			protectivePauseReason: this.isProtectivePauseActive(now) ? this.protectivePauseReason : null,
			operatorControls: {
				allowFreshWindowStarts: this.allowFreshWindowStarts,
			},
			routingHealth,
			accounts,
			proAdvisor: this.getProAdvisor(),
			recentEvents: [...this.recentEvents],
		};
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	addOrUpdateAccount(accountConfig: AccountConfig): void {
		const existingIndex = this.accounts.findIndex((account) => account.config.email === accountConfig.email);
		if (existingIndex >= 0) {
			const existing = this.accounts[existingIndex];
			existing.config = { ...existing.config, ...accountConfig };
			existing.disabled = false;
			existing.flagged = false;
			existing.lastError = null;
			existing.consecutiveErrors = 0;
			existing.accessToken = null;
			existing.tokenExpires = 0;
			this.config.accounts[existingIndex] = existing.config;
			this.log(`${accountConfig.email}: account updated via hosted login`);
		} else {
			const runtime: AccountRuntime = {
				config: accountConfig,
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
				inFlightRequests: 0,
				allowFreshWindowStartsOverride: false,
			};
			this.accounts.push(runtime);
			this.config.accounts.push(runtime.config);
			this.log(`${accountConfig.email}: account added via hosted login`);
		}

		saveAccountsConfig(this.config);
		this.saveState();
		void this.pollAllQuotas();
	}

	recordProxyEvent(msg: string, level: "info" | "warn" | "error" = "info"): void {
		this.pushRecentEvent("proxy", msg, level);
	}

	private log(msg: string, level: "info" | "warn" | "error" = "info"): void {
		const ts = new Date().toISOString().slice(11, 19);
		console.log(`[${ts}] [rotator] ${msg}`);
		this.pushRecentEvent("rotator", msg, level);
	}

	private pushRecentEvent(
		source: "rotator" | "proxy",
		message: string,
		level: "info" | "warn" | "error",
	): void {
		this.recentEvents.unshift({
			timestamp: Date.now(),
			source,
			level,
			message,
		});
		if (this.recentEvents.length > AccountRotator.RECENT_EVENT_LIMIT) {
			this.recentEvents.length = AccountRotator.RECENT_EVENT_LIMIT;
		}
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

	private shouldUseRequestCountRotation(account: AccountRuntime, model?: string): boolean {
		if (!this.config.useRequestCountRotationWhenQuotaUnknownOnly) return true;
		const modelKey = model ? resolveQuotaModelKey(model) : null;
		if (!modelKey) return true;
		return this.getModelQuota(account, modelKey) < 0;
	}

	private shouldTriggerProtectivePause(reason: string): boolean {
		const lower = reason.toLowerCase();
		const severePatterns = ["terms of service", "violat", "suspend", "banned", "abus", "infring"];
		return severePatterns.some((pattern) => lower.includes(pattern));
	}

	private isProtectivePauseActive(now: number): boolean {
		return this.protectivePauseUntil > now;
	}

	private getRoutingHealth(now: number, accounts: AccountStatus[]): StatusResponse["routingHealth"] {
		const activeCount = accounts.filter((a) => a.status === "active").length;
		const readyCount = accounts.filter((a) => a.status === "ready").length;
		const cooldownCount = accounts.filter((a) => a.status === "cooldown").length;
		const flaggedCount = accounts.filter((a) => a.status === "flagged").length;
		const disabledCount = accounts.filter((a) => a.status === "disabled").length;
		const errorCount = accounts.filter((a) => a.status === "error").length;
		const busyCount = accounts.filter(
			(a) => a.status !== "disabled" && a.status !== "flagged" && a.inFlightRequests > 0,
		).length;
		const rawAvailableCount = this.accounts.filter((a) => this.isAvailable(a, now)).length;
		const timedAvailableCount = this.accounts.filter((account) => {
			if (!this.isAvailable(account, now)) return false;
			const hasTimedQuota = account.quota.some((q) => q.percentRemaining !== 0 && q.timerType !== "fresh");
			return hasTimedQuota || account.allowFreshWindowStartsOverride;
		}).length;
		const availableCount = this.allowFreshWindowStarts ? rawAvailableCount : timedAvailableCount;
		const shortestCooldown = accounts
			.filter((a) => a.cooldownRemaining > 0)
			.reduce((best, account) => (best === 0 || account.cooldownRemaining < best ? account.cooldownRemaining : best), 0);
		const pauseRemaining = Math.max(0, this.protectivePauseUntil - now);
		const freshOnlyBlocked = !this.allowFreshWindowStarts && rawAvailableCount > 0 && timedAvailableCount === 0;

		if (pauseRemaining > 0) {
			return {
				state: "paused",
				reason: this.protectivePauseReason || "Protective pause active after provider flag",
				nextRetryIn: pauseRemaining,
				availableCount,
				readyCount,
				activeCount,
				cooldownCount,
				busyCount,
				flaggedCount,
				disabledCount,
				errorCount,
			};
		}

		if (availableCount > 0) {
			const freshPolicyNote = !this.allowFreshWindowStarts
				? " Fresh window starts are currently disabled by the operator."
				: "";
			return {
				state: "healthy",
				reason: `Routing can serve requests.${freshPolicyNote}`,
				nextRetryIn: 0,
				availableCount,
				readyCount,
				activeCount,
				cooldownCount,
				busyCount,
				flaggedCount,
				disabledCount,
				errorCount,
			};
		}

		if (freshOnlyBlocked) {
			return {
				state: "stopped",
				reason: "Only fresh windows remain, and the operator toggle is preventing the rotator from opening them right now.",
				nextRetryIn: 0,
				availableCount,
				readyCount,
				activeCount,
				cooldownCount,
				busyCount,
				flaggedCount,
				disabledCount,
				errorCount,
			};
		}

		if (cooldownCount > 0) {
			return {
				state: "cooldown_wait",
				reason: "All non-quarantined accounts are cooling down",
				nextRetryIn: shortestCooldown,
				availableCount,
				readyCount,
				activeCount,
				cooldownCount,
				busyCount,
				flaggedCount,
				disabledCount,
				errorCount,
			};
		}

		if (busyCount > 0) {
			return {
				state: "busy",
				reason: "All available accounts are currently busy with in-flight requests",
				nextRetryIn: 0,
				availableCount,
				readyCount,
				activeCount,
				cooldownCount,
				busyCount,
				flaggedCount,
				disabledCount,
				errorCount,
			};
		}

		return {
			state: "stopped",
			reason: !this.allowFreshWindowStarts
				? "No timed bucket is currently routable. Fresh window starts are disabled, so the rotator is waiting for an already-running timer, cooldown recovery, or operator action."
				: "No account is currently routable. All accounts are flagged, disabled, or unavailable.",
			nextRetryIn: 0,
			availableCount,
			readyCount,
			activeCount,
			cooldownCount,
			busyCount,
			flaggedCount,
			disabledCount,
			errorCount,
		};
	}
}
