import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	formatValidationErrors,
	validateAccountConfig,
	validateConfig,
	validateProxyRequestBody,
} from "../src/validators.js";

const validAccount = {
	email: "user@example.com",
	refreshToken: "refresh-token",
	projectId: "project-id",
	label: "user",
	tier: "unknown",
};

describe("validators", () => {
	it("accepts a valid account config", () => {
		const result = validateAccountConfig(validAccount);
		assert.equal(result.ok, true);
		assert.deepEqual(result.errors, []);
		assert.equal(result.value?.email, validAccount.email);
	});

	it("rejects invalid account config", () => {
		const result = validateAccountConfig({ email: "", refreshToken: 123 });
		assert.equal(result.ok, false);
		assert.match(formatValidationErrors(result.errors), /email/);
		assert.match(formatValidationErrors(result.errors), /refreshToken/);
		assert.match(formatValidationErrors(result.errors), /projectId/);
	});

	it("accepts a valid config with optional fields", () => {
		const result = validateConfig({
			proxyPort: 51200,
			bindHost: "127.0.0.1",
			routingPolicy: "hybrid",
			requestsPerRotation: 5,
			rotateOnQuotaDrop: 0,
			quotaPollIntervalMs: 300_000,
			maxConcurrentRequestsPerAccount: 1,
			protectivePauseMs: 0,
			useRequestCountRotationWhenQuotaUnknownOnly: true,
			tokenBucketEnabled: true,
			tokenBucketMaxTokens: 50,
			tokenBucketRefillPerMinute: 6,
			tokenBucketInitialTokens: 20,
			accounts: [validAccount],
		});
		assert.equal(result.ok, true);
	});

	it("rejects malformed config", () => {
		const result = validateConfig({
			proxyPort: -1,
			requestsPerRotation: 0,
			rotateOnQuotaDrop: -5,
			accounts: [{}],
		});
		assert.equal(result.ok, false);
		const message = formatValidationErrors(result.errors);
		assert.match(message, /proxyPort/);
		assert.match(message, /requestsPerRotation/);
		assert.match(message, /rotateOnQuotaDrop/);
		assert.match(message, /accounts\[0\]\.email/);
	});

	it("accepts minimal proxy request body", () => {
		const result = validateProxyRequestBody({
			model: "gemini-3-flash",
			request: { contents: [] },
		});
		assert.equal(result.ok, true);
		assert.equal(result.value?.model, "gemini-3-flash");
	});

	it("does not require project in proxy request because proxy overwrites it", () => {
		const result = validateProxyRequestBody({ model: "claude-sonnet-4-6", request: {} });
		assert.equal(result.ok, true);
	});

	it("rejects malformed proxy request body", () => {
		const result = validateProxyRequestBody({ model: "" });
		assert.equal(result.ok, false);
		const message = formatValidationErrors(result.errors);
		assert.match(message, /model/);
		assert.match(message, /request/);
	});

	it("rejects non-object proxy request body", () => {
		const result = validateProxyRequestBody(null);
		assert.equal(result.ok, false);
		assert.match(formatValidationErrors(result.errors), /JSON object/);
	});
});
