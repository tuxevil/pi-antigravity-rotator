import {
	MAX_QUOTA_POLL_INTERVAL_MS,
	MIN_QUOTA_POLL_INTERVAL_MS,
	type AccountConfig,
	type Config,
} from "./types.js";

export interface ValidationResult<T> {
	ok: boolean;
	value?: T;
	errors: string[];
}

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value, errors: [] };
}

function fail<T>(errors: string[]): ValidationResult<T> {
	return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateAccountConfig(value: unknown, path = "account"): ValidationResult<AccountConfig> {
	if (!isRecord(value)) return fail([`${path} must be an object`]);
	const errors: string[] = [];

	if (!isNonEmptyString(value.email)) errors.push(`${path}.email must be a non-empty string`);
	if (!isNonEmptyString(value.refreshToken)) errors.push(`${path}.refreshToken must be a non-empty string`);
	if (!isNonEmptyString(value.projectId)) errors.push(`${path}.projectId must be a non-empty string`);
	if (value.label !== undefined && typeof value.label !== "string") errors.push(`${path}.label must be a string`);
	if (value.type !== undefined && value.type !== "pro" && value.type !== "free") errors.push(`${path}.type must be "pro" or "free"`);
	if (value.tier !== undefined && !["ultra", "pro", "plus", "free", "unknown"].includes(String(value.tier))) {
		errors.push(`${path}.tier must be "ultra", "pro", "plus", "free", or "unknown"`);
	}
	if (value.familyManager !== undefined && typeof value.familyManager !== "boolean") errors.push(`${path}.familyManager must be a boolean`);

	return errors.length > 0 ? fail(errors) : ok(value as unknown as AccountConfig);
}

export function validateConfig(value: unknown): ValidationResult<Config> {
	if (!isRecord(value)) return fail(["config must be an object"]);
	const errors: string[] = [];

	if (!Array.isArray(value.accounts)) {
		errors.push("config.accounts must be an array");
	} else {
		value.accounts.forEach((account, index) => {
			const result = validateAccountConfig(account, `config.accounts[${index}]`);
			errors.push(...result.errors);
		});
	}

	if (value.proxyPort !== undefined && !isPositiveNumber(value.proxyPort)) errors.push("config.proxyPort must be a positive number");
	if (value.bindHost !== undefined && !isNonEmptyString(value.bindHost)) errors.push("config.bindHost must be a non-empty string");
	if (value.routingPolicy !== undefined && !["timer-first", "tier-first", "quota-first", "hybrid"].includes(String(value.routingPolicy))) {
		errors.push('config.routingPolicy must be "timer-first", "tier-first", "quota-first", or "hybrid"');
	}
	if (value.requestsPerRotation !== undefined && !isPositiveNumber(value.requestsPerRotation)) errors.push("config.requestsPerRotation must be a positive number");
	if (value.rotateOnQuotaDrop !== undefined && !isNonNegativeNumber(value.rotateOnQuotaDrop)) errors.push("config.rotateOnQuotaDrop must be a non-negative number");
	if (value.quotaPollIntervalMs !== undefined && (!isPositiveNumber(value.quotaPollIntervalMs) || value.quotaPollIntervalMs < MIN_QUOTA_POLL_INTERVAL_MS || value.quotaPollIntervalMs > MAX_QUOTA_POLL_INTERVAL_MS)) {
		errors.push(`config.quotaPollIntervalMs must be between ${MIN_QUOTA_POLL_INTERVAL_MS} and ${MAX_QUOTA_POLL_INTERVAL_MS} ms`);
	}
	if (value.proSlots !== undefined && !isPositiveNumber(value.proSlots)) errors.push("config.proSlots must be a positive number");
	if (value.maxConcurrentRequestsPerAccount !== undefined && !isPositiveNumber(value.maxConcurrentRequestsPerAccount)) errors.push("config.maxConcurrentRequestsPerAccount must be a positive number");
	if (value.maxConcurrentRequestsPerProjectModel !== undefined && !isPositiveNumber(value.maxConcurrentRequestsPerProjectModel)) errors.push("config.maxConcurrentRequestsPerProjectModel must be a positive number");
	if (value.projectCircuitBreaker429Threshold !== undefined && !isPositiveNumber(value.projectCircuitBreaker429Threshold)) errors.push("config.projectCircuitBreaker429Threshold must be a positive number");
	if (value.projectCircuitBreakerWindowMs !== undefined && !isPositiveNumber(value.projectCircuitBreakerWindowMs)) errors.push("config.projectCircuitBreakerWindowMs must be a positive number");
	if (value.projectCircuitBreakerCooldownMs !== undefined && !isPositiveNumber(value.projectCircuitBreakerCooldownMs)) errors.push("config.projectCircuitBreakerCooldownMs must be a positive number");
	if (value.modelCircuitBreaker429Threshold !== undefined && !isPositiveNumber(value.modelCircuitBreaker429Threshold)) errors.push("config.modelCircuitBreaker429Threshold must be a positive number");
	if (value.modelCircuitBreakerCooldownMs !== undefined && !isPositiveNumber(value.modelCircuitBreakerCooldownMs)) errors.push("config.modelCircuitBreakerCooldownMs must be a positive number");
	if (value.dailyAccountSlowRequests !== undefined && !isPositiveNumber(value.dailyAccountSlowRequests)) errors.push("config.dailyAccountSlowRequests must be a positive number");
	if (value.dailyAccountStopRequests !== undefined && !isPositiveNumber(value.dailyAccountStopRequests)) errors.push("config.dailyAccountStopRequests must be a positive number");
	if (value.dailyProjectSlowRequests !== undefined && !isPositiveNumber(value.dailyProjectSlowRequests)) errors.push("config.dailyProjectSlowRequests must be a positive number");
	if (value.dailyProjectStopRequests !== undefined && !isPositiveNumber(value.dailyProjectStopRequests)) errors.push("config.dailyProjectStopRequests must be a positive number");
	if (value.slowModeJitterMinMs !== undefined && !isNonNegativeNumber(value.slowModeJitterMinMs)) errors.push("config.slowModeJitterMinMs must be a non-negative number");
	if (value.slowModeJitterMaxMs !== undefined && !isNonNegativeNumber(value.slowModeJitterMaxMs)) errors.push("config.slowModeJitterMaxMs must be a non-negative number");
	if (value.protectivePauseMs !== undefined && !isNonNegativeNumber(value.protectivePauseMs)) errors.push("config.protectivePauseMs must be a non-negative number");
	if (value.useRequestCountRotationWhenQuotaUnknownOnly !== undefined && typeof value.useRequestCountRotationWhenQuotaUnknownOnly !== "boolean") {
		errors.push("config.useRequestCountRotationWhenQuotaUnknownOnly must be a boolean");
	}
	if (value.tokenBucketEnabled !== undefined && typeof value.tokenBucketEnabled !== "boolean") {
		errors.push("config.tokenBucketEnabled must be a boolean");
	}
	if (value.tokenBucketMaxTokens !== undefined && !isPositiveNumber(value.tokenBucketMaxTokens)) {
		errors.push("config.tokenBucketMaxTokens must be a positive number");
	}
	if (value.tokenBucketRefillPerMinute !== undefined && !isPositiveNumber(value.tokenBucketRefillPerMinute)) {
		errors.push("config.tokenBucketRefillPerMinute must be a positive number");
	}
	if (value.tokenBucketInitialTokens !== undefined && !isNonNegativeNumber(value.tokenBucketInitialTokens)) {
		errors.push("config.tokenBucketInitialTokens must be a non-negative number");
	}
	if (value.modelSpecs !== undefined) {
		if (!isRecord(value.modelSpecs)) {
			errors.push("config.modelSpecs must be an object when provided");
		} else {
			for (const [key, spec] of Object.entries(value.modelSpecs)) {
				if (!isRecord(spec)) {
					errors.push(`config.modelSpecs.${key} must be an object`);
					continue;
				}
				if (spec.maxOutputTokens !== undefined && !isPositiveNumber(spec.maxOutputTokens)) {
					errors.push(`config.modelSpecs.${key}.maxOutputTokens must be a positive number`);
				}
				if (spec.thinkingBudget !== undefined && (typeof spec.thinkingBudget !== "number" || !Number.isFinite(spec.thinkingBudget))) {
					errors.push(`config.modelSpecs.${key}.thinkingBudget must be a number`);
				}
				if (spec.isThinking !== undefined && typeof spec.isThinking !== "boolean") {
					errors.push(`config.modelSpecs.${key}.isThinking must be a boolean`);
				}
			}
		}
	}
	if (value.modelAliases !== undefined) {
		if (!isRecord(value.modelAliases)) {
			errors.push("config.modelAliases must be an object when provided");
		} else {
			for (const [from, to] of Object.entries(value.modelAliases)) {
				if (typeof from !== "string" || from.length === 0) {
					errors.push("config.modelAliases keys must be non-empty strings");
					break;
				}
				if (typeof to !== "string" || to.length === 0) {
					errors.push(`config.modelAliases.${from} must be a non-empty string`);
				}
			}
		}
	}

	return errors.length > 0 ? fail(errors) : ok(value as unknown as Config);
}

export interface MinimalProxyRequestBody {
	model: string;
	request: unknown;
	project?: string;
	requestType?: string;
	userAgent?: string;
	requestId?: string;
	[key: string]: unknown;
}

export function validateProxyRequestBody(value: unknown): ValidationResult<MinimalProxyRequestBody> {
	if (!isRecord(value)) return fail(["request body must be a JSON object"]);
	const errors: string[] = [];

	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!("request" in value)) errors.push("body.request is required");
	if (value.project !== undefined && typeof value.project !== "string") errors.push("body.project must be a string when provided");
	if (value.requestType !== undefined && typeof value.requestType !== "string") errors.push("body.requestType must be a string when provided");
	if (value.userAgent !== undefined && typeof value.userAgent !== "string") errors.push("body.userAgent must be a string when provided");
	if (value.requestId !== undefined && typeof value.requestId !== "string") errors.push("body.requestId must be a string when provided");

	return errors.length > 0 ? fail(errors) : ok(value as MinimalProxyRequestBody);
}

export function formatValidationErrors(errors: string[]): string {
	return errors.join("; ");
}
