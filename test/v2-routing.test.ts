import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AccountRotator } from "../src/rotator.js";
import type { Config } from "../src/types.js";

function makeConfig(): Config {
	return {
		proxyPort: 51200,
		bindHost: "0.0.0.0",
		routingPolicy: "timer-first",
		requestsPerRotation: 5,
		rotateOnQuotaDrop: 20,
		quotaPollIntervalMs: 300000,
		accounts: [
			{ email: "a@example.com", refreshToken: "a", projectId: "pa", tier: "free" },
			{ email: "b@example.com", refreshToken: "b", projectId: "pb", tier: "ultra" },
		],
		tokenBucketEnabled: false,
		tokenBucketMaxTokens: 5,
		tokenBucketRefillPerMinute: 1,
		tokenBucketInitialTokens: 5,
	};
}

describe("v2 routing and status", () => {
	it("keeps timer-first routing and uses tier as a tie-breaker", () => {
		const rotator = new AccountRotator(makeConfig()) as any;
		rotator.stopQuotaPolling();
		rotator.accounts[0].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 50, resetTime: null, timerType: "7d" }];
		rotator.accounts[1].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 50, resetTime: null, timerType: "7d" }];
		rotator.accounts[0].healthScore = 0.9;
		rotator.accounts[1].healthScore = 0.9;

		const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
		assert.equal(best?.config.email, "b@example.com");
	});

	it("surfaces admin exposure warnings in status when token is missing", () => {
		const rotator = new AccountRotator(makeConfig());
		rotator.stopQuotaPolling();
		const status = rotator.getStatus();
		assert.equal(status.security.adminTokenConfigured, false);
		assert.match(status.security.warning || "", /PI_ROTATOR_ADMIN_TOKEN/);
	});

	it("supports quota-first policy when configured", () => {
		const config = makeConfig();
		config.routingPolicy = "quota-first";
		const rotator = new AccountRotator(config) as any;
		rotator.stopQuotaPolling();
		rotator.accounts[0].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 90, resetTime: null, timerType: "fresh" }];
		rotator.accounts[1].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 50, resetTime: null, timerType: "7d" }];
		rotator.accounts[0].healthScore = 0.9;
		rotator.accounts[1].healthScore = 0.9;

		const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
		assert.equal(best?.config.email, "a@example.com");
	});

	it("supports hybrid policy and excludes empty token buckets", () => {
		const config = makeConfig();
		config.routingPolicy = "hybrid";
		config.tokenBucketEnabled = true;
		const rotator = new AccountRotator(config) as any;
		rotator.stopQuotaPolling();
		rotator.accounts[0].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 95, resetTime: null, timerType: "5h" }];
		rotator.accounts[1].quota = [{ modelKey: "gemini-3.1-pro", displayName: "G3.1Pro", percentRemaining: 85, resetTime: null, timerType: "7d" }];
		rotator.accounts[0].healthScore = 0.8;
		rotator.accounts[1].healthScore = 1;
		rotator.accounts[0].tokenBucket.tokens = 0;
		rotator.accounts[1].tokenBucket.tokens = 4;

		const best = rotator.pickBestModelAccount("gemini-3.1-pro", Date.now(), -1);
		assert.equal(best?.config.email, "b@example.com");

		const status = rotator.getStatus();
		assert.equal(status.routingDiagnostics["gemini-3.1-pro"].accounts[0].rejectedReason, "token-bucket-empty");
	});
});
