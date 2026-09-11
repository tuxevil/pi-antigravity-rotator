import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUsagePools } from "../src/providers/ollama/quota.js";

describe("Ollama monthly quota parsing", () => {
  it("publishes the current monthly usage pool", () => {
    const quotas = extractUsagePools(
      {
        limits: {
          monthly: {
            usage: 0.37,
            models: [],
          },
        },
      },
      [],
    );

    assert.deepEqual(quotas, [
      {
        modelKey: "monthly",
        displayName: "Ollama",
        percentRemaining: 63,
        usageRaw: 0.37,
        resetTime: null,
        timerType: "monthly",
      },
    ]);
  });

  it("does not retain legacy session/weekly pools when monthly is present", () => {
    const quotas = extractUsagePools(
      {
        limits: {
          monthly: { usage: 0 },
        },
      },
      [
        {
          modelKey: "session",
          displayName: "Session",
          percentRemaining: 20,
          resetTime: null,
          timerType: "5h",
        },
        {
          modelKey: "weekly",
          displayName: "Weekly",
          percentRemaining: 20,
          resetTime: null,
          timerType: "7d",
        },
      ],
    );

    assert.deepEqual(quotas.map((quota) => quota.modelKey), ["monthly"]);
  });
});
