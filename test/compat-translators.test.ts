import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	openAIToAntigravityBody,
	anthropicToAntigravityBody,
	normalizeOpenAIChatCompletionRequest,
	normalizeOpenAIResponsesRequest,
} from "../src/compat/translators.js";

describe("translators component", () => {
	it("normalizes OpenAI Responses prompt into input", () => {
		const normalized = normalizeOpenAIResponsesRequest({
			model: "gemini-3.5-flash",
			prompt: "ping",
		}) as { input: unknown };
		assert.equal(normalized.input, "ping");
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
		assert.equal(body.project, "compat-placeholder");
		assert.equal(body.userAgent, "antigravity");
		assert.equal(body.requestType, "agent");
		assert.deepEqual(body.request.systemInstruction, {
			role: "system",
			parts: [{ text: "be terse" }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "ping" }] },
		]);
	});

	it("converts Anthropic messages into Antigravity request body", () => {
		const body = anthropicToAntigravityBody({
			model: "claude-sonnet-4-6",
			system: "be polite",
			messages: [
				{ role: "user", content: "hello" },
			],
		});
		assert.equal(body.model, "claude-sonnet-4-6");
		assert.deepEqual(body.request.systemInstruction, {
			role: "system",
			parts: [{ text: "be polite" }],
		});
		assert.deepEqual(body.request.contents, [
			{ role: "user", parts: [{ text: "hello" }] },
		]);
	});

	it("normalizes loose non-array messages into OpenAI chat messages", () => {
		const normalized = normalizeOpenAIChatCompletionRequest({
			model: "gemini-3.5-flash-high",
			messages: { role: "user", content: [{ type: "input_text", text: "hola" }] },
		}) as { messages: unknown[] };
		assert.deepEqual(normalized.messages, [
			{ role: "user", content: [{ type: "text", text: "hola" }] },
		]);
	});
});
