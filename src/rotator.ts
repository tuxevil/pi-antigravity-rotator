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
	type QuotaWindowHistory,
	type DualWindowTracker,
	type ProAdvisorAction,
	type StatusResponse,
	type TokenBucket,
	type TokenUsageData,
	type TokenUsageTiered,
	MODEL_PRICING,
	TOKEN_URL,
	LONG_TIMER_MS,
	QUOTA_API_URL,
	QUOTA_USER_AGENT,
	QUOTA_MODEL_KEYS,
	resolveQuotaModelKey,
	resolveDisplayModelKey,
} from "./types.js";
import { getStatePath } from "./paths.js";
import { saveAccountsConfig } from "./account-store.js";
import { getOAuthClientConfig } from "./oauth.js";
import { fetchWithRetry } from "./fetch-with-retry.js";
import { logger } from "./logger.js";

const rotatorLogger = logger.child("rotator");

const STATE_FILE = getStatePath();
const TOKENS_FILE = STATE_FILE.replace("state.json", "token-usage.json");

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
	private tokenBuckets: TokenUsageTiered = { minutes: [], hours: [], days: [], months: [] };
	private latencyRecords: Map<string, { ttfbMs: number; totalMs: number }[]> = new Map();
	private static readonly MAX_LATENCY_RECORDS = 200;
	private requestLog: StatusResponse["requestLog"] = [];
	private static readonly MAX_REQUEST_LOG = 200;

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
			cooldownsByModel: {},
			quotaExhaustedAt: 0,
			quota: [],
			lastQuotaPoll: 0,
			lastUsed: 0,
			lastError: null,
			consecutiveErrors: 0,
			disabled: false,
			flagged: false,
			inFlightRequests: 0,
			inFlightByModel: {},
			allowFreshWindowStartsOverride: false,
			quotaWindows: {},
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
						requestsOnActiveAccount: state.modelRequestCounts?.[model] ?? 0,
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
					account.cooldownsByModel = saved.cooldownsByModel ?? {};
					if (saved.cooldownUntil !== undefined && Object.keys(account.cooldownsByModel).length === 0) {
						// legacy migration: apply global cooldown to default
						account.cooldownsByModel["__default__"] = saved.cooldownUntil;
					}
					account.quotaExhaustedAt = saved.quotaExhaustedAt;
					account.disabled = saved.disabled;
					account.flagged = saved.flagged ?? false;
				account.allowFreshWindowStartsOverride = saved.allowFreshWindowStartsOverride ?? false;
					account.quotaWindows = saved.quotaWindows ?? {};
				}
			}
			// Cap any stale cooldowns to 30 min max from now
			const maxCooldown = 30 * 60 * 1000;
			const now = Date.now();
			for (const account of this.accounts) {
				for (const [model, cooldown] of Object.entries(account.cooldownsByModel)) {
					if (cooldown > now + maxCooldown) {
						account.cooldownsByModel[model] = now + maxCooldown;
					}
				}
			}
			this.log("Loaded state from disk");
		} catch {
			this.log("Could not load state, starting fresh");
		}
		// Load token usage from separate file
		try {
			if (existsSync(TOKENS_FILE)) {
				const raw = readFileSync(TOKENS_FILE, "utf-8");
				const parsed = JSON.parse(raw);
				const normalize = (arr: any[]): TokenBucket[] => (arr || []).map((b: any) => ({
					period: b.period ?? b.hour ?? "unknown",
					inputTokens: Number(b.inputTokens || 0),
					outputTokens: Number(b.outputTokens || 0),
					requests: Number(b.requests || 0),
					byModel: b.byModel || {},
				})).filter((b: TokenBucket) => b.period && b.period !== "unknown");
				if (Array.isArray(parsed)) {
					// Migrate from flat array (old format)
					this.tokenBuckets = { minutes: normalize(parsed), hours: [], days: [], months: [] };
				} else {
					this.tokenBuckets = {
						minutes: normalize(parsed.minutes || []),
						hours: normalize(parsed.hours || []),
						days: normalize(parsed.days || []),
						months: normalize(parsed.months || []),
					};
				}
				const total = this.tokenBuckets.minutes.length + this.tokenBuckets.hours.length + this.tokenBuckets.days.length + this.tokenBuckets.months.length;
				this.log(`Loaded ${total} token usage buckets`);
			}
		} catch {
			this.log("Could not load token usage, starting fresh");
		}
	}

	saveState(): void {
		const modelAccounts: Record<string, number> = {};
		const modelRequestCounts: Record<string, number> = {};
		for (const [model, state] of this.modelState.entries()) {
			modelAccounts[model] = state.activeAccountIndex;
			modelRequestCounts[model] = state.requestsOnActiveAccount;
		}

		const state: PersistedState = {
			modelAccounts,
			modelRequestCounts,
			currentIndex: this.defaultIndex,
			protectivePauseUntil: this.protectivePauseUntil,
			protectivePauseReason: this.protectivePauseReason,
			allowFreshWindowStarts: this.allowFreshWindowStarts,
			accounts: {},
		};
		for (const account of this.accounts) {
			state.accounts[account.config.email] = {
				totalRequests: account.totalRequests,
				cooldownsByModel: { ...account.cooldownsByModel },
				quotaExhaustedAt: account.quotaExhaustedAt,
				disabled: account.disabled,
				flagged: account.flagged,
				allowFreshWindowStartsOverride: account.allowFreshWindowStartsOverride,
					quotaWindows: account.quotaWindows,
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
							(a, idx) => idx !== mState.activeAccountIndex && this.isRoutableForModel(a, modelKey, Date.now()),
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
			const response = await fetchWithRetry(QUOTA_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${account.accessToken}`,
					"User-Agent": QUOTA_USER_AGENT,
				},
				body: JSON.stringify({ project: account.config.projectId }),
				timeoutMs: 8000,
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
			const oldQuota = account.quota || [];
			account.quota = this.extractQuotas(data, oldQuota);
			account.lastQuotaPoll = Date.now();

			// --- RAW QUOTA LOGGING FOR DEBUGGING ---
			const rawLog = account.quota.map(q => {
				const remain = q.resetTime ? Math.round((new Date(q.resetTime).getTime() - Date.now())/60000)+'m' : 'no_reset';
				return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}% in ${remain}]`;
			}).join(' | ');
			this.log(`RAW POLL ${account.config.email} -> ${rawLog}`);
			// ---------------------------------------

			// Record dual-window quota tracking per model (Immutable Anchors Architecture)
			const now = Date.now();
			const FIVE_HOURS_10MIN = (5 * 60 + 10) * 60 * 1000;
			const FIVE_MIN = 5 * 60 * 1000;

			// Step 1: Initialize tracking and check for the definitive PRO signal (genuine 5h timer)
			let accountIsDefinitivelyPro = false;
			for (const q of account.quota) {
				if (!account.quotaWindows[q.modelKey]) {
					account.quotaWindows[q.modelKey] = {
						pro: { lastSeen: 0, resetTimeMs: 0, resetTime: null, lastQuota: -1 },
						free: { lastSeen: 0, resetTimeMs: 0, resetTime: null, lastQuota: -1 },
					};
				}
				if (q.timerType === "5h") {
					const currentResetMs = q.resetTime ? new Date(q.resetTime).getTime() : 0;
					if (currentResetMs === 0 || (currentResetMs - now) <= FIVE_HOURS_10MIN) {
						accountIsDefinitivelyPro = true;
					}
				}
			}

			// Step 2: Update permanent anchors based on the definitive signal
			for (const q of account.quota) {
				if (q.timerType === "fresh") continue; // Fresh gives us no reset time to anchor
				const tracker = account.quotaWindows[q.modelKey];
				const currentResetMs = q.resetTime ? new Date(q.resetTime).getTime() : 0;
				if (currentResetMs === 0) continue;

				// Has the real-world time passed the existing Pro anchor?
				if (tracker.pro.resetTimeMs > 0 && now > tracker.pro.resetTimeMs) {
					// The old Pro anchor expired naturally. We clear it to make room for a new cycle.
					tracker.pro.resetTimeMs = 0;
					tracker.pro.resetTime = null;
				}
				// Has the real-world time passed the existing Free anchor?
				if (tracker.free.resetTimeMs > 0 && now > tracker.free.resetTimeMs) {
					// The old Free anchor expired naturally. We clear it to make room for a new cycle.
					tracker.free.resetTimeMs = 0;
					tracker.free.resetTime = null;
				}

				const matchesPro = tracker.pro.resetTimeMs > 0 && Math.abs(currentResetMs - tracker.pro.resetTimeMs) < FIVE_MIN;
				const matchesFree = tracker.free.resetTimeMs > 0 && Math.abs(currentResetMs - tracker.free.resetTimeMs) < FIVE_MIN;

				if (matchesPro) {
					// It's the Pro window. Update quota.
					tracker.pro.lastSeen = now;
					tracker.pro.lastQuota = q.percentRemaining;
				} else if (matchesFree) {
					// It's the Free window. Update quota.
					tracker.free.lastSeen = now;
					tracker.free.lastQuota = q.percentRemaining;
				} else {
					// This is a BRAND NEW reset time (doesn't match either anchor).
					// We must assign it to either the Pro bucket or the Free bucket.
					if (accountIsDefinitivelyPro) {
						// We have absolute proof the account is Pro right now.
						tracker.pro.lastSeen = now;
						tracker.pro.resetTimeMs = currentResetMs;
						tracker.pro.resetTime = q.resetTime;
						tracker.pro.lastQuota = q.percentRemaining;
					} else {
						// We have NO proof the account is Pro. Assume Free.
						tracker.free.lastSeen = now;
						tracker.free.resetTimeMs = currentResetMs;
						tracker.free.resetTime = q.resetTime;
						tracker.free.lastQuota = q.percentRemaining;
					}
				}
			}
		} catch {
			// Network error, skip
		}
	}

	private extractQuotas(data: GoogleQuotaResponse, oldQuota: ModelQuota[]): ModelQuota[] {
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
					const oldQ = oldQuota.find(q => q.modelKey === config.key);
					// If the resetTime is exactly the same as the previous poll, preserve the old timerType.
					// A timer doesn't change its nature just because it gets closer to zero.
					if (oldQ && oldQ.resetTime === resetTime && oldQ.timerType !== "fresh") {
						timerType = oldQ.timerType;
					} else {
						// It's a BRAND NEW timer (or we restarted the service).
						// Since it just started, we can measure the distance to determine its type.
						const resetMs = new Date(resetTime).getTime();
						if (resetMs > now) {
							const durationMs = resetMs - now;
							// If the new timer is < 6 hours away, it's a 5h timer. Otherwise 7d.
							timerType = durationMs < 6 * 60 * 60 * 1000 ? "5h" : "7d";
						}
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
			if (!this.isAvailableForModel(account, modelKey, now)) return false;
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
			if (!this.isAvailableForModel(account, modelKey, now)) continue;

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

	private countModelAssignment(modelKey: string): void {
		const state = this.modelState.get(modelKey);
		if (state) {
			state.requestsOnActiveAccount++;
			this.saveState();
		}
	}

	private shouldRotateBeforeRequest(account: AccountRuntime, modelKey: string, state: ModelRotationState | null): boolean {
		return (
			!!state &&
			this.shouldUseRequestCountRotation(account, modelKey) &&
			state.requestsOnActiveAccount >= this.config.requestsPerRotation
		);
	}

	private async rotateModelForRequest(modelKey: string, now: number = Date.now(), excludeIdx?: number): Promise<AccountRuntime | null> {
		const account = await this.rotateModel(modelKey, now, excludeIdx);
		if (account) {
			this.countModelAssignment(modelKey);
		}
		return account;
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
		if (current && (!modelKey ? this.isAvailable(current, now) : this.isAvailableForModel(current, modelKey, now))) {
			// Check if this account has quota for the requested model
			if (modelKey) {
				if (this.shouldRotateBeforeRequest(current, modelKey, state ?? null)) {
					this.log(
						`${current.config.label || current.config.email} [${modelKey}]: hit rotation threshold (${this.config.requestsPerRotation})`,
					);
					const rotated = await this.rotateModelForRequest(modelKey, now, idx);
					if (rotated) {
						current.requestsSinceRotation = 0;
						return rotated;
					}
					this.log(
						`${current.config.label || current.config.email} [${modelKey}]: threshold reached but no replacement is available, staying on current account`,
						"warn",
					);
				}
				const quota = this.getModelQuota(current, modelKey);
				if (quota === 0) {
					this.log(
						`${current.config.label || current.config.email} [${modelKey}]: 0% quota, skipping`,
					);
					return this.rotateModelForRequest(modelKey);
				}
				if (!this.isFreshWindowAllowed(current, modelKey)) {
					const label = current.config.label || current.config.email;
					this.log(
						this.hasTimedCandidate(modelKey, now, idx)
							? `${label} [${modelKey}]: skipping fresh window because fresh starts are disabled and timed buckets are available`
							: `${label} [${modelKey}]: fresh window blocked by operator toggle`,
						"warn",
					);
					return this.rotateModelForRequest(modelKey);
				}
			}
			this.startRequest(current, modelKey ?? undefined);
			try {
				await this.ensureValidToken(current);
				if (modelKey) this.countModelAssignment(modelKey);
				return current;
			} catch (err) {
				this.finishRequest(current, modelKey ?? undefined);
				throw err;
			}
		}

		// Current unavailable, or no per-model assignment yet
		if (modelKey) {
			return this.rotateModelForRequest(modelKey, now, state ? idx : -1);
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
				requestsOnActiveAccount: 0,
			});
			this.log(
				`[${modelKey}] Rotated to ${best.config.label || best.config.email} [${timerType}] (quota: ${quota >= 0 ? quota + "%" : "unknown"})`,
			);
			this.saveState();
			this.startRequest(best, modelKey);
			try {
				await this.ensureValidToken(best);
				return best;
			} catch (err) {
				this.finishRequest(best, modelKey);
				throw err;
			}
		}

			if (!this.allowFreshWindowStarts && this.accounts.some((account, idx) => {
				if (idx === excludeIdx) return false;
				if (!this.isAvailableForModel(account, modelKey, now)) return false;
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
			if (account.disabled || account.flagged) return bestRemaining;
			const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
			if (defaultCooldown <= now) return bestRemaining;
			const remaining = defaultCooldown - now;
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
			if (account.disabled || account.flagged) return bestRemaining;
			const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
			if (defaultCooldown <= now) return bestRemaining;
			const remaining = defaultCooldown - now;
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

		const modelKey = model ? resolveQuotaModelKey(model) : null;
		const state = modelKey ? this.modelState.get(modelKey) : null;
		const shouldRotate =
			!!modelKey &&
			!!state &&
			this.accounts[state.activeAccountIndex] === account &&
			this.shouldUseRequestCountRotation(account, modelKey) &&
			state.requestsOnActiveAccount >= this.config.requestsPerRotation;

		this.saveState();
		if (shouldRotate) {
			this.log(
				`${account.config.label || account.config.email} [${modelKey}]: hit rotation threshold (${state.requestsOnActiveAccount}/${this.config.requestsPerRotation})`,
			);
		}
		return shouldRotate;
	}

	// Record token usage from a completed request
	recordTokenUsage(model: string | undefined, inputTokens: number, outputTokens: number): void {
		const now = new Date();
		const minuteKey = now.toISOString().slice(0, 16); // "2026-04-28T12:05"
		const modelKey = model ? resolveDisplayModelKey(model) : "unknown";

		// Upsert minute bucket
		let bucket = this.tokenBuckets.minutes.find(b => b.period === minuteKey);
		if (!bucket) {
			bucket = { period: minuteKey, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
			this.tokenBuckets.minutes.push(bucket);
		}
		bucket.inputTokens += inputTokens;
		bucket.outputTokens += outputTokens;
		bucket.requests += 1;
		if (!bucket.byModel[modelKey]) {
			bucket.byModel[modelKey] = { inputTokens: 0, outputTokens: 0, requests: 0 };
		}
		bucket.byModel[modelKey].inputTokens += inputTokens;
		bucket.byModel[modelKey].outputTokens += outputTokens;
		bucket.byModel[modelKey].requests += 1;

		// Lazy consolidation
		this.consolidateTokenBuckets(now);
		this.saveTokenUsage();
	}

	recordLatency(model: string | undefined, ttfbMs: number, totalMs: number): void {
		const modelKey = model ? resolveDisplayModelKey(model) : "unknown";
		let records = this.latencyRecords.get(modelKey);
		if (!records) {
			records = [];
			this.latencyRecords.set(modelKey, records);
		}
		records.push({ ttfbMs, totalMs });
		if (records.length > AccountRotator.MAX_LATENCY_RECORDS) {
			records.splice(0, records.length - AccountRotator.MAX_LATENCY_RECORDS);
		}
	}

	getLatencyStats(): Record<string, { ttfb: { p50: number; p95: number }; total: { p50: number; p95: number }; count: number }> {
		const stats: Record<string, { ttfb: { p50: number; p95: number }; total: { p50: number; p95: number }; count: number }> = {};
		for (const [model, records] of this.latencyRecords) {
			if (records.length === 0) continue;
			const ttfbs = records.map(r => r.ttfbMs).sort((a, b) => a - b);
			const totals = records.map(r => r.totalMs).sort((a, b) => a - b);
			stats[model] = {
				ttfb: { p50: ttfbs[Math.floor(ttfbs.length * 0.5)], p95: ttfbs[Math.floor(ttfbs.length * 0.95)] },
				total: { p50: totals[Math.floor(totals.length * 0.5)], p95: totals[Math.floor(totals.length * 0.95)] },
				count: records.length,
			};
		}
		return stats;
	}

	recordRequestLog(entry: { model: string; account: string; statusCode: number; ttfbMs: number; totalMs: number; inputTokens: number; outputTokens: number }): void {
		this.requestLog.unshift({
			timestamp: Date.now(),
			...entry,
		});
		if (this.requestLog.length > AccountRotator.MAX_REQUEST_LOG) {
			this.requestLog.length = AccountRotator.MAX_REQUEST_LOG;
		}
	}

	private consolidateTokenBuckets(now: Date): void {
		const nowMs = now.getTime();
		const KEEP_MINUTES_MS = 12 * 3600 * 1000; // keep 12h of minutes
		const KEEP_HOURS_MS = 60 * 86400 * 1000;  // keep 60d of hours
		const KEEP_DAYS_MS = 60 * 86400 * 1000;   // keep 60d of days

		// Helper: parse period string to epoch ms (approximate, enough for cutoff)
		const periodToMs = (p: string): number => new Date(p.length <= 7 ? p + "-01" : p).getTime();

		// Minutes older than 2h → consolidate into hours, keep rest
		const minuteCutoff = nowMs - KEEP_MINUTES_MS;
		const staleMinutes = this.tokenBuckets.minutes.filter(b => periodToMs(b.period) < minuteCutoff);
		if (staleMinutes.length > 0) {
			const byHour = new Map<string, TokenBucket>();
			for (const m of staleMinutes) {
				const hKey = m.period.slice(0, 13);
				let h = byHour.get(hKey);
				if (!h) {
					h = { period: hKey, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
					byHour.set(hKey, h);
				}
				this.mergeBucket(h, m);
			}
			for (const [hKey, consolidated] of byHour) {
				const existing = this.tokenBuckets.hours.find(b => b.period === hKey);
				if (existing) {
					this.mergeBucket(existing, consolidated);
				} else {
					this.tokenBuckets.hours.push(consolidated);
				}
			}
			this.tokenBuckets.minutes = this.tokenBuckets.minutes.filter(b => periodToMs(b.period) >= minuteCutoff);
		}

		// Hours older than 48h → consolidate into days
		const hourCutoff = nowMs - KEEP_HOURS_MS;
		const staleHours = this.tokenBuckets.hours.filter(b => periodToMs(b.period) < hourCutoff);
		if (staleHours.length > 0) {
			const byDay = new Map<string, TokenBucket>();
			for (const h of staleHours) {
				const dKey = h.period.slice(0, 10);
				let d = byDay.get(dKey);
				if (!d) {
					d = { period: dKey, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
					byDay.set(dKey, d);
				}
				this.mergeBucket(d, h);
			}
			for (const [dKey, consolidated] of byDay) {
				const existing = this.tokenBuckets.days.find(b => b.period === dKey);
				if (existing) {
					this.mergeBucket(existing, consolidated);
				} else {
					this.tokenBuckets.days.push(consolidated);
				}
			}
			this.tokenBuckets.hours = this.tokenBuckets.hours.filter(b => periodToMs(b.period) >= hourCutoff);
		}

		// Days older than 60d → consolidate into months
		const dayCutoff = nowMs - KEEP_DAYS_MS;
		const staleDays = this.tokenBuckets.days.filter(b => periodToMs(b.period) < dayCutoff);
		if (staleDays.length > 0) {
			const byMonth = new Map<string, TokenBucket>();
			for (const d of staleDays) {
				const mKey = d.period.slice(0, 7);
				let mo = byMonth.get(mKey);
				if (!mo) {
					mo = { period: mKey, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
					byMonth.set(mKey, mo);
				}
				this.mergeBucket(mo, d);
			}
			for (const [mKey, consolidated] of byMonth) {
				const existing = this.tokenBuckets.months.find(b => b.period === mKey);
				if (existing) {
					this.mergeBucket(existing, consolidated);
				} else {
					this.tokenBuckets.months.push(consolidated);
				}
			}
			this.tokenBuckets.days = this.tokenBuckets.days.filter(b => periodToMs(b.period) >= dayCutoff);
		}
	}

	private mergeBucket(target: TokenBucket, source: TokenBucket): void {
		target.inputTokens += source.inputTokens;
		target.outputTokens += source.outputTokens;
		target.requests += source.requests;
		for (const [model, data] of Object.entries(source.byModel)) {
			if (!target.byModel[model]) {
				target.byModel[model] = { inputTokens: 0, outputTokens: 0, requests: 0 };
			}
			target.byModel[model].inputTokens += data.inputTokens;
			target.byModel[model].outputTokens += data.outputTokens;
			target.byModel[model].requests += data.requests;
		}
	}

	private saveTokenUsage(): void {
		try {
			writeFileSync(TOKENS_FILE, JSON.stringify(this.tokenBuckets, null, 2), "utf-8");
		} catch { /* best effort */ }
	}

	getTokenUsage(): TokenUsageData {
		const all = [...this.tokenBuckets.minutes, ...this.tokenBuckets.hours, ...this.tokenBuckets.days, ...this.tokenBuckets.months];
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalRequests = 0;
		const modelTotals: Record<string, { input: number; output: number }> = {};
		for (const b of all) {
			totalInputTokens += b.inputTokens;
			totalOutputTokens += b.outputTokens;
			totalRequests += b.requests;
			for (const [model, data] of Object.entries(b.byModel)) {
				if (!modelTotals[model]) modelTotals[model] = { input: 0, output: 0 };
				modelTotals[model].input += data.inputTokens;
				modelTotals[model].output += data.outputTokens;
			}
		}

		// Calculate savings
		let totalUsd = 0;
		const byModel: TokenUsageData["savings"]["byModel"] = {};
		for (const [model, totals] of Object.entries(modelTotals)) {
			const pricing = MODEL_PRICING[model];
			if (!pricing) continue;
			const inputUsd = (totals.input / 1_000_000) * pricing.inputPer1M;
			const outputUsd = (totals.output / 1_000_000) * pricing.outputPer1M;
			byModel[model] = { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
			totalUsd += inputUsd + outputUsd;
		}

		return {
			minutes: this.tokenBuckets.minutes.slice().sort((a, b) => a.period.localeCompare(b.period)),
			hours: this.tokenBuckets.hours.slice().sort((a, b) => a.period.localeCompare(b.period)),
			days: this.tokenBuckets.days.slice().sort((a, b) => a.period.localeCompare(b.period)),
			months: this.tokenBuckets.months.slice().sort((a, b) => a.period.localeCompare(b.period)),
			totalInputTokens,
			totalOutputTokens,
			totalRequests,
			savings: { totalUsd, byModel },
		};
	}

	// Mark an account as exhausted (429 or quota exceeded)
	markExhausted(account: AccountRuntime, model: string | undefined, cooldownMs: number): void {
		const now = Date.now();
		const modelKey = model ? (resolveQuotaModelKey(model) ?? "__default__") : "__default__";
		account.cooldownsByModel[modelKey] = now + cooldownMs;
		account.quotaExhaustedAt = now;

			this.log(
				`${account.config.label || account.config.email} [${modelKey}]: EXHAUSTED, cooldown ${Math.ceil(cooldownMs / 1000)}s`,
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
		account.cooldownsByModel = {};
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

	clearInFlightRequests(email: string, modelKey?: string): boolean {
		const account = this.accounts.find((a) => a.config.email === email);
		if (!account) return false;
		if (modelKey) {
			const previous = account.inFlightByModel[modelKey] ?? 0;
			account.inFlightByModel[modelKey] = 0;
			this.recalculateInFlightRequests(account);
			this.log(`${email}: operator cleared ${previous} in-flight request(s) for ${modelKey}`, "warn");
			return true;
		}
		const previous = account.inFlightRequests;
		account.inFlightRequests = 0;
		account.inFlightByModel = {};
		this.log(`${email}: operator cleared ${previous} in-flight request(s)`, "warn");
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
			const response = await fetchWithRetry(TOKEN_URL, {
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
		const defaultCooldown = account.cooldownsByModel["__default__"] ?? 0;
		if (defaultCooldown > now) return false;
		return true;
	}

	private isAvailableForModel(account: AccountRuntime, modelKey: string, now: number): boolean {
		if (!this.isAvailable(account, now)) return false;
		const modelCooldown = account.cooldownsByModel[modelKey] ?? 0;
		if (modelCooldown > now) return false;
		if ((account.inFlightByModel[modelKey] ?? 0) >= (this.config.maxConcurrentRequestsPerAccount ?? 1)) return false;
		return true;
	}

	// Mark an account as flagged for infringement/abuse. Immediately excluded from rotation.
	markFlagged(account: AccountRuntime, reason: string): void {
			account.flagged = true;
			account.lastError = reason;
			account.inFlightRequests = 0;
			account.inFlightByModel = {};
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

	startRequest(account: AccountRuntime, modelKey?: string): void {
		const key = modelKey ?? "__default__";
		account.inFlightByModel[key] = (account.inFlightByModel[key] ?? 0) + 1;
		this.recalculateInFlightRequests(account);
	}

	finishRequest(account: AccountRuntime, modelKey?: string): void {
		const key = modelKey ?? "__default__";
		account.inFlightByModel[key] = Math.max(0, (account.inFlightByModel[key] ?? 0) - 1);
		if (account.inFlightByModel[key] === 0) delete account.inFlightByModel[key];
		this.recalculateInFlightRequests(account);
	}

	private recalculateInFlightRequests(account: AccountRuntime): void {
		account.inFlightRequests = Object.values(account.inFlightByModel).reduce((sum, count) => sum + count, 0);
	}

	private isRoutableForModel(account: AccountRuntime, modelKey: string, now: number): boolean {
		if (!this.isAvailableForModel(account, modelKey, now)) return false;
		if (this.getModelQuota(account, modelKey) === 0) return false;
		if (!this.isFreshWindowAllowed(account, modelKey)) return false;
		return true;
	}

	getStatus(): StatusResponse {
		const now = Date.now();

		// Build per-model active account map from accounts that can actually serve now.
		const activeAccounts: Record<string, string> = {};
		for (const [model, mState] of this.modelState.entries()) {
			const account = this.accounts[mState.activeAccountIndex];
			if (account && this.isRoutableForModel(account, model, now)) {
				activeAccounts[model] = account.config.email;
			}
		}

		const accounts: AccountStatus[] = this.accounts.map((a) => {
			// Determine which models this account is active for
			const activeForModels: string[] = [];
			for (const [model, mState] of this.modelState.entries()) {
				if (this.accounts[mState.activeAccountIndex] === a && this.isRoutableForModel(a, model, now)) {
					activeForModels.push(model);
				}
			}

			let status: AccountStatus["status"];
			const inCooldownModels = Object.entries(a.cooldownsByModel).filter(([_, ts]) => ts > now);
			const allModelsInCooldown = inCooldownModels.length > 0 && inCooldownModels.length >= Object.keys(a.cooldownsByModel).length; // rough heuristic
			
			if (a.flagged) {
				status = "flagged";
			} else if (a.disabled) {
				status = "disabled";
			} else if (a.consecutiveErrors > 0 && !a.disabled) {
				status = "error";
			} else if (inCooldownModels.length > 0) {
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
				cooldownsByModel: a.cooldownsByModel,
				lastUsed: a.lastUsed,
				lastError: a.lastError,
					consecutiveErrors: a.consecutiveErrors,
					hasValidToken: !!(a.accessToken && a.tokenExpires > now),
					quota: a.quota,
					inFlightRequests: a.inFlightRequests,
					inFlightByModel: a.inFlightByModel,
					proDetected: this.isProAccount(a),
					quotaWindows: a.quotaWindows,
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
			requestLog: this.requestLog.slice(0, 100),
			tokenUsage: this.getTokenUsage(),
			latencyStats: this.getLatencyStats(),
		};
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	/**
	 * Get contextual data for telemetry flag reporting.
	 * Returns anonymous pool state — no emails or PII.
	 */
	getFlagContext(account: AccountRuntime, modelKey: string): {
		wasProAccount: boolean;
		accountQuotaPercent: number;
		timerType: string;
		poolSize: number;
		poolHealthyCount: number;
		protectivePauseTriggered: boolean;
		accountRequestsLastHour: number;
		uptimeSeconds: number;
	} {
		const now = Date.now();
		const quota = this.getModelQuota(account, modelKey);
		const timerType = this.getModelTimerType(account, modelKey);
		const healthyCount = this.accounts.filter(a =>
			!a.disabled && !a.flagged && this.isAvailable(a, now),
		).length;

		// Count requests in the last hour from request log
		const oneHourAgo = now - 3600_000;
		const label = account.config.label || account.config.email;
		const requestsLastHour = this.requestLog.filter(e =>
			e.timestamp >= oneHourAgo && e.account === label,
		).length;

		return {
			wasProAccount: this.isProAccount(account),
			accountQuotaPercent: quota,
			timerType,
			poolSize: this.accounts.length,
			poolHealthyCount: healthyCount,
			protectivePauseTriggered: this.protectivePauseUntil > now,
			accountRequestsLastHour: requestsLastHour,
			uptimeSeconds: Math.round((now - this.startTime) / 1000),
		};
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
				cooldownsByModel: {},
				quotaExhaustedAt: 0,
				quota: [],
				lastQuotaPoll: 0,
				lastUsed: 0,
				lastError: null,
				consecutiveErrors: 0,
				disabled: false,
					flagged: false,
					inFlightRequests: 0,
					inFlightByModel: {},
				allowFreshWindowStartsOverride: false,
					quotaWindows: {},
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
		rotatorLogger.log(level, msg);
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

	public getAccountByEmail(email: string): AccountRuntime | undefined {
		return this.accounts.find((a) => a.config.email === email);
	}

	// =========================================================================
	// Pro Family Sharing Advisor
	// =========================================================================

	// Model keys relevant for Pro advisor decisions (ignore Flash)
	private static PRO_ADVISOR_MODELS = ["gemini-3.1-pro", "claude-opus-4-6-thinking"];

	/**
	 * Check if a model's current 7d timer is the Pro cooldown (not Free).
	 * Uses the dual-window tracker: compares current resetTime against recorded Pro resetTime.
	 */
	private isProOriginatedTimer(account: AccountRuntime, modelKey: string): boolean {
		const tracker = account.quotaWindows[modelKey];
		if (!tracker || tracker.pro.lastSeen === 0) return false;
		
		const currentQuota = account.quota.find(
			(q) => q.modelKey.includes(modelKey) || modelKey.includes(q.modelKey),
		);
		if (!currentQuota || currentQuota.timerType !== "7d") return false;
		
		const currentResetMs = currentQuota.resetTime ? new Date(currentQuota.resetTime).getTime() : 0;
		if (tracker.pro.resetTimeMs === 0 || currentResetMs === 0) return false;

		// Tight 5-min tolerance against permanent anchor
		return Math.abs(currentResetMs - tracker.pro.resetTimeMs) < 300000;
	}

	/**
	 * An account is currently considered "Pro" if, during the very last quota poll,
	 * its advisor models were tracked in the PRO bucket of the dual-window tracker.
	 */
	private isProAccount(account: AccountRuntime): boolean {
		if (account.lastQuotaPoll === 0) return false;
		
		for (const m of AccountRotator.PRO_ADVISOR_MODELS) {
			const tracker = account.quotaWindows[m];
			if (!tracker) continue;
			// If the Pro window was updated exactly during the last poll, it's Pro.
			// Give a tiny 1s margin for JS execution timing.
			if (tracker.pro.lastSeen > 0 && Math.abs(tracker.pro.lastSeen - account.lastQuotaPoll) < 1000) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get the "other" window's quota info for an account/model.
	 * If currently showing Pro timer → returns Free window data (and vice versa).
	 */
	private getAlternateWindow(account: AccountRuntime, modelKey: string): { type: "pro" | "free"; quota: number; resetTimeMs: number; resetTime: string | null } | null {
		const tracker = account.quotaWindows[modelKey];
		if (!tracker) return null;
		const currentQuota = account.quota.find(
			(q) => q.modelKey.includes(modelKey) || modelKey.includes(q.modelKey),
		);
		if (!currentQuota) return null;

		if (this.isProOriginatedTimer(account, modelKey) || currentQuota.timerType === "5h") {
			// Currently on Pro — return Free window
			if (tracker.free.lastSeen === 0) return null;
			return { type: "free", quota: tracker.free.lastQuota, resetTimeMs: tracker.free.resetTimeMs, resetTime: tracker.free.resetTime };
		} else {
			// Currently on Free — return Pro window
			if (tracker.pro.lastSeen === 0) return null;
			return { type: "pro", quota: tracker.pro.lastQuota, resetTimeMs: tracker.pro.resetTimeMs, resetTime: tracker.pro.resetTime };
		}
	}

	private getProAdvisor(): StatusResponse["proAdvisor"] {
		const maxSlots = this.config.proSlots ?? 6;
		const proAccounts = this.accounts.filter((a) => !a.disabled && !a.flagged && this.isProAccount(a));
		const currentProCount = proAccounts.length;
		const actions: ProAdvisorAction[] = [];

		// Comparative Quota Analysis Logic (Cumulative Score)
		for (const account of this.accounts) {
			if (account.disabled || account.flagged) continue;

			let totalProScore = 0;
			let totalFreeScore = 0;
			let hasAnyProData = false;
			let hasAnyFreeData = false;

			for (const modelKey of AccountRotator.PRO_ADVISOR_MODELS) {
				const tracker = account.quotaWindows[modelKey];
				if (!tracker) continue;
				if (tracker.pro.lastSeen > 0) {
					totalProScore += Math.max(0, tracker.pro.lastQuota);
					hasAnyProData = true;
				}
				if (tracker.free.lastSeen > 0) {
					totalFreeScore += Math.max(0, tracker.free.lastQuota);
					hasAnyFreeData = true;
				}
			}

			// If a tier has no data at all, its score is effectively 0
			const effectivePro = hasAnyProData ? totalProScore : 0;
			const effectiveFree = hasAnyFreeData ? totalFreeScore : 0;

			const isCurrentlyPro = this.isProAccount(account);

			if (isCurrentlyPro) {
				// Account is currently in PRO tier
				if (account.config.familyManager) continue; // Never remove FM

				if (effectiveFree > effectivePro) {
					actions.push({
						type: "remove-pro",
						email: account.config.email,
						label: account.config.label || account.config.email,
						reason: `Free tier has significantly more combined quota (${effectiveFree}%) than Pro tier (${effectivePro}%). Downgrade to use Free tokens.`,
					});
				} else if (effectivePro === 0 && effectiveFree === 0) {
					actions.push({
						type: "remove-pro",
						email: account.config.email,
						label: account.config.label || account.config.email,
						reason: `All quota exhausted (0%). Safe to remove from Pro family to free up a slot.`,
					});
				}
			} else {
				// Account is currently in FREE tier
				if (effectivePro > effectiveFree) {
					actions.push({
						type: "add-pro",
						email: account.config.email,
						label: account.config.label || account.config.email,
						reason: `Pro tier has significantly more combined quota (${effectivePro}%) than Free tier (${effectiveFree}%). Upgrade to use Pro tokens.`,
						_diff: effectivePro - effectiveFree, // temporary property for sorting
					} as ProAdvisorAction & { _diff: number });
				}
			}
		}

		// Sort add-pro actions by highest Pro quota difference
		actions.sort((a, b) => {
			if (a.type === "add-pro" && b.type === "add-pro") {
				return ((b as any)._diff || 0) - ((a as any)._diff || 0);
			}
			return 0;
		});

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
			.flatMap((a) => Object.values(a.cooldownsByModel).map(ts => Math.max(0, ts - now)))
			.filter((rem) => rem > 0)
			.reduce((best, rem) => (best === 0 || rem < best ? rem : best), 0);
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
