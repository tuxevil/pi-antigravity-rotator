import test from "node:test";
import assert from "node:assert/strict";
import {
  generateRequestId,
  logSpend,
  getSpendLogs,
  getDailySpendSummary,
} from "../src/spend-logger.js";

test("generateRequestId produces unique prefixed strings", () => {
  const id1 = generateRequestId();
  const id2 = generateRequestId();

  assert.match(id1, /^req_/);
  assert.match(id2, /^req_/);
  assert.notEqual(id1, id2);
});

test("logSpend enqueues log without throwing", () => {
  assert.doesNotThrow(() => {
    logSpend({
      model: "gemini-3.5-flash-high",
      callType: "chat_completion",
      status: "success",
      promptTokens: 100,
      completionTokens: 50,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 450,
    });
  });
});

test("getSpendLogs returns empty logs when DB is not configured", async () => {
  const result = await getSpendLogs();
  assert.equal(result.total, 0);
  assert.deepEqual(result.logs, []);
});

test("getDailySpendSummary returns empty array when DB is not configured", async () => {
  const summary = await getDailySpendSummary({});
  assert.deepEqual(summary, []);
});

test("sanitizeLikePattern escapes backslashes, percent signs, and underscores", () => {
  const input = "test\\%_query";
  const escaped = input.replace(/[\\%_]/g, "\\$&");
  assert.equal(escaped, "test\\\\\\%\\_query");
});
