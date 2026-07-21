import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MODEL_PRICING,
	QUOTA_MODEL_KEYS,
	resolveDisplayModelKey,
	resolveQuotaModelKey,
} from "../src/types.js";

describe("model resolution", () => {
	it("maps Gemini Pro variants to the shared Pro quota pool", () => {
		assert.equal(resolveQuotaModelKey("gemini-3.1-pro-low"), "gemini-3.1-pro");
		assert.equal(resolveQuotaModelKey("gemini-3.1-pro-high"), "gemini-3.1-pro");
		assert.equal(resolveQuotaModelKey("some-gemini-pro-model"), "gemini-3.1-pro");
	});

	it("maps Flash requests to the Flash quota pool", () => {
		assert.equal(resolveQuotaModelKey("gemini-3-flash"), "gemini-3.5-flash");
		assert.equal(resolveQuotaModelKey("google/gemini-flash-latest"), "gemini-3.5-flash");
		assert.equal(resolveQuotaModelKey("gemini-3-flash-agent"), "gemini-3.5-flash");
		assert.equal(resolveQuotaModelKey("gemini-3.5-flash-medium"), "gemini-3.5-flash");
		for (const variant of ["high", "medium", "low", "tiered"]) {
			assert.equal(
				resolveQuotaModelKey(`gemini-3.6-flash-${variant}`),
				"gemini-3.6-flash",
			);
		}
	});

	it("maps GPT-OSS requests to the Claude quota pool", () => {
		assert.equal(resolveQuotaModelKey("gpt-oss-120b-medium"), "claude-opus-4-6-thinking");
		assert.equal(resolveQuotaModelKey("gpt-oss-120b"), "claude-opus-4-6-thinking");
	});

	it("maps Claude variants to the Claude quota pool", () => {
		assert.equal(resolveQuotaModelKey("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
		assert.equal(resolveQuotaModelKey("claude-sonnet-4-6"), "claude-opus-4-6-thinking");
		assert.equal(resolveQuotaModelKey("vendor/claude-custom"), "claude-opus-4-6-thinking");
	});

	it("returns null for unknown quota models", () => {
		assert.equal(resolveQuotaModelKey("unknown-local-model"), null);
	});

	it("preserves display model distinctions used by telemetry/pricing", () => {
		assert.equal(resolveDisplayModelKey("gemini-3.1-pro-low"), "gemini-3.1-pro-low");
		assert.equal(resolveDisplayModelKey("gemini-3.1-pro-high"), "gemini-3.1-pro-high");
		assert.equal(resolveDisplayModelKey("claude-sonnet-4-6"), "claude-sonnet-4-6");
		assert.equal(resolveDisplayModelKey("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
		assert.equal(resolveDisplayModelKey("gemini-3-flash-agent"), "gemini-3.5-flash-high");
		assert.equal(resolveDisplayModelKey("gemini-3.5-flash-medium"), "gemini-3.5-flash-medium");
		assert.equal(resolveDisplayModelKey("gemini-3.5-flash-low"), "gemini-3.5-flash-medium");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-high"), "gemini-3.6-flash-high");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-medium"), "gemini-3.6-flash-medium");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-low"), "gemini-3.6-flash-low");
		assert.equal(resolveDisplayModelKey("gemini-3.6-flash-tiered"), "gemini-3.6-flash-tiered");
		assert.equal(resolveDisplayModelKey("gpt-oss-120b-medium"), "gpt-oss-120b-medium");
	});

	it("has pricing entries for every known display family", () => {
		assert.ok(MODEL_PRICING["gemini-3.1-pro"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-low"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-high"]);
		assert.ok(MODEL_PRICING["gemini-3-flash"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-high"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-medium"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-low"]);
		assert.ok(MODEL_PRICING["gemini-3.6-flash-tiered"]);
		assert.ok(MODEL_PRICING["claude-opus-4-6-thinking"]);
		assert.ok(MODEL_PRICING["claude-sonnet-4-6"]);
		assert.ok(MODEL_PRICING["gpt-oss-120b-medium"]);
	});

	it("has updated pricing for Gemini 3.5 Flash", () => {
		const p = MODEL_PRICING["gemini-3.5-flash"];
		assert.ok(p);
		assert.equal(p.inputPer1M, 1.50);
		assert.equal(p.outputPer1M, 9.00);
		assert.equal(p.cachingPer1M, 0.15);
		assert.equal(p.cachingStoragePer1MPerHour, 1.00);
	});

	it("uses the official Gemini 3.6 Flash pricing", () => {
		const p = MODEL_PRICING["gemini-3.6-flash-high"];
		assert.ok(p);
		assert.equal(p.inputPer1M, 1.50);
		assert.equal(p.outputPer1M, 7.50);
		assert.equal(p.cachingPer1M, 0.15);
		assert.equal(p.cachingStoragePer1MPerHour, 1.00);
	});

	it("keeps quota model keys unique", () => {
		const keys = Object.values(QUOTA_MODEL_KEYS).map((entry) => entry.key);
		assert.equal(new Set(keys).size, keys.length);
	});

	it("orders quota model keys: claude, gemini-3.1-pro, gemini-3.5-flash, gemini-3.6-flash", () => {
		const orderedKeys = Object.keys(QUOTA_MODEL_KEYS);
		assert.deepEqual(orderedKeys, ["claude", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.6-flash"]);
	});
});
