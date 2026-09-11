import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sortQuotaPools,
  sortAccountCredentials,
  PROVIDER_ORDER,
  getProviderIdForPoolKey,
  getQuotaItemProviderId,
} from "../src/providers/credential-helpers.js";

describe("provider pool and credential ordering", () => {
  it("defines the provider order as antigravity, ollama, opencode, codex", () => {
    assert.deepEqual(PROVIDER_ORDER, [
      "google-antigravity",
      "ollama",
      "opencode-zen",
      "openai-codex",
    ]);
  });

  it("resolves pool keys to provider ids correctly", () => {
    assert.equal(getProviderIdForPoolKey("claude"), "google-antigravity");
    assert.equal(getProviderIdForPoolKey("gemini"), "google-antigravity");
    assert.equal(getProviderIdForPoolKey("session"), "ollama");
    assert.equal(getProviderIdForPoolKey("weekly"), "ollama");
    assert.equal(getProviderIdForPoolKey("monthly"), "ollama");
    assert.equal(getProviderIdForPoolKey("opencode-zen"), "opencode-zen");
    assert.equal(getProviderIdForPoolKey("opencode-zen:free"), "opencode-zen");
    assert.equal(getProviderIdForPoolKey("openai-codex"), "openai-codex");
    assert.equal(getProviderIdForPoolKey("codex:gpt-5.6"), "openai-codex");
  });

  it("sorts quota pools in exact order: antigravity -> ollama -> opencode -> codex", () => {
    const mixedPools = [
      { modelKey: "openai-codex", displayName: "Codex", percentRemaining: 100, resetTime: null, timerType: "fresh" as const, providerId: "openai-codex" },
      { modelKey: "session", displayName: "Ollama Session", percentRemaining: 100, resetTime: null, timerType: "fresh" as const, providerId: "ollama" },
      { modelKey: "opencode-zen", displayName: "OpenCode Zen", percentRemaining: 100, resetTime: null, timerType: "fresh" as const, providerId: "opencode-zen" },
      { modelKey: "claude", displayName: "Claude Family", percentRemaining: 100, resetTime: null, timerType: "fresh" as const, providerId: "google-antigravity" },
      { modelKey: "gemini", displayName: "Gemini Family", percentRemaining: 100, resetTime: null, timerType: "fresh" as const, providerId: "google-antigravity" },
    ];

    const sorted = sortQuotaPools(mixedPools);
    const sortedProviders = sorted.map((q) => getQuotaItemProviderId(q));

    assert.deepEqual(sortedProviders, [
      "google-antigravity",
      "google-antigravity",
      "ollama",
      "opencode-zen",
      "openai-codex",
    ]);
  });

  it("sorts account credentials in exact order: antigravity -> ollama -> opencode -> codex", () => {
    const mixedCredentials = [
      { provider: "openai-codex" },
      { provider: "opencode-zen" },
      { provider: "ollama" },
      { provider: "google-antigravity" },
    ];

    const sorted = sortAccountCredentials(mixedCredentials);
    assert.deepEqual(
      sorted.map((c) => c.provider),
      ["google-antigravity", "ollama", "opencode-zen", "openai-codex"],
    );
  });
});
