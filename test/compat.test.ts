import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	anthropicToAntigravityBody,
	openAIToAntigravityBody,
	parseAntigravitySse,
	validateAnthropicMessagesRequest,
	validateOpenAIChatCompletionRequest,
} from "../src/compat.js";

describe("compat adapters", () => {
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

	it("converts OpenAI messages into Antigravity request body", () => {
		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		assert.equal(body.requestType, "agent");
		assert.match(JSON.stringify(body.request), /System: be terse/);
		assert.match(JSON.stringify(body.request), /User: ping/);
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

	it("converts Anthropic messages into Antigravity request body", () => {
		const body = anthropicToAntigravityBody({
			model: "gemini-3-flash",
			system: "policy",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});
		assert.equal(body.model, "gemini-3-flash");
		assert.match(JSON.stringify(body.request), /System: policy/);
		assert.match(JSON.stringify(body.request), /User: hello/);
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
});
