import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAccountsPath } from "./paths.js";
import type { AccountConfig, Config } from "./types.js";
import { backupFile, readJsonFile, writeJsonFileAtomic } from "./storage.js";
import { formatValidationErrors, validateConfig } from "./validators.js";

const ACCOUNTS_FILE = getAccountsPath();
const PI_DIR = join(homedir(), ".pi", "agent");
const PI_MODELS_FILE = join(PI_DIR, "models.json");
const PI_AUTH_FILE = join(PI_DIR, "auth.json");
const TOKEN_USAGE_FILE = join(join(ACCOUNTS_FILE, ".."), "token-usage.json");

export function getTokenUsagePath(): string {
	return TOKEN_USAGE_FILE;
}

export function applyConfigDefaults(config: Config): Config {
	return {
		proxyPort: config.proxyPort || 51200,
		bindHost: config.bindHost || process.env.PI_ROTATOR_BIND_HOST || "0.0.0.0",
		routingPolicy: config.routingPolicy || "timer-first",
		requestsPerRotation: config.requestsPerRotation || 5,
		rotateOnQuotaDrop: config.rotateOnQuotaDrop ?? 20,
		quotaPollIntervalMs: config.quotaPollIntervalMs || 300000,
		maxConcurrentRequestsPerAccount: config.maxConcurrentRequestsPerAccount ?? 1,
		maxConcurrentRequestsPerProjectModel: config.maxConcurrentRequestsPerProjectModel ?? 1,
		projectCircuitBreaker429Threshold: config.projectCircuitBreaker429Threshold ?? 3,
		projectCircuitBreakerWindowMs: config.projectCircuitBreakerWindowMs ?? 10 * 60 * 1000,
		projectCircuitBreakerCooldownMs: config.projectCircuitBreakerCooldownMs ?? 60 * 60 * 1000,
		modelCircuitBreaker429Threshold: config.modelCircuitBreaker429Threshold ?? 3,
		modelCircuitBreakerCooldownMs: config.modelCircuitBreakerCooldownMs ?? 6 * 60 * 60 * 1000,
		dailyAccountSlowRequests: config.dailyAccountSlowRequests ?? 250,
		dailyAccountStopRequests: config.dailyAccountStopRequests ?? 350,
		dailyProjectSlowRequests: config.dailyProjectSlowRequests ?? 900,
		dailyProjectStopRequests: config.dailyProjectStopRequests ?? 1200,
		slowModeJitterMinMs: config.slowModeJitterMinMs ?? 8_000,
		slowModeJitterMaxMs: config.slowModeJitterMaxMs ?? 25_000,
		protectivePauseMs: config.protectivePauseMs ?? 21600000,
		useRequestCountRotationWhenQuotaUnknownOnly: config.useRequestCountRotationWhenQuotaUnknownOnly ?? true,
		tokenBucketEnabled: config.tokenBucketEnabled ?? false,
		tokenBucketMaxTokens: config.tokenBucketMaxTokens ?? 50,
		tokenBucketRefillPerMinute: config.tokenBucketRefillPerMinute ?? 6,
		tokenBucketInitialTokens: config.tokenBucketInitialTokens ?? (config.tokenBucketMaxTokens ?? 50),
		accounts: config.accounts.map((account) => ({
			...account,
			tier: account.tier || "unknown",
		})),
	};
}

export function getDefaultConfig(): Config {
	return applyConfigDefaults({
		proxyPort: 51200,
		accounts: [],
		requestsPerRotation: 5,
		rotateOnQuotaDrop: 20,
		quotaPollIntervalMs: 300000,
		maxConcurrentRequestsPerAccount: 1,
		maxConcurrentRequestsPerProjectModel: 1,
		projectCircuitBreaker429Threshold: 3,
		projectCircuitBreakerWindowMs: 10 * 60 * 1000,
		projectCircuitBreakerCooldownMs: 60 * 60 * 1000,
		modelCircuitBreaker429Threshold: 3,
		modelCircuitBreakerCooldownMs: 6 * 60 * 60 * 1000,
		dailyAccountSlowRequests: 250,
		dailyAccountStopRequests: 350,
		dailyProjectSlowRequests: 900,
		dailyProjectStopRequests: 1200,
		slowModeJitterMinMs: 8_000,
		slowModeJitterMaxMs: 25_000,
		protectivePauseMs: 21600000,
		useRequestCountRotationWhenQuotaUnknownOnly: true,
		tokenBucketEnabled: false,
		tokenBucketMaxTokens: 50,
		tokenBucketRefillPerMinute: 6,
		tokenBucketInitialTokens: 50,
	});
}

export function loadConfigFromDisk(): Config {
	const parsed = readJsonFile<unknown>(ACCOUNTS_FILE);
	if (parsed === null) return getDefaultConfig();
	const validation = validateConfig(parsed);
	if (!validation.ok || !validation.value) {
		throw new Error(formatValidationErrors(validation.errors));
	}
	return applyConfigDefaults(validation.value);
}

export function loadOrCreateAccountsConfig(): Config {
	try {
		return loadConfigFromDisk();
	} catch {
		return getDefaultConfig();
	}
}

export function saveAccountsConfig(config: Config): void {
	backupFile(ACCOUNTS_FILE, "accounts");
	writeJsonFileAtomic(ACCOUNTS_FILE, applyConfigDefaults(config));
}

// Reasonable upper bounds on per-account fields. These are defensive
// limits to prevent a malicious or buggy caller from growing
// accounts.json without bound, which would slow every subsequent
// saveState. The numbers are well above any realistic real value.
export const MAX_EMAIL_LENGTH = 254; // RFC 5321
export const MAX_LABEL_LENGTH = 100;
export const MAX_PROJECT_ID_LENGTH = 100;
export const MAX_REFRESH_TOKEN_LENGTH = 4096;

function validateAccountConfigLengths(entry: AccountConfig): void {
	const checks: Array<[string, number]> = [
		["email", MAX_EMAIL_LENGTH],
		["label", MAX_LABEL_LENGTH],
		["projectId", MAX_PROJECT_ID_LENGTH],
		["refreshToken", MAX_REFRESH_TOKEN_LENGTH],
	];
	for (const [field, max] of checks) {
		const value = entry[field as keyof AccountConfig];
		if (typeof value === "string" && value.length > max) {
			throw new Error(
				`Account ${field} exceeds maximum length ${max} (got ${value.length}). ` +
				`This usually indicates a malformed input — refusing to write to accounts.json.`,
			);
		}
	}
}

export { validateAccountConfigLengths };

export function addAccountToConfig(entry: AccountConfig): { isNew: boolean } {
	validateAccountConfigLengths(entry);
	const config = loadOrCreateAccountsConfig();
	const existing = config.accounts.findIndex((a) => a.email === entry.email);

	if (existing >= 0) {
		config.accounts[existing] = { ...config.accounts[existing], ...entry };
		saveAccountsConfig(config);
		return { isNew: false };
	}

	config.accounts.push(entry);
	saveAccountsConfig(config);
	return { isNew: true };
}

export function ensurePiModelsConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let models: Record<string, unknown> = {};
	if (existsSync(PI_MODELS_FILE)) {
		try {
			models = JSON.parse(readFileSync(PI_MODELS_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	const providers = (models.providers || {}) as Record<string, Record<string, unknown>>;
	const antigravity = providers["google-antigravity"] || {};

	if (antigravity.baseUrl === "http://localhost:51200") {
		return;
	}

	antigravity.baseUrl = "http://localhost:51200";
	providers["google-antigravity"] = antigravity;
	models.providers = providers;

	writeJsonFileAtomic(PI_MODELS_FILE, models);
	console.log(`  Updated ${PI_MODELS_FILE}`);
}

export function ensurePiAuthConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let auth: Record<string, unknown> = {};
	if (existsSync(PI_AUTH_FILE)) {
		try {
			auth = JSON.parse(readFileSync(PI_AUTH_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	const existing = auth["google-antigravity"] as Record<string, unknown> | undefined;
	if (existing?.type === "oauth" && existing?.refresh === "proxy-managed") {
		return;
	}

	auth["google-antigravity"] = {
		type: "oauth",
		refresh: "proxy-managed",
		access: "proxy-managed",
		expires: 32503680000000,
		projectId: "proxy-managed",
	};

	writeJsonFileAtomic(PI_AUTH_FILE, auth);
	console.log(`  Updated ${PI_AUTH_FILE}`);
}
