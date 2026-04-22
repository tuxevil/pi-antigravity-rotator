// Account types and configuration

export type AccountType = "pro" | "free";

export interface AccountConfig {
	email: string;
	refreshToken: string;
	projectId: string;
	label?: string;
	type: AccountType;
}

export interface Config {
	accounts: AccountConfig[];
	requestsPerRotation: number;
	proxyPort: number;
	// Rotate when any model's quota drops by this many percentage points (0 = disabled, use request count)
	rotateOnQuotaDrop: number;
	// How often to poll quota (ms). Default: 30s
	quotaPollIntervalMs: number;
}

// Quota API response from Google
export interface GoogleQuotaResponse {
	models: Record<
		string,
		{
			quotaInfo?: {
				remainingFraction?: number;
				resetTime?: string;
			};
		}
	>;
}

// Per-model quota info for an account
export interface ModelQuota {
	modelKey: string;
	displayName: string;
	percentRemaining: number;
	resetTime: string | null;
}

// Model key mapping for the quota API
export const QUOTA_MODEL_KEYS: Record<string, { key: string; altKeys: string[]; display: string }> = {
	"gemini-3.1-pro": {
		key: "gemini-3.1-pro",
		altKeys: ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3-pro-high", "gemini-3-pro-low"],
		display: "G3Pro",
	},
	"gemini-3-flash": {
		key: "gemini-3-flash",
		altKeys: [],
		display: "G3Flash",
	},
	claude: {
		key: "claude-opus-4-6-thinking",
		altKeys: ["claude-opus-4-5-thinking", "claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
		display: "Claude",
	},
};

// Runtime state for a single account
export interface AccountRuntime {
	config: AccountConfig;
	accessToken: string | null;
	tokenExpires: number;
	// Rotation tracking
	requestsSinceRotation: number;
	totalRequests: number;
	// Cooldown / exhaustion
	cooldownUntil: number;
	// Pro accounts: 5-hour short timer, then 7-day long timer
	// Free accounts: 7-day timer only
	shortTimerResetAt: number; // pro only: 5h timer reset
	longTimerResetAt: number; // both: 7-day timer reset
	quotaExhaustedAt: number; // when the account was last exhausted
	// Quota tracking (from API)
	quota: ModelQuota[];
	lastQuotaPoll: number;
	quotaAtRotationStart: number; // min quota % when this account became active
	// Status
	lastUsed: number;
	lastError: string | null;
	consecutiveErrors: number;
	disabled: boolean; // permanently disabled (revoked token, etc.)
}

// Persisted state across restarts
export interface PersistedState {
	currentIndex: number;
	accounts: Record<
		string,
		{
			totalRequests: number;
			cooldownUntil: number;
			shortTimerResetAt: number;
			longTimerResetAt: number;
			quotaExhaustedAt: number;
			disabled: boolean;
		}
	>;
}

// Dashboard API response
export interface StatusResponse {
	proxyPort: number;
	requestsPerRotation: number;
	activeAccount: string | null;
	totalRequestsAllAccounts: number;
	uptime: number;
	accounts: AccountStatus[];
}

export interface AccountStatus {
	email: string;
	label: string;
	type: AccountType;
	status: "active" | "ready" | "cooldown" | "exhausted" | "disabled" | "error";
	requestsSinceRotation: number;
	totalRequests: number;
	cooldownUntil: number;
	cooldownRemaining: number;
	shortTimerResetAt: number;
	longTimerResetAt: number;
	lastUsed: number;
	lastError: string | null;
	consecutiveErrors: number;
	hasValidToken: boolean;
	quota: ModelQuota[];
	minQuotaPercent: number;
	// 1 = fresh (no timers), 2 = on 7d timer, 3 = on 5h timer
	timerPriority: number;
}

// Antigravity OAuth constants (same as pi-mono)
export const CLIENT_ID = atob(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
export const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

export const QUOTA_API_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const QUOTA_USER_AGENT = "antigravity/1.11.9 darwin/arm64";

export const PRO_SHORT_TIMER_MS = 5 * 60 * 60 * 1000; // 5 hours
export const LONG_TIMER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
