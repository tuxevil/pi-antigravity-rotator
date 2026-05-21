import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	anthropicToAntigravityBody,
	normalizeOpenAIResponsesRequest,
	normalizeAnthropicMessagesRequest,
	normalizeOpenAIChatCompletionRequest,
	openAIToAntigravityBody,
	parseAntigravitySse,
	resetResponsesStoreForTests,
	validateAnthropicMessagesRequest,
	validateOpenAIChatCompletionRequest,
	validateOpenAIResponsesRequest,
} from "../src/compat.js";

describe("compat adapters", () => {
	it("normalizes OpenAI Responses prompt into input", () => {
		const normalized = normalizeOpenAIResponsesRequest({
			model: "gemini-3.5-flash",
			prompt: "ping",
		}) as { input: unknown };
		assert.equal(normalized.input, "ping");
	});

	it("validates OpenAI Responses contract", () => {
		const result = validateOpenAIResponsesRequest({
			model: "gemini-3-flash",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			instructions: "be terse",
			max_output_tokens: 64,
			reasoning: { effort: "medium" },
			tools: [{ type: "function", function: { name: "lookup" } }],
		});
		assert.equal(result.ok, true);
	});

	it("rejects unsupported Responses built-in tools", () => {
		const result = validateOpenAIResponsesRequest({
			model: "gemini-3-flash",
			input: "hello",
			tools: [{ type: "web_search" }],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("; "), /only function tools are supported/);
	});

	it("validates OpenAI chat completion contract", () => {
		const result = validateOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "hello" }],
			stream: false,
		});
		assert.equal(result.ok, true);
	});

	it("rejects malformed OpenAI chat completion contract", () => {
		const result = validateOpenAIChatCompletionRequest({ model: "", messages: "nope" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("; "), /model/);
	});

	it("normalizes OpenAI Responses-style input into chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.5-flash",
			input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: [{ type: "text", text: "ping" }] }]);
	});

	it("normalizes native Antigravity contents into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			request: {
				contents: [{ role: "user", parts: [{ text: "hola" }] }],
			},
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: "hola" }]);
	});

	it("normalizes loose non-array messages into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.5-flash-high",
			messages: { role: "user", content: [{ type: "input_text", text: "hola" }] },
		});
		const result = validateOpenAIChatCompletionRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value.messages, [{ role: "user", content: [{ type: "text", text: "hola" }] }]);
	});

	it("converts OpenAI messages into Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		const bodyStr = JSON.stringify(body);
		assert.match(bodyStr, /"project":"compat-placeholder"/);
		assert.match(bodyStr, /"userAgent":"antigravity"/);
		assert.match(bodyStr, /"requestType":"agent"/);
		assert.match(bodyStr, /"systemInstruction":{"role":"system","parts":\[{"text":"be terse"}\]}/);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"ping"}\]}\]/);
	});

	it("validates Anthropic messages contract", () => {
		const result = validateAnthropicMessagesRequest({
			model: "claude-sonnet-4-6",
			system: "be terse",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 128,
		});
		assert.equal(result.ok, true);
	});

	it("normalizes native Antigravity contents into Anthropic messages", () => {
		const normalized = normalizeAnthropicMessagesRequest({
			model: "claude-opus-4-6-thinking",
			request: {
				systemInstruction: { role: "system", parts: [{ text: "be terse" }] },
				contents: [{ role: "user", parts: [{ text: "hello" }] }],
			},
		});
		const result = validateAnthropicMessagesRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.value.messages, [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "hello" },
			]);
		}
	});

	it("converts Anthropic messages into Antigravity request body", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			system: "policy",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		const bodyStr = JSON.stringify(body);
		assert.match(bodyStr, /"model":"claude-sonnet-4-6"/);
		assert.match(bodyStr, /"userAgent":"antigravity"/);
		assert.match(bodyStr, /"systemInstruction":{"role":"system","parts":\[{"text":"policy"}\]}/);
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"hello"}\]}\]/);
	});

	it("converts OpenAI data URL images into Antigravity inlineData", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
				],
			}],
		});
		assert.match(JSON.stringify(body.request), /"inlineData"/);
		assert.match(JSON.stringify(body.request), /"mimeType":"image\/png"/);
		assert.match(JSON.stringify(body.request), /"data":"abc123"/);
	});

	it("converts Anthropic base64 images into Antigravity inlineData", () => {
		const body = anthropicToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "def456" } },
				],
			}],
		});
		assert.match(JSON.stringify(body.request), /"inlineData"/);
		assert.match(JSON.stringify(body.request), /"mimeType":"image\/jpeg"/);
		assert.match(JSON.stringify(body.request), /"data":"def456"/);
	});

	it("strips cache_control fields from OpenAI content blocks", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "hello", cache_control: { type: "ephemeral" } } as never,
				],
			}],
		});
		assert.doesNotMatch(JSON.stringify(body.request), /cache_control/);
	});

	it("parses Antigravity SSE into a compat completion", () => {
		const parsed = parseAntigravitySse([
			'data: {"response":{"responseId":"abc","candidates":[{"content":{"parts":[{"text":"hel"}]}}]}}',
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}',
			"",
		].join("\n"));
		assert.equal(parsed.text, "hello");
		assert.equal(parsed.inputTokens, 3);
		assert.equal(parsed.outputTokens, 2);
		assert.equal(parsed.responseId, "abc");
	});

	it("handles empty SSE payloads without crashing", () => {
		const parsed = parseAntigravitySse("");
		assert.equal(parsed.text, "");
		assert.equal(parsed.inputTokens, 0);
		assert.equal(parsed.outputTokens, 0);
	});

	it("accepts model role in messages", () => {
		const result = validateOpenAIChatCompletionRequest({
			model: "gemini-3-flash",
			messages: [{ role: "model", content: "hello" }],
			stream: false,
		});
		assert.equal(result.ok, true);
	});

	it("converts model role to model in Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "model", content: "hi there" },
			],
		});
		const reqStr = JSON.stringify(body.request);
		assert.match(reqStr, /"contents":\[{"role":"user","parts":\[{"text":"hello"}\]},{"role":"model","parts":\[{"text":"hi there"}\]}\]/);
	});

	it("converts Responses function_call input items into assistant tool call history", () => {
		resetResponsesStoreForTests();
		const normalized = normalizeOpenAIResponsesRequest({
			model: "claude-sonnet-4-6",
			input: [
				{ type: "function_call", call_id: "call_123", name: "lookup", arguments: { q: "pi" } },
				{ type: "function_call_output", call_id: "call_123", output: { result: "3.14" } },
			],
		});
		const result = validateOpenAIResponsesRequest(normalized);
		assert.equal(result.ok, true);
		if (result.ok) {
			const body = openAIToAntigravityBody({
				model: result.value.model,
				messages: [
					{ role: "assistant", content: null, tool_calls: [{ id: "call_123", type: "function", function: { name: "lookup", arguments: "{\"q\":\"pi\"}" } }] },
					{ role: "tool", content: "{\"result\":\"3.14\"}", tool_call_id: "call_123", name: "lookup" },
				],
			});
			assert.match(JSON.stringify(body.request), /"functionCall"/);
			assert.match(JSON.stringify(body.request), /"functionResponse"/);
		}
	});
});
