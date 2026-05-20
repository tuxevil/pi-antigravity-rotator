// Account types and configuration

export type AccountType = "pro" | "free";
export type AccountTier = "ultra" | "pro" | "free" | "unknown";
export type RoutingPolicy = "timer-first" | "tier-first" | "quota-first" | "hybrid";

export type RoutingRejectionReason =
	| "disabled"
	| "flagged"
	| "account-concurrency"
	| "project-concurrency"
	| "cooldown"
	| "fresh-window-blocked"
	| "quota-zero"
	| "project-breaker"
	| "model-breaker"
	| "daily-account-stop"
	| "daily-project-stop"
	| "token-bucket-empty";

export interface AccountConfig {
	email: string;
	refreshToken: string;
	projectId: string;
	// How the projectId was obtained.
	projectSource?: "google" | "manual";
	label?: string;
	// Optional - pro/free is detected dynamically from quota API reset times
	type?: AccountType;
	tier?: AccountTier;
	familyManager?: boolean;
}

export interface Config {
	accounts: AccountConfig[];
	requestsPerRotation: number;
	proxyPort: number;
	bindHost?: string;
	routingPolicy?: RoutingPolicy;
	// Rotate when a model's quota drops by this many percentage points (0 = disabled, use request count)
	rotateOnQuotaDrop: number;
	// How often to poll quota (ms). Default: 5min
	quotaPollIntervalMs: number;
	// Hard cap on parallel requests per account. Conservative default is 1.
	maxConcurrentRequestsPerAccount?: number;
	// Hard cap on parallel requests per projectId/model. Conservative default is 1.
	maxConcurrentRequestsPerProjectModel?: number;
	// Global delay in ms added to every request to slow down traffic and avoid rate limits.
	globalRequestDelayMs?: number;
	// Pause projectId/model when several accounts hit provider 429 in a short window. Defaults: 3 hits / 10min / 60min pause.
	projectCircuitBreaker429Threshold?: number;
	projectCircuitBreakerWindowMs?: number;
	projectCircuitBreakerCooldownMs?: number;
	// Pause a model globally when several unique accounts hit provider 429 in a short window. Defaults: 3 hits / same window / 6h pause.
	modelCircuitBreaker429Threshold?: number;
	modelCircuitBreakerCooldownMs?: number;
	// Daily safety budgets. Defaults: account slow 250, account stop 350, project slow 900, project stop 1200.
	dailyAccountSlowRequests?: number;
	dailyAccountStopRequests?: number;
	dailyProjectSlowRequests?: number;
	dailyProjectStopRequests?: number;
	// Add small delay before upstream call when an account/project is in slow mode. Default: 8-25s.
	slowModeJitterMinMs?: number;
	slowModeJitterMaxMs?: number;
	// Pause all routing after a serious provider flag. Default: 6h.
	protectivePauseMs?: number;
	// Use request-count rotation only before quota data is available. Default: true.
	useRequestCountRotationWhenQuotaUnknownOnly?: boolean;
	tokenBucketEnabled?: boolean;
	tokenBucketMaxTokens?: number;
	tokenBucketRefillPerMinute?: number;
	tokenBucketInitialTokens?: number;
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
	claude: {
		key: "claude-opus-4-6-thinking",
		altKeys: ["claude-opus-4-5-thinking", "claude-opus-4-5", "claude-sonnet-4-6-thinking", "claude-sonnet-4-6", "claude-sonnet-4-5-thinking", "claude-sonnet-4-5", "gpt-oss-120b-medium", "gpt-oss-120b"],
		display: "Claude",
	},
	"gemini-3.1-pro": {
		key: "gemini-3.1-pro",
		altKeys: ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3-pro-high", "gemini-3-pro-low"],
		display: "G3.1Pro",
	},
	"gemini-3.5-flash": {
		key: "gemini-3.5-flash",
		altKeys: ["gemini-3.5-flash-low", "gemini-3.5-flash-medium", "gemini-3.5-flash-high", "gemini-3-flash-agent", "gemini-3-flash"],
		display: "G3.5Flash",
	},
};

// Map request model names to quota model keys
export function resolveQuotaModelKey(requestModel: string): string | null {
	const lower = requestModel.toLowerCase();
	// Explicit mappings to avoid substring collisions
	if (lower.includes("gemini-3-flash-agent")) return "gemini-3.5-flash";
	if (lower.includes("gpt-oss")) return "claude-opus-4-6-thinking";

	for (const [, config] of Object.entries(QUOTA_MODEL_KEYS)) {
		if (lower.includes(config.key) || config.altKeys.some((alt) => lower.includes(alt))) {
			return config.key;
		}
	}
	// Broad fallback matching
	if (lower.includes("gemini") && lower.includes("3.5") && lower.includes("flash")) return "gemini-3.5-flash";
	if (lower.includes("gemini") && lower.includes("pro")) return "gemini-3.1-pro";
	if (lower.includes("gemini") && lower.includes("flash")) return "gemini-3.5-flash";
	if (lower.includes("claude")) return "claude-opus-4-6-thinking";
	return null;
}

/**
 * Resolves the precise model name for metrics/savings/latency/logs.
 * Unlike resolveQuotaModelKey, this preserves the distinction between:
 * - gemini-3.1-pro-low vs gemini-3.1-pro-high (same quota pool, different display)
 * - claude-sonnet-4-6 vs claude-opus-4-6-thinking (different pricing)
 */
export function resolveDisplayModelKey(requestModel: string): string {
	const lower = requestModel.toLowerCase();
	// Explicit agent and gpt-oss overrides
	if (lower.includes("gemini-3-flash-agent")) return "gemini-3.5-flash-high";
	if (lower.includes("gpt-oss-120b")) return "gpt-oss-120b-medium";

	// Claude — distinguish sonnet vs opus
	if (lower.includes("claude")) {
		if (lower.includes("sonnet")) return "claude-sonnet-4-6";
		if (lower.includes("opus")) return "claude-opus-4-6-thinking";
		return "claude-opus-4-6-thinking"; // fallback
	}
	// Gemini Pro — distinguish low vs high
	if (lower.includes("gemini") && lower.includes("pro")) {
		if (lower.includes("-low")) return "gemini-3.1-pro-low";
		if (lower.includes("-high")) return "gemini-3.1-pro-high";
		return "gemini-3.1-pro"; // unspecified variant
	}
	// Gemini 3.5 Flash — distinguish low vs high
	if (lower.includes("gemini") && lower.includes("3.5") && lower.includes("flash")) {
		if (lower.includes("-low") || lower.includes("-medium")) return "gemini-3.5-flash-low";
		if (lower.includes("-high")) return "gemini-3.5-flash-high";
		return "gemini-3.5-flash"; // unspecified variant
	}
	// Flash
	if (lower.includes("gemini") && lower.includes("flash")) return "gemini-3-flash";
	// Fallback: return as-is cleaned up
	return requestModel;
}

// Runtime state for a single account
export interface AccountRuntime {
	config: AccountConfig;
	accessToken: string | null;
	tokenExpires: number;
	// Rotation tracking (per-model via rotator)
	requestsSinceRotation: number;
	totalRequests: number;
	// Cooldown / exhaustion per-model
	cooldownsByModel: Record<string, number>;
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
	inFlightRequests: number;
	inFlightByModel: Record<string, number>;
	allowFreshWindowStartsOverride: boolean;
	dailyRequestCount: number;
	dailyRequestDay: string;
	healthScore: number;
	tokenBucket: {
		tokens: number;
		lastRefillAt: number;
	};
}

// Per-model rotation state tracked by the rotator
export interface ModelRotationState {
	activeAccountIndex: number;
	quotaAtRotationStart: number; // quota % when this account became active for this model
	requestsOnActiveAccount: number;
}


export interface PersistedSafetyState {
	day: string;
	projectRequests: Record<string, number>;
	projectModelBreakers: Record<string, number>;
	modelBreakers?: Record<string, number>;
	provider429Events: Array<{ ts: number; projectId: string; modelKey: string; account: string }>;
}

export interface PersistedState {
	// Per-model active account index
	modelAccounts: Record<string, number>;
	// Per-model request count on the active account
	modelRequestCounts?: Record<string, number>;
	// Legacy fallback
	currentIndex?: number;
	protectivePauseUntil?: number;
	protectivePauseReason?: string | null;
	allowFreshWindowStarts?: boolean;
	safety?: PersistedSafetyState;
	accounts: Record<
		string,
		{
			totalRequests: number;
			dailyRequestCount?: number;
			dailyRequestDay?: string;
			cooldownUntil?: number; // legacy fallback
			cooldownsByModel?: Record<string, number>;
			quotaExhaustedAt: number;
			disabled: boolean;
			flagged: boolean;
			allowFreshWindowStartsOverride?: boolean;
		}
	>;
}

// Version check info for dashboard
export interface UpdateInfo {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	checkedAt: number;
}

// Admin broadcast notification
export interface AdminNotification {
	id: string;
	type: "info" | "warning" | "critical";
	title: string;
	message: string;
	createdAt: string;
	actionUrl?: string | null;
	actionLabel?: string | null;
}

// Dashboard API response
export interface StatusResponse {
	version: string;
	proxyPort: number;
	requestsPerRotation: number;
	totalRequestsAllAccounts: number;
	uptime: number;
	// Per-model active account
	activeAccounts: Record<string, string>;
	accounts: AccountStatus[];
	protectivePauseUntil: number;
	protectivePauseRemaining: number;
	protectivePauseReason: string | null;
	operatorControls: {
		allowFreshWindowStarts: boolean;
	};
	security: {
		adminTokenConfigured: boolean;
		warning: string | null;
		bindHost: string;
	};
	routingDiagnostics: Record<string, RoutingModelDiagnostics>;
	circuitBreakers: {
		model: Record<string, { until: number; remainingMs: number }>;
		project: Record<string, { until: number; remainingMs: number }>;
	};
	routingHealth: {
		state: "healthy" | "paused" | "cooldown_wait" | "busy" | "stopped";
		reason: string;
		nextRetryIn: number;
		availableCount: number;
		readyCount: number;
		activeCount: number;
		cooldownCount: number;
		busyCount: number;
		flaggedCount: number;
		disabledCount: number;
		errorCount: number;
	};
	recentEvents: RecentEvent[];
	requestLog: RequestLogEntry[];
	tokenUsage: TokenUsageData;
	latencyStats: Record<string, { ttfb: { p50: number; p95: number }; total: { p50: number; p95: number }; count: number }>;
	updateInfo?: UpdateInfo;
	notifications?: AdminNotification[];
}

export interface AccountStatus {
	email: string;
	label: string;
	status: "active" | "ready" | "cooldown" | "exhausted" | "disabled" | "flagged" | "error";
	// Which models this account is currently active for
	activeForModels: string[];
	requestsSinceRotation: number;
	totalRequests: number;
	cooldownsByModel: Record<string, number>;
	lastUsed: number;
	lastError: string | null;
	consecutiveErrors: number;
	hasValidToken: boolean;
	quota: ModelQuota[];
	inFlightRequests: number;
	inFlightByModel: Record<string, number>;
	// Pro family sharing
	proDetected: boolean;
	tier: AccountTier;
	healthScore: number;
	tokenBucket: {
		enabled: boolean;
		tokens: number;
		capacity: number;
		nextRefillInMs: number;
	};
	allowFreshWindowStartsOverride: boolean;
	effectiveFreshWindowStartsAllowed: boolean;
}

export interface RoutingAccountDiagnostic {
	email: string;
	label: string;
	status: AccountStatus["status"];
	score: number | null;
	timerPriority: number | null;
	quota: number | null;
	tier: AccountTier;
	healthScore: number;
	distance: number | null;
	tokenBucket: {
		enabled: boolean;
		tokens: number;
		capacity: number;
		nextRefillInMs: number;
	};
	rejectedReason: RoutingRejectionReason | null;
	rejectedDetail: string | null;
}

export interface RoutingModelDiagnostics {
	modelKey: string;
	policy: RoutingPolicy;
	selectedEmail: string | null;
	reason: string;
	availableCandidates: number;
	rejectedCandidates: number;
	accounts: RoutingAccountDiagnostic[];
}


export interface RecentEvent {
	timestamp: number;
	source: "rotator" | "proxy";
	level: "info" | "warn" | "error";
	message: string;
}

export interface RequestLogEntry {
	timestamp: number;
	model: string;
	account: string;
	statusCode: number;
	ttfbMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
}

// Token usage tracking — tiered time-series
export interface TokenBucket {
	period: string; // key: "2026-04-28T12:05" (min), "2026-04-28T12" (hour), "2026-04-28" (day), "2026-04" (month)
	inputTokens: number;
	outputTokens: number;
	requests: number;
	byModel: Record<string, { inputTokens: number; outputTokens: number; requests: number }>;
}

export interface TokenUsageTiered {
	minutes: TokenBucket[];  // current hour, max 60
	hours: TokenBucket[];    // last 7 days, max 168
	days: TokenBucket[];     // last year, max 365
	months: TokenBucket[];   // historical, unlimited
}

export interface TokenUsageData {
	minutes: TokenBucket[];
	hours: TokenBucket[];
	days: TokenBucket[];
	months: TokenBucket[];
	totalInputTokens: number;
	totalOutputTokens: number;
	totalRequests: number;
	tokensByModel: Record<string, { input: number; output: number; requests: number }>;
	savings: {
		totalUsd: number;
		byModel: Record<string, { inputUsd: number; outputUsd: number; totalUsd: number }>;
	};
}

// Pricing per 1M tokens (USD) — what these would cost on paid APIs
export const MODEL_PRICING: Record<
	string,
	{
		inputPer1M: number;
		outputPer1M: number;
		cachingPer1M?: number;
		cachingStoragePer1MPerHour?: number;
	}
> = {
	"claude-opus-4-6-thinking": { inputPer1M: 5.00, outputPer1M: 25.00 },
	"claude-sonnet-4-6": { inputPer1M: 3.00, outputPer1M: 15.00 },
	"gemini-3.1-pro": { inputPer1M: 2.00, outputPer1M: 12.00 },
	"gemini-3.1-pro-low": { inputPer1M: 2.00, outputPer1M: 12.00 },
	"gemini-3.1-pro-high": { inputPer1M: 2.00, outputPer1M: 12.00 },
	"gemini-3-flash": { inputPer1M: 0.50, outputPer1M: 3.00 },
	"gemini-3.5-flash": { inputPer1M: 1.50, outputPer1M: 9.00, cachingPer1M: 0.15, cachingStoragePer1MPerHour: 1.00 },
	"gemini-3.5-flash-low": { inputPer1M: 1.50, outputPer1M: 9.00, cachingPer1M: 0.15, cachingStoragePer1MPerHour: 1.00 },
	"gemini-3.5-flash-high": { inputPer1M: 1.50, outputPer1M: 9.00, cachingPer1M: 0.15, cachingStoragePer1MPerHour: 1.00 },
	"gpt-oss-120b-medium": { inputPer1M: 2.00, outputPer1M: 10.00 },
};

// Antigravity OAuth constants (same as pi-mono)
export const CLIENT_ID = atob(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
export const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	// "https://cloudcode-pa.googleapis.com",
] as const;

export const QUOTA_API_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_VERSION = process.env.PI_AI_ANTIGRAVITY_VERSION || "1.107.0";
export const QUOTA_USER_AGENT = process.env.PI_ROTATOR_QUOTA_USER_AGENT || `antigravity/${ANTIGRAVITY_VERSION} darwin/arm64`;
export const REQUEST_USER_AGENT = process.env.PI_ROTATOR_REQUEST_USER_AGENT || QUOTA_USER_AGENT;
export const REQUEST_GOOG_API_CLIENT = process.env.PI_ROTATOR_X_GOOG_API_CLIENT || "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const REQUEST_CLIENT_METADATA =
	process.env.PI_ROTATOR_CLIENT_METADATA || JSON.stringify({ ideType: "ANTIGRAVITY", platform: "MACOS", pluginType: "GEMINI" });

export const LONG_TIMER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
