import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRateLimitReason, parseRetryAfterMs } from "../src/rate-limit-parser.js";

describe("rate limit parser", () => {
	it("parses retry-after header in seconds", () => {
		const headers = new Headers({ "retry-after": "7" });
		const ms = parseRetryAfterMs("", headers);
		assert.equal(ms, 8000);
	});

	it("parses x-ratelimit-reset-after header", () => {
		const headers = new Headers({ "x-ratelimit-reset-after": "2" });
		const ms = parseRetryAfterMs("", headers);
		assert.equal(ms, 3000);
	});

	it("parses quotaResetDelay from error text", () => {
		const ms = parseRetryAfterMs('quotaResetDelay: "1.5s"', new Headers());
		assert.equal(ms, 2500);
	});

	it("parses retryDelay and duration strings", () => {
		const ms = parseRetryAfterMs('{"retryDelay":"45s"} reset after 1h2m3s', new Headers());
		assert.equal(ms, 46000);
	});

	it("falls back to the default retry window", () => {
		const ms = parseRetryAfterMs("unstructured error", new Headers());
		assert.equal(ms, 60000);
	});

	it("classifies quota exhaustion and capacity distinctly", () => {
		assert.equal(classifyRateLimitReason("RESOURCE_EXHAUSTED quotaResetDelay: 5s", 429), "quota-exhausted");
		assert.equal(classifyRateLimitReason("service temporarily unavailable", 503), "model-capacity");
		assert.equal(classifyRateLimitReason("internal server error", 500), "server-error");
		assert.equal(classifyRateLimitReason("too many requests", 429), "rate-limit");
		assert.equal(classifyRateLimitReason("weird", 429), "unknown");
	});
});
