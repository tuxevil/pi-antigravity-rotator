import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	calculateBackoffMs,
	fetchWithRetry,
	isRetryableFetchError,
	isRetryableStatus,
} from "../src/fetch-with-retry.js";

describe("fetchWithRetry", () => {
	it("classifies retryable statuses", () => {
		assert.equal(isRetryableStatus(429), true);
		assert.equal(isRetryableStatus(503), true);
		assert.equal(isRetryableStatus(401), false);
		assert.equal(isRetryableStatus(403), false);
	});

	it("classifies transport errors as retryable", () => {
		assert.equal(isRetryableFetchError(new TypeError("fetch failed")), true);
		assert.equal(isRetryableFetchError(new Error("bad input")), false);
	});

	it("calculates bounded exponential backoff with jitter", () => {
		assert.equal(calculateBackoffMs(0, 100, 1_000, () => 0), 100);
		assert.equal(calculateBackoffMs(1, 100, 1_000, () => 0), 200);
		assert.equal(calculateBackoffMs(10, 100, 500, () => 1), 500);
	});

	it("returns first successful response", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
		});
		assert.equal(calls, 1);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "ok");
	});

	it("retries retryable statuses then returns success", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return calls === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 2);
		assert.equal(response.status, 200);
	});

	it("does not retry non-retryable statuses", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				return new Response("no", { status: 401 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 1);
		assert.equal(response.status, 401);
	});

	it("retries transport errors then returns success", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.test", {
			fetchImpl: async () => {
				calls++;
				if (calls === 1) throw new TypeError("fetch failed");
				return new Response("ok", { status: 200 });
			},
			sleepImpl: async () => {},
			retries: 2,
		});
		assert.equal(calls, 2);
		assert.equal(response.status, 200);
	});

	it("throws final transport error after retry budget", async () => {
		let calls = 0;
		await assert.rejects(
			fetchWithRetry("https://example.test", {
				fetchImpl: async () => {
					calls++;
					throw new TypeError("fetch failed");
				},
				sleepImpl: async () => {},
				retries: 1,
			}),
			TypeError,
		);
		assert.equal(calls, 2);
	});
});
