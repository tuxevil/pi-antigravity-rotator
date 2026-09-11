import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderAdapter, isKnownProvider } from "../src/providers/registry.js";
import { opencodeZenAdapter, OPENCODE_ZEN_PROVIDER_ID } from "../src/providers/opencode-zen/index.js";
import {
  OPENCODE_ZEN_FREE_MODELS,
  OPENCODE_ZEN_MODELS_URL,
  isOpenCodeZenModel,
} from "../src/providers/opencode-zen/catalog.js";
import {
  getOpenCodeZenApiKey,
  validateCredentials,
  defaultAccountEmail,
} from "../src/providers/opencode-zen/credentials.js";
import {
  buildOpenCodeZenPayload,
  OpenCodeZenSseAccumulator,
  getBenchmarkSpec,
} from "../src/providers/opencode-zen/forward.js";
import { fetchOpenCodeZenQuota } from "../src/providers/opencode-zen/quota.js";
import { parseOpenAiJson, anthropicToOpenAIChatRequest } from "../src/compat.js";
import type { AccountRuntime } from "../src/types.js";
import type { QuotaFetchContext } from "../src/providers/adapter.js";

describe("OpenCode Zen Provider Adapter", () => {
  it("registers in the provider registry", () => {
    assert.equal(isKnownProvider("opencode-zen"), true);
    assert.equal(getProviderAdapter("opencode-zen"), opencodeZenAdapter);
    assert.equal(opencodeZenAdapter.id, "opencode-zen");
    assert.equal(opencodeZenAdapter.displayName, "OpenCode Zen");
    assert.equal(opencodeZenAdapter.credentialKind, "api-key");
  });

  it("identifies OpenCode Zen free models correctly", () => {
    assert.equal(OPENCODE_ZEN_FREE_MODELS.length, 5);
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("deepseek-v4-flash-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("nemotron-3.5-lightning-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("nemotron-3-ultra-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("mimo-v2.5-free"));
    assert.ok(OPENCODE_ZEN_FREE_MODELS.includes("hy3-free"));


    for (const model of OPENCODE_ZEN_FREE_MODELS) {
      assert.equal(isOpenCodeZenModel(model), true);
    }

    assert.equal(isOpenCodeZenModel("custom-model-free"), true);
    assert.equal(isOpenCodeZenModel("gpt-4o"), false);
    assert.equal(isOpenCodeZenModel("gemini-3.8-flash-high"), false);
  });

  it("validates credentials correctly", async () => {
    const validConfig = {
      email: "zen-test@opencode.ai",
      credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "zen-secret-key" }],
    };
    const invalidConfig = {
      email: "bad@opencode.ai",
      credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "" }],
    };

    assert.equal(getOpenCodeZenApiKey(validConfig), "zen-secret-key");
    assert.equal((await validateCredentials(validConfig)).ok, true);
    assert.equal((await validateCredentials(invalidConfig)).ok, false);
  });

  it("derives default account email", () => {
    assert.equal(defaultAccountEmail("1234567890abcdef"), "zen-90abcdef@opencode.ai");
  });

  it("builds chat completion request payloads", () => {
    const body = {
      project: "",
      model: "deepseek-v4-flash-free",
      request: {
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
    };
    const payload = buildOpenCodeZenPayload(body);
    assert.equal(payload.model, "deepseek-v4-flash-free");
    assert.deepEqual(payload.messages, [{ role: "user", content: "Hello" }]);
    assert.equal(payload.stream, true);
  });

  it("normalises developer role to system in OpenCodeZen payloads", () => {
    const body = {
      project: "",
      model: "deepseek-v4-flash-free",
      request: {
        messages: [
          { role: "developer", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
        stream: false,
      },
    };
    const payload = buildOpenCodeZenPayload(body);
    const messages = payload.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, "system", "developer role should be normalised to system");
    assert.equal(messages[0].content, "You are a helpful assistant.");
    assert.equal(messages[1].role, "user");
  });

  it("accumulates SSE streaming text and token usage", () => {
    const accumulator = new OpenCodeZenSseAccumulator();

    const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const chunk2 = 'data: {"choices":[{"delta":{"content":" World"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n';

    const usage1 = accumulator.append(chunk1);
    assert.equal(usage1, null);
    assert.equal(accumulator.getText(), "Hello");

    const usage2 = accumulator.append(chunk2);
    assert.notEqual(usage2, null);
    assert.equal(usage2?.inputTokens, 10);
    assert.equal(usage2?.outputTokens, 2);
    assert.equal(accumulator.getText(), "Hello World");

    const finalUsage = accumulator.final();
    assert.equal(finalUsage?.inputTokens, 10);
    assert.equal(finalUsage?.outputTokens, 2);
  });

  it("provides a benchmark spec", () => {
    const spec = getBenchmarkSpec();
    assert.equal(spec.body.model, "deepseek-v4-flash-free");
    const raw = JSON.stringify({
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    assert.equal(spec.parseText(raw), "OK");
    assert.equal(spec.parseUsage(raw)?.outputTokens, 1);
  });

  it("fetches quota pool status", async () => {
    const account: AccountRuntime = {
      config: {
        email: "test@opencode.ai",
        credentials: [{ provider: OPENCODE_ZEN_PROVIDER_ID, apiKey: "valid-key" }],
      },
      accessToken: null,
      tokenExpires: 0,
      requestsSinceRotation: 0,
      totalRequests: 0,
      cooldownsByModel: {},
      quotaExhaustedAt: 0,
      quota: [],
      lastQuotaPoll: 0,
      lastUsed: 0,
      lastError: null,
      consecutiveErrors: 0,
      disabled: false,
      flagged: false,
      inFlightRequests: 0,
      inFlightByModel: {},
      allowFreshWindowStartsOverride: false,
      dailyRequestCount: 0,
      dailyRequestDay: "2026-08-12",
      healthScore: 100,
      tokenBucket: { tokens: 10, lastRefillAt: Date.now() },
    };

    const ctx: QuotaFetchContext = {
      log: () => {},
      markFlagged: () => {},
      reportQuotaPollFlag: () => {},
    };

    // Global fetch mock for testing
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr === OPENCODE_ZEN_MODELS_URL) {
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      await fetchOpenCodeZenQuota(account, ctx);
      assert.equal(account.quota.length, 1);
      assert.equal(account.quota[0].providerId, OPENCODE_ZEN_PROVIDER_ID);
      assert.equal(account.quota[0].displayName, "OpenCode");
      assert.equal(account.quota[0].percentRemaining, 100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses OpenAI JSON response correctly", () => {
    const rawJson = JSON.stringify({
      id: "chatcmpl-123",
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from DeepSeek!",
            reasoning_content: "Thinking step 1",
          },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
      },
    });

    const parsed = parseOpenAiJson(rawJson);
    assert.equal(parsed.text, "Hello from DeepSeek!");
    assert.equal(parsed.thinkingText, "Thinking step 1");
    assert.equal(parsed.inputTokens, 15);
    assert.equal(parsed.outputTokens, 5);
    assert.equal(parsed.responseId, "chatcmpl-123");
  });

  it("parses SSE fallback in parseOpenAiJson if raw response contains SSE lines", () => {
    const rawSse =
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hello world!"}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n' +
      'data: [DONE]\n\n';

    const parsed = parseOpenAiJson(rawSse);
    assert.equal(parsed.text, "Hello world!");
    assert.equal(parsed.thinkingText, "Thinking...");
    assert.equal(parsed.inputTokens, 10);
    assert.equal(parsed.outputTokens, 4);
  });

  it("parses SSE tool_calls across split chunks in parseOpenAiJson", () => {
    const rawSse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-webfetch-123","type":"function","function":{"name":"WebFetch","arguments":""}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"url\\":\\"https://example.com\\"}"}}]}}]}\n\n' +
      'data: [DONE]\n\n';

    const parsed = parseOpenAiJson(rawSse);
    assert.ok(parsed.toolCalls);
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].id, "call-webfetch-123");
    assert.equal(parsed.toolCalls[0].function.name, "WebFetch");
    assert.equal(parsed.toolCalls[0].function.arguments, '{"url":"https://example.com"}');
  });

  it("converts Anthropic messages request to OpenAI chat request", () => {
    const anthropicReq = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user" as const, content: "Hi" }],
      system: "You are helpful",
      max_tokens: 100,
    };

    const converted = anthropicToOpenAIChatRequest(anthropicReq);
    assert.equal(converted.model, "deepseek-v4-flash-free");
    assert.equal(converted.messages.length, 2);
    assert.equal(converted.messages[0].role, "system");
    assert.equal(converted.messages[0].content, "You are helpful");
    assert.equal(converted.messages[1].role, "user");
    assert.equal(converted.messages[1].content, "Hi");
  });
});
