import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { isDbConfigured, getCachedConfig, setCachedConfig, getCachedAdminToken, setCachedAdminToken } from "../src/db-store.js";
import type { Config } from "../src/types.js";

describe("db-store helpers", () => {
	const originalEnv = process.env.PI_ROTATOR_DATABASE_URL;
	const originalDbEnv = process.env.DATABASE_URL;

	after(() => {
		if (originalEnv !== undefined) {
			process.env.PI_ROTATOR_DATABASE_URL = originalEnv;
		} else {
			delete process.env.PI_ROTATOR_DATABASE_URL;
		}
		if (originalDbEnv !== undefined) {
			process.env.DATABASE_URL = originalDbEnv;
		} else {
			delete process.env.DATABASE_URL;
		}
	});

	it("correctly identifies when DB is configured via PI_ROTATOR_DATABASE_URL", () => {
		process.env.PI_ROTATOR_DATABASE_URL = "postgres://localhost:5432/test";
		delete process.env.DATABASE_URL;
		assert.equal(isDbConfigured(), true);
	});

	it("correctly identifies when DB is configured via DATABASE_URL", () => {
		delete process.env.PI_ROTATOR_DATABASE_URL;
		process.env.DATABASE_URL = "postgres://localhost:5432/test";
		assert.equal(isDbConfigured(), true);
	});

	it("correctly identifies when DB is not configured", () => {
		delete process.env.PI_ROTATOR_DATABASE_URL;
		delete process.env.DATABASE_URL;
		assert.equal(isDbConfigured(), false);
	});

	it("can cache and retrieve configuration", () => {
		const mockConfig: Config = {
			proxyPort: 51200,
			accounts: [],
			requestsPerRotation: 5,
			rotateOnQuotaDrop: 20,
			quotaPollIntervalMs: 300000,
			maxConcurrentRequestsPerAccount: 1,
			maxConcurrentRequestsPerProjectModel: 1,
			projectCircuitBreaker429Threshold: 3,
			projectCircuitBreakerWindowMs: 600000,
			projectCircuitBreakerCooldownMs: 3600000,
			modelCircuitBreaker429Threshold: 3,
			modelCircuitBreakerCooldownMs: 21600000,
			dailyAccountSlowRequests: 250,
			dailyAccountStopRequests: 350,
			dailyProjectSlowRequests: 900,
			dailyProjectStopRequests: 1200,
			slowModeJitterMinMs: 8000,
			slowModeJitterMaxMs: 25000,
			protectivePauseMs: 21600000,
			useRequestCountRotationWhenQuotaUnknownOnly: true,
			tokenBucketEnabled: false,
			tokenBucketMaxTokens: 50,
			tokenBucketRefillPerMinute: 6,
			tokenBucketInitialTokens: 50,
		};

		setCachedConfig(mockConfig);
		const cached = getCachedConfig();
		assert.ok(cached);
		assert.equal(cached.proxyPort, 51200);
	});

	it("can cache and retrieve admin token", () => {
		setCachedAdminToken("test-token-value");
		assert.equal(getCachedAdminToken(), "test-token-value");
	});
});
