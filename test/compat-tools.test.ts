import { describe, it } from "node:test";
import assert from "node:assert";
import { openAIToAntigravityBody, parseAntigravitySse, type OpenAIChatCompletionRequest } from "../src/compat.js";

describe("OpenAI Compat Tool Calling", () => {
	it("converts basic messages without tools to multi-turn format", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "You are a helpful assistant" },
				{ role: "user", content: "Hello" }
			]
		};

		const result = openAIToAntigravityBody(req);
		assert.strictEqual(result.requestType, "agent");
		assert.strictEqual(result.model, "claude-sonnet-4-6");
		
		const request = result.request as any;
		assert.strictEqual(request.systemInstruction.role, "system");
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

	it("sanitizes tool schemas before forwarding upstream", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "compact this" }],
			tools: [
				{
					type: "function",
					function: {
						name: "complex_schema",
						description: "schema cleanup",
						parameters: {
							type: "object",
							properties: {
								items: {
									type: "array",
									items: { type: "string" }
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		assert.equal(request.tools[0].functionDeclarations[0].name, "complex_schema");
		assert.ok(request.tools[0].functionDeclarations[0].parameters);
	});

	it("converts multi-turn conversation with tool calls and tool responses", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
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
			{ role: "model", parts: [{ functionCall: { id: "call_123", name: "get_weather", args: { location: "NYC" } } }] },
			{ role: "user", parts: [{ functionResponse: { id: "call_123", name: "get_weather", response: { temp: 72 } } }] }
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

	it("summarizes tool history when a Gemini thinking turn has no cached signature", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "gemini-3.5-flash-high",
			messages: [
				{ role: "user", content: "Find the weather" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_missing_sig", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Quito\"}" } }]
				},
				{ role: "tool", name: "get_weather", tool_call_id: "call_missing_sig", content: "{\"temp\":18}" }
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		assert.match(JSON.stringify(request.contents), /Context: The assistant used tools/);
	});

	it("collapses anyOf/oneOf/allOf to first variant for Claude model schemas", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "test_tool",
						parameters: {
							type: "object",
							properties: {
								value: {
									anyOf: [
										{ type: "string", minLength: 3 },
										{ type: "number" }
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const valueParam = request.tools[0].functionDeclarations[0].parameters.properties.value;
		assert.strictEqual(valueParam.type, "string");
		assert.strictEqual(valueParam.minLength, 3);
		assert.strictEqual(valueParam.anyOf, undefined);
	});

	it("converts anyOf with null variant to nullable:true (lossless)", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "nullable_tool",
						parameters: {
							type: "object",
							properties: {
								name: {
									anyOf: [
										{ type: "string" },
										{ type: "null" }
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const nameParam = request.tools[0].functionDeclarations[0].parameters.properties.name;
		assert.strictEqual(nameParam.type, "string");
		assert.strictEqual(nameParam.nullable, true);
		assert.strictEqual(nameParam.anyOf, undefined);
	});

	it("deep merges allOf variants for Claude schemas (lossless)", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "allof_tool",
						parameters: {
							type: "object",
							allOf: [
								{
									type: "object",
									properties: { a: { type: "string" } },
									required: ["a"]
								},
								{
									type: "object",
									properties: { b: { type: "number" } },
									required: ["b"]
								}
							]
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const params = request.tools[0].functionDeclarations[0].parameters;
		assert.strictEqual(params.allOf, undefined);
		assert.deepStrictEqual(params.properties, {
			a: { type: "string" },
			b: { type: "number" }
		});
		assert.deepStrictEqual(params.required.sort(), ["a", "b"]);
	});

	it("merges anyOf object variants into union of properties", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "union_tool",
						parameters: {
							type: "object",
							properties: {
								event: {
									anyOf: [
										{
											type: "object",
											properties: {
												kind: { type: "string" },
												data: { type: "string" }
											},
											required: ["kind", "data"]
										},
										{
											type: "object",
											properties: {
												kind: { type: "string" },
												error: { type: "string" }
											},
											required: ["kind", "error"]
										}
									]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const eventParam = request.tools[0].functionDeclarations[0].parameters.properties.event;
		assert.strictEqual(eventParam.type, "object");
		assert.strictEqual(eventParam.anyOf, undefined);
		// All properties from all variants should be present
		assert.ok(eventParam.properties.kind);
		assert.ok(eventParam.properties.data);
		assert.ok(eventParam.properties.error);
		// Only "kind" is required in ALL variants
		assert.deepStrictEqual(eventParam.required, ["kind"]);
	});

	it("collapses inline union type arrays to first non-null type and sets nullable:true", () => {
		const req: OpenAIChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "union_tool",
						parameters: {
							type: "object",
							properties: {
								id: {
									type: ["number", "null"]
								},
								name: {
									type: ["string", "number"]
								}
							}
						}
					}
				}
			]
		};

		const result = openAIToAntigravityBody(req);
		const request = result.request as any;
		const idParam = request.tools[0].functionDeclarations[0].parameters.properties.id;
		assert.strictEqual(idParam.type, "number");
		assert.strictEqual(idParam.nullable, true);

		const nameParam = request.tools[0].functionDeclarations[0].parameters.properties.name;
		assert.strictEqual(nameParam.type, "string");
		assert.strictEqual(nameParam.nullable, undefined);
	});
});

