// Account types and configuration

export type AccountType = "pro" | "free";

export interface AccountConfig {
	email: string;
	refreshToken: string;
	projectId: string;
	label?: string;
	// Optional - pro/free is detected dynamically from quota API reset times
	type?: AccountType;
}

export interface Config {
	accounts: AccountConfig[];
	requestsPerRotation: number;
	proxyPort: number;
	// Rotate when a model's quota drops by this many percentage points (0 = disabled, use request count)
	rotateOnQuotaDrop: number;
	// How often to poll quota (ms). Default: 5min
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
	// Timer classification based on resetTime duration
	// "fresh" = no active timer, "5h" = short timer, "7d" = long timer
	timerType: "fresh" | "5h" | "7d";
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

// Map request model names to quota model keys
export function resolveQuotaModelKey(requestModel: string): string | null {
	const lower = requestModel.toLowerCase();
	for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
		if (lower.includes(config.key) || config.altKeys.some((alt) => lower.includes(alt))) {
			return config.key;
		}
	}
	// Broad fallback matching
	if (lower.includes("gemini") && lower.includes("pro")) return "gemini-3.1-pro";
	if (lower.includes("gemini") && lower.includes("flash")) return "gemini-3-flash";
	if (lower.includes("claude")) return "claude-opus-4-6-thinking";
	return null;
}

// Runtime state for a single account
export interface AccountRuntime {
	config: AccountConfig;
	accessToken: string | null;
	tokenExpires: number;
	// Rotation tracking (per-model via rotator)
	requestsSinceRotation: number;
	totalRequests: number;
	// Cooldown / exhaustion
	cooldownUntil: number;
	quotaExhaustedAt: number;
	// Quota tracking (from API) - per-model data
	quota: ModelQuota[];
	lastQuotaPoll: number;
	// Status
	lastUsed: number;
	lastError: string | null;
	consecutiveErrors: number;
	disabled: boolean; // permanently disabled (revoked token, etc.)
	flagged: boolean; // flagged for infringement/abuse by Google
}

// Per-model rotation state tracked by the rotator
export interface ModelRotationState {
	activeAccountIndex: number;
	quotaAtRotationStart: number; // quota % when this account became active for this model
}

// Persisted state across restarts
export interface PersistedState {
	// Per-model active account index
	modelAccounts: Record<string, number>;
	// Legacy fallback
	currentIndex?: number;
	accounts: Record<
		string,
		{
			totalRequests: number;
			cooldownUntil: number;
			quotaExhaustedAt: number;
			disabled: boolean;
			flagged: boolean;
		}
	>;
}

// Dashboard API response
export interface StatusResponse {
	proxyPort: number;
	requestsPerRotation: number;
	totalRequestsAllAccounts: number;
	uptime: number;
	// Per-model active account
	activeAccounts: Record<string, string>;
	accounts: AccountStatus[];
}

export interface AccountStatus {
	email: string;
	label: string;
	status: "active" | "ready" | "cooldown" | "exhausted" | "disabled" | "flagged" | "error";
	// Which models this account is currently active for
	activeForModels: string[];
	requestsSinceRotation: number;
	totalRequests: number;
	cooldownUntil: number;
	cooldownRemaining: number;
	lastUsed: number;
	lastError: string | null;
	consecutiveErrors: number;
	hasValidToken: boolean;
	quota: ModelQuota[];
}

// Antigravity OAuth constants (same as pi-mono)
export const CLIENT_ID = atob(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
export const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
] as const;

export const QUOTA_API_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const QUOTA_USER_AGENT = "antigravity/1.11.9 darwin/arm64";

export const LONG_TIMER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
