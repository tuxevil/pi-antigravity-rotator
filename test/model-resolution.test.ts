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
		assert.equal(resolveQuotaModelKey("gemini-3-flash"), "gemini-3-flash");
		assert.equal(resolveQuotaModelKey("google/gemini-flash-latest"), "gemini-3-flash");
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
	});

	it("has pricing entries for every known display family", () => {
		assert.ok(MODEL_PRICING["gemini-3.1-pro"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-low"]);
		assert.ok(MODEL_PRICING["gemini-3.1-pro-high"]);
		assert.ok(MODEL_PRICING["gemini-3-flash"]);
		assert.ok(MODEL_PRICING["claude-opus-4-6-thinking"]);
		assert.ok(MODEL_PRICING["claude-sonnet-4-6"]);
	});

	it("keeps quota model keys unique", () => {
		const keys = Object.values(QUOTA_MODEL_KEYS).map((entry) => entry.key);
		assert.equal(new Set(keys).size, keys.length);
	});
});
