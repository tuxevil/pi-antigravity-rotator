// Account rotation and token management with real quota polling

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	type AccountRuntime,
	type AccountStatus,
	type Config,
	type GoogleQuotaResponse,
	type ModelQuota,
	type PersistedState,
	type StatusResponse,
	CLIENT_ID,
	CLIENT_SECRET,
	TOKEN_URL,
	LONG_TIMER_MS,
	QUOTA_API_URL,
	QUOTA_USER_AGENT,
	QUOTA_MODEL_KEYS,
} from "./types.js";

const STATE_FILE = join(dirname(new URL(import.meta.url).pathname), "..", "state.json");

export class AccountRotator {
	private accounts: AccountRuntime[] = [];
	private currentIndex = 0;
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
			shortTimerResetAt: 0,
			longTimerResetAt: 0,
			quotaExhaustedAt: 0,
			quota: [],
			lastQuotaPoll: 0,
			quotaAtRotationStart: -1,
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
			this.currentIndex = Math.min(state.currentIndex, this.accounts.length - 1);
			for (const account of this.accounts) {
				const saved = state.accounts[account.config.email];
				if (saved) {
					account.totalRequests = saved.totalRequests;
					account.cooldownUntil = saved.cooldownUntil;
					account.shortTimerResetAt = saved.shortTimerResetAt;
					account.longTimerResetAt = saved.longTimerResetAt;
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
		const state: PersistedState = {
			currentIndex: this.currentIndex,
			accounts: {},
		};
		for (const account of this.accounts) {
			state.accounts[account.config.email] = {
				totalRequests: account.totalRequests,
				cooldownUntil: account.cooldownUntil,
				shortTimerResetAt: account.shortTimerResetAt,
				longTimerResetAt: account.longTimerResetAt,
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
		const intervalMs = this.config.quotaPollIntervalMs || 30_000;
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

		// Check if current account needs quota-based rotation
		const current = this.accounts[this.currentIndex];
		if (current && this.config.rotateOnQuotaDrop > 0) {
			const minQuota = this.getMinQuotaPercent(current);
			if (current.quotaAtRotationStart < 0 && minQuota >= 0) {
				// First quota reading for this rotation period
				current.quotaAtRotationStart = minQuota;
				this.log(
					`${current.config.label || current.config.email}: baseline quota ${minQuota}%`,
				);
			} else if (current.quotaAtRotationStart >= 0 && minQuota >= 0) {
				const drop = current.quotaAtRotationStart - minQuota;
				if (drop >= this.config.rotateOnQuotaDrop) {
					this.log(
						`${current.config.label || current.config.email}: quota dropped ${drop}% (${current.quotaAtRotationStart}% -> ${minQuota}%), rotating`,
					);
					await this.rotateToNext();
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
				return; // Silently skip on error
			}

			const data = (await response.json()) as GoogleQuotaResponse;
			account.quota = this.extractQuotas(data);
			account.lastQuotaPoll = Date.now();

			// Update quota timers from reset times
			for (const q of account.quota) {
				if (q.resetTime) {
					const resetMs = new Date(q.resetTime).getTime();
					if (resetMs > Date.now()) {
						// Detect short vs long timer based on duration
						const durationMs = resetMs - Date.now();
						if (durationMs < 6 * 60 * 60 * 1000) {
							// Under 6h -> short timer (pro)
							account.shortTimerResetAt = resetMs;
						} else {
							account.longTimerResetAt = resetMs;
						}
					}
				}
			}
		} catch {
			// Network error, skip
		}
	}

	private extractQuotas(data: GoogleQuotaResponse): ModelQuota[] {
		const quotas: ModelQuota[] = [];

		for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
			// Try primary key
			let modelInfo = data.models[config.key];

			// Try alternate keys
			if (!modelInfo) {
				for (const altKey of config.altKeys) {
					modelInfo = data.models[altKey];
					if (modelInfo) break;
				}
			}

			if (modelInfo?.quotaInfo) {
				quotas.push({
					modelKey: config.key,
					displayName: config.display,
					percentRemaining: Math.round((modelInfo.quotaInfo.remainingFraction ?? 0) * 100),
					resetTime: modelInfo.quotaInfo.resetTime ?? null,
				});
			}
		}

		return quotas;
	}

	private getMinQuotaPercent(account: AccountRuntime): number {
		if (account.quota.length === 0) return -1;
		return Math.min(...account.quota.map((q) => q.percentRemaining));
	}

	// =========================================================================
	// Account Selection
	// =========================================================================

	// Select the best account for the next request.
	async getActiveAccount(): Promise<AccountRuntime | null> {
		const now = Date.now();
		const total = this.accounts.length;
		if (total === 0) return null;

		const current = this.accounts[this.currentIndex];
		if (current && this.isAvailable(current, now)) {
			await this.ensureValidToken(current);
			return current;
		}

		return this.rotateToNext(now);
	}

	// Timer priority for account selection:
	//   1 (highest) = no active timers -> start the 7d clock ASAP so it resets sooner
	//   2           = on 7d timer only -> already ticking, use it
	//   3 (lowest)  = on 5h timer (pro) -> short-lived, save for last (wasted if not fully consumed)
	private getTimerPriority(account: AccountRuntime, now: number): number {
		const has5h = account.shortTimerResetAt > now;
		const has7d = account.longTimerResetAt > now;

		if (has5h) return 3; // Pro account on short timer - use last
		if (has7d) return 2; // Already on 7d timer - use it
		return 1; // Fresh account - start 7d clock ASAP
	}

	// Force rotation to the best available account.
	// Priority: fresh (no timers) > 7d timer > 5h timer.
	// Within the same priority tier, prefer higher remaining quota.
	async rotateToNext(now: number = Date.now()): Promise<AccountRuntime | null> {
		const total = this.accounts.length;
		let best: AccountRuntime | null = null;
		let bestPriority = Infinity;
		let bestQuota = -2; // -1 means "unknown", so -2 is worse than unknown

		let bestExhausted: AccountRuntime | null = null;
		let bestExhaustedCooldown = Infinity;

		for (let i = 0; i < total; i++) {
			// Skip current account (we're rotating away from it)
			if (i === this.currentIndex) continue;

			const account = this.accounts[i];
			if (this.isAvailable(account, now)) {
				const priority = this.getTimerPriority(account, now);
				const quota = this.getMinQuotaPercent(account);

				// Pick by: best priority first, then highest quota within same priority
				if (
					priority < bestPriority ||
					(priority === bestPriority && quota > bestQuota)
				) {
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
			this.currentIndex = this.accounts.indexOf(best);
			best.requestsSinceRotation = 0;
			best.quotaAtRotationStart = this.getMinQuotaPercent(best);
			const priorityLabel = bestPriority === 1 ? "fresh" : bestPriority === 2 ? "7d-timer" : "5h-timer";
			this.log(
				`Rotated to ${best.config.label || best.config.email} [${priorityLabel}] (quota: ${best.quotaAtRotationStart >= 0 ? best.quotaAtRotationStart + "%" : "unknown"})`,
			);
			this.saveState();
			await this.ensureValidToken(best);
			return best;
		}

		if (bestExhausted) {
			this.currentIndex = this.accounts.indexOf(bestExhausted);
			this.log(
				`All accounts exhausted. Using ${bestExhausted.config.email} (cooldown: ${Math.ceil(bestExhaustedCooldown / 1000)}s)`,
			);
			await this.ensureValidToken(bestExhausted);
			return bestExhausted;
		}

		this.log("All accounts disabled or unavailable");
		return null;
	}

	// Record a successful request. Returns true if rotation is needed.
	recordRequest(account: AccountRuntime): boolean {
		account.requestsSinceRotation++;
		account.totalRequests++;
		account.lastUsed = Date.now();
		account.consecutiveErrors = 0;
		account.lastError = null;

		// Request-count based rotation (fallback when quota polling is not active)
		const shouldRotate = account.requestsSinceRotation >= this.config.requestsPerRotation;
		if (shouldRotate) {
			this.log(
				`${account.config.label || account.config.email}: hit rotation threshold (${account.requestsSinceRotation}/${this.config.requestsPerRotation})`,
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

		// Set fallback timer estimates if the quota API hasn't provided real data.
		// Real reset times are overwritten by quota polling.
		if (account.longTimerResetAt < now) {
			account.longTimerResetAt = now + LONG_TIMER_MS;
		}

		this.log(
			`${account.config.label || account.config.email}: EXHAUSTED, cooldown ${Math.ceil(cooldownMs / 1000)}s`,
		);
		this.saveState();
	}

	// Mark an account as having an error (non-quota)
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
		const currentAccount = this.accounts[this.currentIndex];

		const accounts: AccountStatus[] = this.accounts.map((a) => {
			let status: AccountStatus["status"];
			if (a.disabled) {
				status = "disabled";
			} else if (a.consecutiveErrors > 0 && !a.disabled) {
				status = "error";
			} else if (a.cooldownUntil > now) {
				status = "cooldown";
			} else if (a === currentAccount) {
				status = "active";
			} else {
				status = "ready";
			}

			const minQuota = this.getMinQuotaPercent(a);

			return {
				email: a.config.email,
				label: a.config.label || a.config.email,
				type: a.config.type || "free",
				status,
				requestsSinceRotation: a.requestsSinceRotation,
				totalRequests: a.totalRequests,
				cooldownUntil: a.cooldownUntil,
				cooldownRemaining: Math.max(0, a.cooldownUntil - now),
				shortTimerResetAt: a.shortTimerResetAt,
				longTimerResetAt: a.longTimerResetAt,
				lastUsed: a.lastUsed,
				lastError: a.lastError,
				consecutiveErrors: a.consecutiveErrors,
				hasValidToken: !!(a.accessToken && a.tokenExpires > now),
				quota: a.quota,
				minQuotaPercent: minQuota,
				timerPriority: this.getTimerPriority(a, now),
			};
		});

		return {
			proxyPort: this.config.proxyPort,
			requestsPerRotation: this.config.requestsPerRotation,
			activeAccount: currentAccount?.config.email || null,
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
