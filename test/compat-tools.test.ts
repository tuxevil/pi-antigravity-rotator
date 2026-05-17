import { describe, it } from "node:test";
import assert from "node:assert";
import { openAIToAntigravityBody, parseAntigravitySse, type OpenAIChatCompletionRequest } from "../src/compat.js";

describe("OpenAI Compat Tool Calling", () => {
	it("converts basic messages without tools to multi-turn format", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [
				{ role: "system", content: "You are a helpful assistant" },
				{ role: "user", content: "Hello" }
			]
		};

		const result = openAIToAntigravityBody(req);
		assert.strictEqual(result.requestType, "agent");
		assert.strictEqual(result.model, "gemini-3-flash");
		
		const request = result.request as any;
		assert.strictEqual(request.systemInstruction.role, "user");
		assert.strictEqual(request.systemInstruction.parts[0].text, "You are a helpful assistant");
		assert.deepStrictEqual(request.contents, [
			{ role: "user", parts: [{ text: "Hello" }] }
		]);
		assert.strictEqual(request.tools, undefined);
	});

	it("converts tools to Gemini functionDeclarations", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "What is the weather?" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get the current weather",
						parameters: { type: "object", properties: { location: { type: "string" } } }
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		
		assert.deepStrictEqual(request.tools, [{
			functionDeclarations: [
				{
					name: "get_weather",
					description: "Get the current weather",
					parameters: { type: "object", properties: { location: { type: "string" } } }
				}
			]
		}]);
	});

	it("converts multi-turn conversation with tool calls and tool responses", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [
				{ role: "user", content: "What is the weather in NYC?" },
				{ 
					role: "assistant", 
					content: null, 
					tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: "{\"location\": \"NYC\"}" } }]
				},
				{ role: "tool", name: "get_weather", tool_call_id: "call_123", content: "{\"temp\": 72}" }
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;

		assert.deepStrictEqual(request.contents, [
			{ role: "user", parts: [{ text: "What is the weather in NYC?" }] },
			{ role: "model", parts: [{ functionCall: { name: "get_weather", args: { location: "NYC" } } }] },
			{ role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: 72 } } }] }
		]);
	});

	it("converts tool_choice appropriately", () => {
		const testChoice = (tool_choice: unknown, expectedMode: string, expectedNames?: string[]) => {
			const req: OpenAIChatCompletionRequest = {
				model: "gemini-3-flash",
				messages: [{ role: "user", content: "Hi" }],
				tool_choice
			};
			const result = openAIToAntigravityBody(req);
			const request = result.request as any;
			assert.strictEqual(request.toolConfig.functionCallingConfig.mode, expectedMode);
			if (expectedNames) {
				assert.deepStrictEqual(request.toolConfig.functionCallingConfig.allowedFunctionNames, expectedNames);
			} else {
				assert.strictEqual(request.toolConfig.functionCallingConfig.allowedFunctionNames, undefined);
			}
		};

		testChoice("none", "NONE");
		testChoice("auto", "AUTO");
		testChoice("required", "AUTO");
		testChoice({ type: "function", function: { name: "get_weather" } }, "ANY", ["get_weather"]);
	});

	it("parses Gemini SSE functionCall into OpenAI tool_calls", () => {
		const rawSse = `data: {"response": {"candidates": [{"content": {"parts": [{"functionCall": {"name": "get_weather", "args": {"location": "London"}}}]}}]}}

data: [DONE]

`;
		const result = parseAntigravitySse(rawSse);
		assert.strictEqual(result.text, "");
		assert.ok(result.toolCalls);
		assert.strictEqual(result.toolCalls.length, 1);
		
		const tc = result.toolCalls[0];
		assert.strictEqual(tc.type, "function");
		assert.strictEqual(tc.function.name, "get_weather");
		assert.strictEqual(tc.function.arguments, '{"location":"London"}');
		assert.ok(tc.id.startsWith("call_"));
	});
});
