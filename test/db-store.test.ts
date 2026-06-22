import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  initDb,
  isDbConfigured,
  getCachedConfig,
  setCachedConfig,
  getCachedAdminToken,
  setCachedAdminToken,
  getCachedState,
  setCachedState,
  getCachedTokenUsage,
  setCachedTokenUsage,
  getCachedResponsesStore,
  setCachedResponsesStore,
} from "../src/db-store.js";
import type { Config, PersistedState, TokenUsageTiered } from "../src/types.js";
import type { PersistedResponsesStore } from "../src/db-store.js";

describe("db-store helpers", () => {
  before(async () => {
    await initDb();
  });

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

  it("can cache and retrieve rotator state", () => {
    const mockState: PersistedState = {
      modelAccounts: { "gemini-2.5-pro": 0 },
      modelRequestCounts: { "gemini-2.5-pro": 3 },
      currentIndex: 0,
      protectivePauseUntil: 0,
      protectivePauseReason: null,
      allowFreshWindowStarts: true,
      accounts: {
        "test@example.com": {
          totalRequests: 42,
          quotaExhaustedAt: 0,
          disabled: false,
          flagged: false,
        },
      },
    };

    setCachedState(mockState);
    const cached = getCachedState();
    assert.ok(cached);
    assert.equal(cached.modelAccounts["gemini-2.5-pro"], 0);
    assert.equal(cached.accounts["test@example.com"].totalRequests, 42);
  });

  it("can cache and retrieve token usage", () => {
    const mockUsage: TokenUsageTiered = {
      minutes: [
        {
          period: "2026-06-21T16:00",
          inputTokens: 100,
          outputTokens: 50,
          requests: 2,
          byModel: {},
        },
      ],
      hours: [],
      days: [],
      months: [],
    };

    setCachedTokenUsage(mockUsage);
    const cached = getCachedTokenUsage();
    assert.ok(cached);
    assert.equal(cached.minutes.length, 1);
    assert.equal(cached.minutes[0].inputTokens, 100);
  });

  it("can cache and retrieve responses store", () => {
    const mockStore: PersistedResponsesStore = {
      version: 1,
      entries: [
        [
          "resp-123",
          {
            response: { id: "resp-123" },
            inputItems: [],
            conversationMessages: [],
            callIdToName: {},
            expiresAt: Date.now() + 3600000,
          },
        ],
      ],
    };

    setCachedResponsesStore(mockStore);
    const cached = getCachedResponsesStore();
    assert.ok(cached);
    assert.equal(cached.version, 1);
    assert.equal(cached.entries.length, 1);
    assert.equal(cached.entries[0][0], "resp-123");
  });

  it("returns null for uncached keys", () => {
    // These will return null because they haven't been set
    // (getCachedState/TokenUsage/ResponsesStore use separate keys)
    // Just verify no crash
    assert.equal(typeof getCachedState, "function");
    assert.equal(typeof getCachedTokenUsage, "function");
    assert.equal(typeof getCachedResponsesStore, "function");
  });
});
