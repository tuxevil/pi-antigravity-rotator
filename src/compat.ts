import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { logger } from "./logger.js";
import type { AccountRotator } from "./rotator.js";
import { resolveQuotaModelKey } from "./types.js";
import { withRotation, flattenHeaders, type RequestBody } from "./proxy.js";


const compatLogger = logger.child("compat");

export interface ChatMessage {
	role: "system" | "developer" | "user" | "assistant" | "model" | "tool";
	content: string | Array<{ type: string; text?: string;[key: string]: unknown }> | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIToolChoice {
	type: "function";
	function: { name: string };
}

// Gemini function calling types
interface GeminiFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface GeminiToolConfig {
	functionCallingConfig: {
		mode: "AUTO" | "NONE" | "ANY";
		allowedFunctionNames?: string[];
	};
}

export interface OpenAIChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	prompt?: string | string[];
	input?: unknown;
	tools?: OpenAITool[];
	tool_choice?: unknown;
	/** OpenAI-style reasoning effort. Mapped to Gemini thinkingLevel. */
	reasoning_effort?: string;
	[key: string]: unknown;
}

export interface OpenAIResponsesRequest {
	model: string;
	input?: unknown;
	instructions?: string | Array<{ type: string; text?: string;[key: string]: unknown }> | null;
	stream?: boolean;
	temperature?: number;
	max_output_tokens?: number;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: unknown;
	reasoning?: { effort?: string | null;[key: string]: unknown } | null;
	metadata?: Record<string, string>;
	store?: boolean;
	previous_response_id?: string | null;
	conversation?: unknown;
	parallel_tool_calls?: boolean;
	[key: string]: unknown;
}

export interface AnthropicMessagesRequest {
	model: string;
	messages: ChatMessage[];
	system?: string | Array<{ type: string; text?: string;[key: string]: unknown }>;
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	[key: string]: unknown;
}

export interface CompatCompletion {
	text: string;
	thinkingText?: string; // Gemini thought blocks (thought: true), emitted as reasoning_content
	inputTokens: number;
	outputTokens: number;
	responseId?: string;
	toolCalls?: OpenAIToolCall[];
}

interface ResponseOutputText {
	type: "output_text";
	text: string;
	annotations: unknown[];
}

interface ResponseMessageOutputItem {
	id: string;
	type: "message";
	status: "completed";
	role: "assistant";
	content: ResponseOutputText[];
}

interface ResponseFunctionCallOutputItem {
	id: string;
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
}

type ResponseOutputItem = ResponseMessageOutputItem | ResponseFunctionCallOutputItem;

interface StoredResponseEntry {
	response: Record<string, unknown>;
	inputItems: Array<Record<string, unknown>>;
	conversationMessages: ChatMessage[];
	callIdToName: Map<string, string>;
	expiresAt: number;
}

// ---------------------------------------------------------------------------
// Model-specific specs — mirrors Antigravity-Manager model_specs.json
// ---------------------------------------------------------------------------
interface ModelSpec {
	maxOutputTokens: number;
	thinkingBudget: number; // -1 = adaptive (model decides), >=0 = fixed
	isThinking: boolean;
}
const MODEL_SPECS: Record<string, ModelSpec> = {
	"gemini-pro-agent":          { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true },
	"gemini-3-flash-agent":      { maxOutputTokens: 65536, thinkingBudget: 10000, isThinking: true },
	"gemini-3-pro-high":         { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true },
	"gemini-3-pro-low":          { maxOutputTokens: 65535, thinkingBudget: 1001,  isThinking: true },
	"gemini-3.1-pro":            { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true },
	"gemini-3.1-pro-high":       { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true },
	"gemini-3.1-pro-low":        { maxOutputTokens: 65535, thinkingBudget: 1001,  isThinking: true },
	"gemini-3.1-pro-preview":    { maxOutputTokens: 65535, thinkingBudget: 10001, isThinking: true },
	"gemini-3.5-flash":          { maxOutputTokens: 65536, thinkingBudget: 10000, isThinking: true },
	"gemini-3.5-flash-medium":   { maxOutputTokens: 65536, thinkingBudget: 4000,  isThinking: true },
	"gemini-3.5-flash-low":      { maxOutputTokens: 65536, thinkingBudget: 4000,  isThinking: true },
	"gemini-3.5-flash-high":     { maxOutputTokens: 65536, thinkingBudget: 10000, isThinking: true },
	"gemini-3-flash":            { maxOutputTokens: 65536, thinkingBudget: 4000,  isThinking: true },
	"gemini-2.5-flash":          { maxOutputTokens: 65535, thinkingBudget: 24576, isThinking: true },
	"gemini-2.5-pro":            { maxOutputTokens: 65535, thinkingBudget: 1024,  isThinking: true },
	"claude-sonnet-4-6":         { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true },
	"claude-sonnet-4-6-thinking":{ maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true },
	"claude-opus-4-6-thinking":  { maxOutputTokens: 64000, thinkingBudget: 32768, isThinking: true },
	"gpt-oss-120b-medium":       { maxOutputTokens: 32768, thinkingBudget: 8192,  isThinking: true },
	"gpt-oss-120b":              { maxOutputTokens: 32768, thinkingBudget: 8192,  isThinking: true },
};
const GEMINI_MAX_OUTPUT_TOKENS = 65536;
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;
const FALLBACK_THINKING_BUDGET = 24576;
const CLAUDE_DEFAULT_THINKING_BUDGET = 32768;

function getModelFamily(model: string): "claude" | "gemini" | "unknown" {
	const l = model.toLowerCase();
	if (l.includes("claude")) return "claude";
	if (l.includes("gemini")) return "gemini";
	return "unknown";
}

function getModelSpec(model: string): ModelSpec {
	const lower = model.toLowerCase();
	if (MODEL_SPECS[lower]) return MODEL_SPECS[lower];
	for (const [key, spec] of Object.entries(MODEL_SPECS)) {
		if (lower.includes(key)) return spec;
	}
	const family = getModelFamily(model);
	if (family === "claude") return { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS, thinkingBudget: CLAUDE_DEFAULT_THINKING_BUDGET, isThinking: true };
	if (family === "gemini") return { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, thinkingBudget: FALLBACK_THINKING_BUDGET, isThinking: true };
	return { maxOutputTokens: 65536, thinkingBudget: FALLBACK_THINKING_BUDGET, isThinking: false };
}

function isThinkingModel(model: string): boolean {
	const spec = getModelSpec(model);
	if (spec.isThinking) return true;
	const l = model.toLowerCase();
	if (l.includes("gemini")) {
		const m = l.match(/gemini-(\d+)/);
		if (m && parseInt(m[1], 10) >= 3) return true;
	}
	return false;
}

type AntigravityPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * In-memory cache for Gemini `thoughtSignature` values keyed by the OpenAI
 * tool-call ID we assign. Gemini 3 models require this signature to be
 * re-submitted with any `functionCall` part that appears in the *current turn*
 * of a multi-turn conversation. Because the OpenAI wire format has no field
 * for this, we cache it server-side and transparently re-inject it when the
 * client replays its history.
 *
 * Keys are unique per call (timestamp + counter) so there are no cross-session
 * collisions even under heavy concurrent load. Entries older than the rolling
 * window (max 500) are evicted automatically.
 */
const thoughtSignatureCache = new Map<string, string>();
const THOUGHT_SIGNATURE_CACHE_MAX = 500;
const RESPONSES_STORE_TTL_MS = 6 * 60 * 60 * 1000;
const RESPONSES_STORE_MAX = 500;
const responsesStore = new Map<string, StoredResponseEntry>();

function makeCompatId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function pruneResponsesStore(now = Date.now()): void {
	for (const [id, entry] of responsesStore) {
		if (entry.expiresAt <= now) responsesStore.delete(id);
	}
	while (responsesStore.size > RESPONSES_STORE_MAX) {
		const oldest = responsesStore.keys().next();
		if (oldest.done) break;
		responsesStore.delete(oldest.value);
	}
}

function getStoredResponse(id: string): StoredResponseEntry | null {
	pruneResponsesStore();
	return responsesStore.get(id) || null;
}

function setStoredResponse(id: string, entry: StoredResponseEntry): void {
	pruneResponsesStore();
	responsesStore.set(id, entry);
	pruneResponsesStore();
}

export function resetResponsesStoreForTests(): void {
	responsesStore.clear();
}

function cacheThoughtSignature(callId: string, signature: string): void {
	if (thoughtSignatureCache.size >= THOUGHT_SIGNATURE_CACHE_MAX) {
		// Evict the oldest entry
		const firstKey = thoughtSignatureCache.keys().next().value;
		if (firstKey !== undefined) thoughtSignatureCache.delete(firstKey);
	}
	thoughtSignatureCache.set(callId, signature);
}

/**
 * Strip cache_control fields from content blocks.
 * Cloud Code API rejects cache_control with "Extra inputs are not permitted".
 */
function cleanCacheControl<T>(content: T): T {
	if (!Array.isArray(content)) return content;
	return content.map((block: Record<string, unknown>) => {
		if (!block || typeof block !== "object") return block;
		if ("cache_control" in block) {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { cache_control: _cc, ...rest } = block;
			return rest;
		}
		return block;
	}) as T;
}

function extractText(content: ChatMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return cleanCacheControl(content)
		.filter((p: { type?: string; text?: string; thinking?: string }) => (p.type === "text" && typeof p.text === "string") || (p.type === "thinking" && typeof p.thinking === "string"))
		.map((p: { type?: string; text?: string; thinking?: string }) => p.type === "thinking" ? `[Thinking]\n${p.thinking}\n[/Thinking]` : (p.text as string))
		.join("\n");
}

function dataUrlToInlineData(url: string): AntigravityPart | null {
	const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
	if (!match) return null;
	return { inlineData: { mimeType: match[1], data: match[2] } };
}

function extractParts(content: ChatMessage["content"]): AntigravityPart[] {
	if (content === null) return [];
	if (typeof content === "string") return content ? [{ text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: AntigravityPart[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string" && part.text) {
			parts.push({ text: part.text });
			continue;
		}
		if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
			parts.push({ text: `[Thinking]\n${part.thinking}\n[/Thinking]` });
			continue;
		}
		if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
			const inline = dataUrlToInlineData(part.image_url.url);
			if (inline) parts.push(inline);
			continue;
		}
		if (part.type === "image" && isRecord(part.source) && part.source.type === "base64" && typeof part.source.media_type === "string" && typeof part.source.data === "string") {
			parts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
		}
	}
	return parts;
}

/**
 * Gemini's function_declarations accept a restricted subset of JSON Schema.
 * Keywords like `const`, `$schema`, `$ref`, `$defs`, `if/then/else`, `not`,
 * `patternProperties`, etc. are not supported and will cause a 400.
 * This function recursively strips those unsupported keywords.
 */
function sanitizeGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	// Keywords Gemini does not support
	const UNSUPPORTED = new Set([
		"const", "$schema", "$id", "$ref", "$defs", "definitions",
		"if", "then", "else", "not",
		"patternProperties", "unevaluatedProperties", "unevaluatedItems",
		"contentEncoding", "contentMediaType", "examples",
		"exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum",
		"multipleOf", "minLength", "maxLength", "pattern",
		"minItems", "maxItems", "uniqueItems",
		"minProperties", "maxProperties", "title", "default",
	]);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED.has(key)) continue;

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value)) {
				// Special case: all items are pure {const: value} — this is the
				// JSON Schema way of writing an enum. Convert to Gemini's `enum` array.
				const allConst = value.every(
					(item) => isRecord(item) && Object.keys(item).length === 1 && "const" in item,
				);
				if (allConst) {
					out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
					// Infer type:string when all const values are strings (covers most tool params)
					if (value.every((item) => typeof (item as Record<string, unknown>)["const"] === "string")) {
						if (!out["type"]) out["type"] = "string";
					}
				} else {
					const cleaned = value.map(sanitizeGeminiSchema).filter(
						// Drop entries that become empty objects after sanitisation
						(v) => isRecord(v) && Object.keys(v).length > 0,
					);
					// If only one variant remains, unwrap it (Gemini prefers flat schemas)
					if (cleaned.length === 1) {
						Object.assign(out, cleaned[0]);
					} else if (cleaned.length > 1) {
						out[key] = cleaned;
					}
					// cleaned.length === 0: skip entirely
				}
			}
			continue;
		}


		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, sanitizeGeminiSchema(v)]),
			);
			continue;
		}

		if (key === "items") {
			out[key] = sanitizeGeminiSchema(value);
			continue;
		}

		out[key] = isRecord(value) ? sanitizeGeminiSchema(value) : value;
	}
	return out;
}

/**
 * Lighter sanitization for Claude models routed through Gemini's API.
 * Gemini's outer API still validates schemas before routing to Claude, so
 * we must remove fields Gemini's protobuf doesn't know about (like `const`,
 * `$ref`, etc.). However, unlike the Gemini-native sanitizer, we KEEP
 * standard JSON Schema Draft 2020-12 keywords (minimum, maximum, pattern,
 * etc.) that Claude requires and that Gemini's API does pass through.
 */
function sanitizeClaudeViaGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	// Only remove fields that Gemini's API layer truly rejects at the network level.
	// We keep standard Draft 2020-12 keywords but must strip exclusiveMinimum/exclusiveMaximum
	// as boolean values (Draft 4) — the API layer rejects them even for Claude-bound requests.
	const UNSUPPORTED = new Set([
		"$schema", "$id", "$ref", "$defs", "definitions",
		"if", "then", "else", "not",
		"patternProperties", "unevaluatedProperties", "unevaluatedItems",
		"contentEncoding", "contentMediaType",
		// Gemini's protobuf layer rejects these regardless of target model
		"exclusiveMinimum", "exclusiveMaximum",
	]);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED.has(key)) continue;

		// `const` is not supported by Gemini's API — convert to a single-value enum
		if (key === "const") {
			out["enum"] = [value];
			continue;
		}

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value)) {
				// Case 1: all items are pure {const: value} — convert to flat enum.
				const allPureConst = value.every(
					(item) => isRecord(item) && Object.keys(item).length === 1 && "const" in item,
				);
				if (allPureConst) {
					out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
					if (value.every((item) => typeof (item as Record<string, unknown>)["const"] === "string")) {
						if (!out["type"]) out["type"] = "string";
					}
					continue;
				}

				// Case 2: all items are {type: T, const: V} (same type, each with a const).
				// e.g. [{type:"string",const:"fact"},{type:"string",const:"lesson"}]
				// Merge into a single flat {type: T, enum: [V1, V2, ...]} — avoids
				// the redundant anyOf-with-single-enum pattern that Claude rejects.
				const allTypeConst = value.every(
					(item) =>
						isRecord(item) &&
						Object.keys(item).length === 2 &&
						"type" in item &&
						"const" in item,
				);
				if (allTypeConst) {
					const firstType = (value[0] as Record<string, unknown>)["type"];
					const allSameType = value.every((item) => (item as Record<string, unknown>)["type"] === firstType);
					if (allSameType) {
						if (!out["type"]) out["type"] = firstType;
						out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
						continue;
					}
				}

				// Sanitize all variants first.
				const cleaned = value.map(sanitizeClaudeViaGeminiSchema).filter(
					(v) => isRecord(v) && Object.keys(v).length > 0,
				) as Record<string, unknown>[];

				if (cleaned.length === 0) {
					// All variants collapsed to nothing — skip entirely.
					continue;
				}

				// Case 3: nullable pattern — anyOf/oneOf with exactly one {type:"null"}
				// variant and one or more real variants. Convert to the real variant
				// with nullable:true. This is lossless — Gemini's proto supports nullable.
				// e.g. anyOf:[{type:"string"},{type:"null"}] → {type:"string",nullable:true}
				if (key !== "allOf") {
					const nullIdx = cleaned.findIndex((v) => v.type === "null" && Object.keys(v).length === 1);
					if (nullIdx !== -1) {
						const nonNull = cleaned.filter((_, i) => i !== nullIdx);
						if (nonNull.length === 1) {
							Object.assign(out, nonNull[0], { nullable: true });
							continue;
						}
						if (nonNull.length > 1) {
							// Multiple non-null variants + null → collapse non-null variants,
							// then mark nullable. Still lossy but preserves nullability.
							Object.assign(out, nonNull[0], { nullable: true });
							continue;
						}
					}
				}

				// Case 4: allOf — deep merge all variants (allOf = intersection).
				// Merging properties from all variants is semantically correct.
				if (key === "allOf") {
					const merged: Record<string, unknown> = {};
					let mergedProperties: Record<string, unknown> = {};
					let mergedRequired: string[] = [];
					for (const variant of cleaned) {
						for (const [vk, vv] of Object.entries(variant)) {
							if (vk === "properties" && isRecord(vv)) {
								mergedProperties = { ...mergedProperties, ...vv };
							} else if (vk === "required" && Array.isArray(vv)) {
								mergedRequired = [...new Set([...mergedRequired, ...vv])];
							} else {
								merged[vk] = vv;
							}
						}
					}
					if (Object.keys(mergedProperties).length > 0) merged["properties"] = mergedProperties;
					if (mergedRequired.length > 0) merged["required"] = mergedRequired;
					Object.assign(out, merged);
					continue;
				}

				// Case 5: anyOf/oneOf where all variants are objects with properties —
				// merge all properties together, making all optional (union of shapes).
				// This is mildly lossy (accepts wider input) but doesn't reject valid inputs.
				const allObjects = cleaned.every(
					(v) => v.type === "object" && isRecord(v.properties),
				);
				if (allObjects && cleaned.length > 1) {
					const unionProperties: Record<string, unknown> = {};
					for (const variant of cleaned) {
						const props = variant.properties as Record<string, unknown>;
						for (const [pk, pv] of Object.entries(props)) {
							if (!(pk in unionProperties)) unionProperties[pk] = pv;
						}
					}
					// Only keep required fields that exist in ALL variants
					const allRequired = cleaned.map((v) =>
						Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>(),
					);
					const commonRequired = [...allRequired[0]].filter((r) =>
						allRequired.every((s) => s.has(r)),
					);
					const base = { ...cleaned[0] };
					base["properties"] = unionProperties;
					if (commonRequired.length > 0) {
						base["required"] = commonRequired;
					} else {
						delete base["required"];
					}
					Object.assign(out, base);
					continue;
				}

				// Fallback: collapse to the first valid variant.
				// Gemini's Schema proto serialization corrupts complex anyOf/oneOf
				// during the round-trip to Claude, causing JSON Schema draft 2020-12
				// validation failures. Collapsing is lossy but functional — the tool
				// still works, just with a narrower accepted input type.
				Object.assign(out, cleaned[0]);
			}
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, sanitizeClaudeViaGeminiSchema(v)]),
			);
			continue;
		}

		if (key === "items") {
			out[key] = sanitizeClaudeViaGeminiSchema(value);
			continue;
		}

		out[key] = isRecord(value) ? sanitizeClaudeViaGeminiSchema(value) : value;
	}
	return out;
}

/** Convert OpenAI tools array to Gemini functionDeclarations */
function convertOpenAIToolsToGemini(tools: OpenAITool[], isClaude: boolean = false): { functionDeclarations: GeminiFunctionDeclaration[] }[] {
	const decls: GeminiFunctionDeclaration[] = tools
		.filter((t) => t.type === "function" && isNonEmptyString(t.function?.name))
		.map((t) => {
			const sanitized = t.function.parameters
				? (isClaude ? sanitizeClaudeViaGeminiSchema(t.function.parameters) : sanitizeGeminiSchema(t.function.parameters)) as Record<string, unknown>
				: undefined;
			return {
				name: t.function.name,
				...(t.function.description ? { description: t.function.description } : {}),
				...(sanitized ? { parameters: sanitized } : {}),
			};
		});
	return decls.length > 0 ? [{ functionDeclarations: decls }] : [];
}

/** Convert OpenAI tool_choice to Gemini toolConfig */
function convertToolChoiceToGemini(toolChoice: unknown): GeminiToolConfig | undefined {
	if (!toolChoice || toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
	if (toolChoice === "auto" || toolChoice === "required") return { functionCallingConfig: { mode: "AUTO" } };
	if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && isNonEmptyString(toolChoice.function.name)) {
		return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.function.name] } };
	}
	return { functionCallingConfig: { mode: "AUTO" } };
}

function validateMessages(value: unknown): value is ChatMessage[] {
	return Array.isArray(value) && value.every((msg) => {
		if (!isRecord(msg)) return false;
		if (!["system", "developer", "user", "assistant", "model", "tool"].includes(String(msg.role))) return false;
		return typeof msg.content === "string" || msg.content === null || Array.isArray(msg.content);
	});
}

function extractTextFromUnknownContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!isRecord(part)) return "";
			if (typeof part.text === "string") return part.text;
			if (typeof part.input_text === "string") return part.input_text;
			if (typeof part.output_text === "string") return part.output_text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function normalizeContentBlocks(content: unknown): ChatMessage["content"] {
	if (typeof content === "string" || content === null) return content;
	if (!Array.isArray(content)) return extractTextFromUnknownContent(content);
	const blocks = content.flatMap((part) => {
		if (typeof part === "string") return [{ type: "text", text: part }];
		if (!isRecord(part)) return [];
		if (part.type === "input_text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
		if (part.type === "output_text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
		if (typeof part.text === "string") return [{ ...part, type: typeof part.type === "string" ? part.type : "text", text: part.text }];
		if (typeof part.input_text === "string") return [{ type: "text", text: part.input_text }];
		if (typeof part.output_text === "string") return [{ type: "text", text: part.output_text }];
		if (part.type === "input_image" && typeof part.image_url === "string") {
			return [{ type: "image_url", image_url: { url: part.image_url } }];
		}
		return [part as { type: string; text?: string;[key: string]: unknown }];
	});
	return blocks.length > 0 ? blocks : "";
}

function normalizeInstructionsContent(content: OpenAIResponsesRequest["instructions"]): ChatMessage["content"] {
	if (typeof content === "string" || content === null || content === undefined) return content ?? "";
	return normalizeContentBlocks(content);
}

function contentToResponseInputBlocks(content: ChatMessage["content"], role: string): Array<Record<string, unknown>> {
	if (typeof content === "string") {
		if (!content) return [];
		return [{ type: role === "assistant" || role === "model" ? "output_text" : "input_text", text: content }];
	}
	if (!Array.isArray(content)) return [];
	return cleanCacheControl(content).flatMap((part) => {
		if (!isRecord(part)) return [];
		if (typeof part.text === "string") {
			return [{ type: role === "assistant" || role === "model" ? "output_text" : "input_text", text: part.text }];
		}
		if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
			return [{ type: "input_image", image_url: part.image_url.url }];
		}
		return [part];
	});
}

type ParsedResponsesInput = {
	inputItems: Array<Record<string, unknown>>;
	messages: ChatMessage[];
};

function parseResponsesInput(input: unknown, callIdToName: Map<string, string> = new Map()): ParsedResponsesInput {
	if (typeof input === "string") {
		return {
			inputItems: [{ id: makeCompatId("in"), type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
			messages: [{ role: "user", content: input }],
		};
	}
	if (!Array.isArray(input)) return { inputItems: [], messages: [] };

	const inputItems: Array<Record<string, unknown>> = [];
	const messages: ChatMessage[] = [];

	for (const rawItem of input) {
		if (typeof rawItem === "string") {
			inputItems.push({ id: makeCompatId("in"), type: "message", role: "user", content: [{ type: "input_text", text: rawItem }] });
			messages.push({ role: "user", content: rawItem });
			continue;
		}
		if (!isRecord(rawItem)) continue;

		if (rawItem.type === "function_call_output" && typeof rawItem.call_id === "string") {
			const outputText = typeof rawItem.output === "string" ? rawItem.output : JSON.stringify(rawItem.output ?? "");
			const toolName = typeof rawItem.name === "string" ? rawItem.name : (callIdToName.get(rawItem.call_id) || "unknown");
			inputItems.push({
				id: makeCompatId("in"),
				type: "function_call_output",
				call_id: rawItem.call_id,
				output: outputText,
			});
			messages.push({ role: "tool", content: outputText, name: toolName, tool_call_id: rawItem.call_id });
			continue;
		}

		if (rawItem.type === "function_call" && typeof rawItem.name === "string") {
			const callId = typeof rawItem.call_id === "string" ? rawItem.call_id : makeCompatId("call");
			const args = typeof rawItem.arguments === "string" ? rawItem.arguments : JSON.stringify(rawItem.arguments ?? {});
			inputItems.push({
				id: makeCompatId("in"),
				type: "function_call",
				call_id: callId,
				name: rawItem.name,
				arguments: args,
			});
			// Merge consecutive function_call items into a single assistant message
			// so Claude sees one assistant turn with multiple tool_calls rather than
			// separate assistant turns (which would each require their own tool_result).
			const lastMsg = messages[messages.length - 1];
			if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.tool_calls)) {
				lastMsg.tool_calls.push({ id: callId, type: "function", function: { name: rawItem.name, arguments: args } });
			} else {
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [{ id: callId, type: "function", function: { name: rawItem.name, arguments: args } }],
				});
			}
			continue;
		}

		const isMessage = rawItem.type === "message" || typeof rawItem.role === "string" || "content" in rawItem;
		if (!isMessage) continue;
		const rawRole = typeof rawItem.role === "string" ? rawItem.role : "user";
		const role = rawRole === "developer" ? "system" : rawRole;
		if (!["system", "user", "assistant", "model", "tool"].includes(role)) continue;
		const content = "content" in rawItem ? normalizeContentBlocks(rawItem.content) : extractTextFromUnknownContent(rawItem);
		inputItems.push({
			id: makeCompatId("in"),
			type: "message",
			role: rawRole,
			content: contentToResponseInputBlocks(content, role),
		});
		messages.push({ role: role as ChatMessage["role"], content });
	}

	return { inputItems, messages };
}

function messagesFromResponsesInput(input: unknown): ChatMessage[] | null {
	if (typeof input === "string") return [{ role: "user", content: input }];
	if (!Array.isArray(input)) return null;

	const messages: ChatMessage[] = [];
	for (const item of input) {
		if (typeof item === "string") {
			messages.push({ role: "user", content: item });
			continue;
		}
		if (!isRecord(item)) continue;
		const role = typeof item.role === "string" ? item.role : "user";
		if (!["system", "user", "assistant", "model", "tool"].includes(role)) continue;
		const content = "content" in item ? normalizeContentBlocks(item.content) : extractTextFromUnknownContent(item);
		messages.push({ role: role as ChatMessage["role"], content });
	}
	return messages.length > 0 ? messages : null;
}

function messagesFromLooseMessages(value: unknown): ChatMessage[] | null {
	if (typeof value === "string") return [{ role: "user", content: value }];
	if (isRecord(value)) return messagesFromResponsesInput([value]);
	return null;
}

function messagesFromAntigravityRequest(value: Record<string, unknown>): ChatMessage[] | null {
	const request = isRecord(value.request) ? value.request : null;
	if (!request || !Array.isArray(request.contents)) return null;
	const messages: ChatMessage[] = [];
	if (isRecord(request.systemInstruction) && Array.isArray(request.systemInstruction.parts)) {
		const systemText = request.systemInstruction.parts
			.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
			.filter(Boolean)
			.join("\n");
		if (systemText) messages.push({ role: "system", content: systemText });
	}
	for (const turn of request.contents) {
		if (!isRecord(turn) || !Array.isArray(turn.parts)) continue;
		const role = turn.role === "model" || turn.role === "assistant" ? "assistant" : "user";
		const content = turn.parts
			.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
			.filter(Boolean)
			.join("\n");
		messages.push({ role, content });
	}
	return messages.length > 0 ? messages : null;
}

export function normalizeOpenAIChatCompletionRequest(value: unknown): unknown {
	if (!isRecord(value) || Array.isArray(value.messages)) return value;
	let messages: ChatMessage[] | null = null;
	if ("messages" in value) messages = messagesFromLooseMessages(value.messages);
	else if (typeof value.prompt === "string") messages = [{ role: "user", content: value.prompt }];
	else if (Array.isArray(value.prompt)) messages = messagesFromResponsesInput(value.prompt) ?? value.prompt.map((prompt) => ({ role: "user", content: String(prompt) }));
	else if ("input" in value) messages = messagesFromResponsesInput(value.input);
	else messages = messagesFromAntigravityRequest(value);
	return messages ? { ...value, messages } : value;
}

export function normalizeOpenAIResponsesRequest(value: unknown): unknown {
	if (!isRecord(value)) return value;

	// Normalize and filter tools array.
	// Codex / VS Code Responses API sends tools in two layouts:
	//   1. Standard:   { type: "function", function: { name, description, parameters } }
	//   2. Flat (v2):  { type: "function", name, description, parameters }  ← Codex uses this
	// We normalize flat entries to standard layout, drop non-function types, and drop
	// any function entries still missing a name after normalization.
	let normalized: Record<string, unknown> = { ...value };
	if (Array.isArray(value.tools)) {
		const before = value.tools.length;
		const filtered: unknown[] = [];
		for (const t of value.tools) {
			if (!isRecord(t) || typeof t.type !== "string") continue;
			if (t.type !== "function") continue;

			// Flat format: name at root level → lift into .function wrapper
			if (isNonEmptyString(t.name) && !isRecord(t.function)) {
				filtered.push({
					type: "function",
					function: {
						name: t.name,
						...(typeof t.description === "string" ? { description: t.description } : {}),
						...(isRecord(t.parameters) ? { parameters: t.parameters } : {}),
					},
				});
				continue;
			}

			// Standard format: must have .function.name
			if (isRecord(t.function) && isNonEmptyString(t.function.name)) {
				filtered.push(t);
			}
			// else: drop (function entry without a usable name)
		}
		const dropped = before - filtered.length;
		if (dropped > 0) {
			compatLogger.warn(`Filtered ${dropped} unsupported/unnamed tool(s) from Responses request (kept ${filtered.length} function tools)`);
		}
		normalized = { ...normalized, tools: filtered.length > 0 ? filtered : undefined };
	}

	if ("input" in normalized) return normalized;
	if ("messages" in normalized) return { ...normalized, input: normalized.messages };
	if ("prompt" in normalized) return { ...normalized, input: normalized.prompt };
	return normalized;
}

export function normalizeAnthropicMessagesRequest(value: unknown): unknown {
	if (!isRecord(value) || Array.isArray(value.messages)) return value;
	const messages = "messages" in value
		? messagesFromLooseMessages(value.messages)
		: "input" in value
		? messagesFromResponsesInput(value.input)
		: messagesFromAntigravityRequest(value);
	return messages ? { ...value, messages } : value;
}

function validateResponsesTools(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return ["body.tools must be an array when provided"];
	const errors: string[] = [];
	for (const tool of value) {
		if (!isRecord(tool)) {
			errors.push("each tool must be an object");
			continue;
		}
		if (tool.type !== "function") {
			errors.push(`only function tools are supported (got: ${tool.type})`);
		}
	}
	return errors;
}

export function validateOpenAIChatCompletionRequest(value: unknown): { ok: true; value: OpenAIChatCompletionRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!validateMessages(value.messages)) {
		compatLogger.warn(`OpenAI messages validation failed: ${JSON.stringify(value.messages)}`);
		errors.push("body.messages must be an array of chat messages");
	}
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_tokens !== undefined && typeof value.max_tokens !== "number") errors.push("body.max_tokens must be number when provided");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as OpenAIChatCompletionRequest };
}

export function validateOpenAIResponsesRequest(value: unknown): { ok: true; value: OpenAIResponsesRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_output_tokens !== undefined && typeof value.max_output_tokens !== "number") errors.push("body.max_output_tokens must be number when provided");
	if (value.store !== undefined && typeof value.store !== "boolean") errors.push("body.store must be boolean when provided");
	if (value.previous_response_id !== undefined && value.previous_response_id !== null && !isNonEmptyString(value.previous_response_id)) {
		errors.push("body.previous_response_id must be a non-empty string or null");
	}
	if (value.conversation !== undefined && value.conversation !== null) {
		errors.push("body.conversation is not supported; use previous_response_id instead");
	}
	if (value.metadata !== undefined && !isRecord(value.metadata)) errors.push("body.metadata must be an object when provided");
	if (value.reasoning !== undefined && value.reasoning !== null && !isRecord(value.reasoning)) {
		errors.push("body.reasoning must be an object when provided");
	} else if (isRecord(value.reasoning) && value.reasoning.effort !== undefined && value.reasoning.effort !== null && typeof value.reasoning.effort !== "string") {
		errors.push("body.reasoning.effort must be a string when provided");
	}
	if (value.instructions !== undefined && value.instructions !== null && typeof value.instructions !== "string" && !Array.isArray(value.instructions)) {
		errors.push("body.instructions must be a string or content array when provided");
	}
	errors.push(...validateResponsesTools(value.tools));
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as OpenAIResponsesRequest };
}

export function validateAnthropicMessagesRequest(value: unknown): { ok: true; value: AnthropicMessagesRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!validateMessages(value.messages)) errors.push("body.messages must be an array of chat messages");
	if (value.system !== undefined && typeof value.system !== "string" && !Array.isArray(value.system)) errors.push("body.system must be string or content array when provided");
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_tokens !== undefined && typeof value.max_tokens !== "number") errors.push("body.max_tokens must be number when provided");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as AnthropicMessagesRequest };
}

type GeminiContent = { role: "user" | "model"; parts: unknown[] };

type ResponsesConversionResult = {
	chatRequest: OpenAIChatCompletionRequest;
	inputItems: Array<Record<string, unknown>>;
	conversationMessages: ChatMessage[];
	previousResponseId: string | null;
};

function convertResponsesToChatRequest(input: OpenAIResponsesRequest): ResponsesConversionResult {
	const previousResponseId = input.previous_response_id ?? null;
	const previous = previousResponseId ? getStoredResponse(previousResponseId) : null;
	if (previousResponseId && !previous) {
		throw new Error(`previous_response_id not found: ${previousResponseId}`);
	}

	const parsed = parseResponsesInput(input.input, previous?.callIdToName);
	const conversationMessages = [
		...(previous?.conversationMessages ?? []),
		...parsed.messages,
	];
	const chatMessages = [
		...(input.instructions ? [{ role: "system" as const, content: normalizeInstructionsContent(input.instructions) }] : []),
		...conversationMessages,
	];

	return {
		chatRequest: {
			model: input.model,
			messages: chatMessages,
			stream: input.stream,
			temperature: input.temperature,
			max_tokens: input.max_output_tokens,
			tools: input.tools as OpenAITool[] | undefined,
			tool_choice: input.tool_choice,
			reasoning_effort: typeof input.reasoning?.effort === "string" ? input.reasoning.effort : undefined,
			parallel_tool_calls: input.parallel_tool_calls,
		},
		inputItems: parsed.inputItems,
		conversationMessages,
		previousResponseId,
	};
}

function responseUsageFromCompletion(completion: CompatCompletion): Record<string, unknown> {
	return {
		input_tokens: completion.inputTokens,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: completion.outputTokens,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: completion.inputTokens + completion.outputTokens,
	};
}

function buildResponsesOutput(completion: CompatCompletion): { output: ResponseOutputItem[]; outputText: string; callIdToName: Map<string, string> } {
	const output: ResponseOutputItem[] = [];
	const callIdToName = new Map<string, string>();
	// Emit reasoning item first (before message text) when thinking content is present
	if (completion.thinkingText) {
		output.push({
			id: makeCompatId("rs"),
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: completion.thinkingText }],
		} as unknown as ResponseOutputItem);
	}
	if (completion.text) {
		output.push({
			id: makeCompatId("msg"),
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: completion.text, annotations: [] }],
		});
	}
	for (const toolCall of completion.toolCalls ?? []) {
		callIdToName.set(toolCall.id, toolCall.function.name);
		output.push({
			id: makeCompatId("fc"),
			type: "function_call",
			call_id: toolCall.id,
			name: toolCall.function.name,
			arguments: toolCall.function.arguments,
			status: "completed",
		});
	}
	return { output, outputText: completion.text, callIdToName };
}

function buildAssistantMessageFromCompletion(completion: CompatCompletion): ChatMessage {
	return completion.toolCalls && completion.toolCalls.length > 0
		? { role: "assistant", content: completion.text || null, tool_calls: completion.toolCalls }
		: { role: "assistant", content: completion.text };
}

function buildResponsesResponse(
	request: OpenAIResponsesRequest,
	responseId: string,
	createdAt: number,
	completion: CompatCompletion,
	status: "in_progress" | "completed" | "cancelled",
	previousResponseId: string | null,
): Record<string, unknown> {
	const { output, outputText } = buildResponsesOutput(completion);
	return {
		id: responseId,
		object: "response",
		created_at: createdAt,
		status,
		error: null,
		incomplete_details: null,
		instructions: request.instructions ?? null,
		max_output_tokens: request.max_output_tokens ?? null,
		model: request.model,
		output,
		output_text: outputText,
		parallel_tool_calls: request.parallel_tool_calls ?? true,
		previous_response_id: previousResponseId,
		reasoning: { effort: request.reasoning?.effort ?? null },
		store: request.store !== false,
		temperature: request.temperature ?? null,
		text: { format: { type: "text" } },
		tool_choice: request.tool_choice ?? "auto",
		tools: Array.isArray(request.tools) ? request.tools : [],
		top_p: null,
		truncation: "disabled",
		usage: responseUsageFromCompletion(completion),
		metadata: isRecord(request.metadata) ? request.metadata : {},
	};
}

function saveResponsesEntry(
	response: Record<string, unknown>,
	inputItems: Array<Record<string, unknown>>,
	conversationMessages: ChatMessage[],
	completion: CompatCompletion,
): void {
	const responseId = typeof response.id === "string" ? response.id : null;
	if (!responseId) return;
	const { callIdToName } = buildResponsesOutput(completion);
	const mergedConversation = [...conversationMessages, buildAssistantMessageFromCompletion(completion)];
	setStoredResponse(responseId, {
		response,
		inputItems,
		conversationMessages: mergedConversation,
		callIdToName,
		expiresAt: Date.now() + RESPONSES_STORE_TTL_MS,
	});
}

export function openAIToAntigravityBody(input: OpenAIChatCompletionRequest): RequestBody {
	// Separate system messages from conversation turns
	const systemParts: string[] = [];
	const conversationMessages = input.messages.filter((msg) => {
		if (msg.role === "system" || msg.role === "developer") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text) systemParts.push(text);
			return false;
		}
		return true;
	});

	// Build multi-turn contents array.
	//
	// Gemini thinking models require a `thought_signature` on every functionCall
	// part when replaying multi-turn tool conversations. Since we receive
	// We always use native Gemini functionCall parts for all tool calls in the history.

	// Determine if model is Claude — affects schema sanitization and tool call ID handling
	const isClaude = /^claude-/i.test(input.model);

	// Use model specs to determine thinking support
	const isThinking = isThinkingModel(input.model);
	const isGeminiThinking = !isClaude && isThinking;

	const contents: GeminiContent[] = [];
	for (let i = 0; i < conversationMessages.length; i++) {
		const msg = conversationMessages[i];
		if (msg.role === "assistant" || msg.role === "model") {
			// Check if this is a thinking model turn with tool calls that have no cached signatures.
			// If so, we collapse the tool exchange into a neutral user summary instead of
			// injecting [Tool call: ...] text that the model will learn to mimic.
			const hasMissingSig =
				isGeminiThinking &&
				Array.isArray(msg.tool_calls) &&
				msg.tool_calls.length > 0 &&
				!thoughtSignatureCache.has(msg.tool_calls[0].id);

			if (hasMissingSig) {
				// Build a summary of what the model did and what results came back.
				// We collect the paired tool result(s) from the immediately following messages.
				const toolNames = msg.tool_calls!.map((tc) => tc.function.name).join(", ");
				const resultParts: string[] = [];
				while (i + 1 < conversationMessages.length && conversationMessages[i + 1].role === "tool") {
					i++;
					const toolMsg = conversationMessages[i];
					const toolText = typeof toolMsg.content === "string" ? toolMsg.content : extractText(toolMsg.content);
					resultParts.push(`${toolMsg.name || "tool"}: ${toolText.slice(0, 500)}`);
				}
				const summaryText = `[Context: The assistant used tools (${toolNames}) and received results:\n${resultParts.join("\n")}]`;
				contents.push({ role: "user", parts: [{ text: summaryText }] });
				// Add a minimal model acknowledgement to avoid consecutive user turns
				contents.push({ role: "model", parts: [{ text: "Understood, I have the tool results." }] });
				continue;
			}

			const parts: unknown[] = [];
			if (msg.content) {
				const textContent = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (textContent) parts.push({ text: textContent });
			}
			if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				// Use native Gemini functionCall parts. Re-inject thought_signature from
				// the server-side cache if available. Google only validates signatures on
				// the *current turn* (after the last real user text message), so missing
				// signatures on older historical turns are silently ignored.
				let isFirstInMessage = true;
				for (const tc of msg.tool_calls) {
					let args: unknown;
					try {
						args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
					} catch {
						args = {};
					}
					// Only the first functionCall part in a model turn needs the signature
					const cachedSig = isFirstInMessage ? thoughtSignatureCache.get(tc.id) : undefined;
					parts.push({
						...(cachedSig ? { thoughtSignature: cachedSig } : {}),
						// Include id only for Claude — Gemini native models reject the id field
						functionCall: { ...(isClaude ? { id: tc.id } : {}), name: tc.function.name, args },
					});
					isFirstInMessage = false;
				}
			}
			if (parts.length > 0) {
				// For Claude: handle two scenarios that break tool_use/tool_result ordering.
				// 1. Text-only model turn after a functionCall model turn: Codex sends
				//    assistant text and function_calls as separate items. The text-only turn
				//    would split functionCall from functionResponse — skip it entirely.
				// 2. Model turn with functionCalls: strip any text parts since Google's
				//    v1internal translator may split mixed parts into separate Claude messages.
				if (isClaude) {
					const lastContent = contents[contents.length - 1];
					const prevHasFunctionCall = lastContent && lastContent.role === "model" && lastContent.parts.some((p: any) => p.functionCall);
					const hasFunctionCall = parts.some((p: any) => p.functionCall);
					if (prevHasFunctionCall && !hasFunctionCall) {
						// Skip text-only model turn after functionCall turn
					} else if (hasFunctionCall) {
						// Strip text parts, keep only functionCall parts
						const fcOnly = parts.filter((p: any) => p.functionCall);
						if (prevHasFunctionCall) {
							lastContent.parts.push(...fcOnly);
						} else {
							contents.push({ role: "model", parts: fcOnly });
						}
					} else {
						contents.push({ role: "model", parts });
					}
				} else {
					contents.push({ role: "model", parts });
				}
			}
		} else if (msg.role === "tool") {
			const responseText = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			const fnName = msg.name || "unknown";
			// Include tool_call_id so Gemini can pass it as tool_use_id to Claude
			const toolCallId = msg.tool_call_id;
			let responseData: unknown;
			try {
				const parsed = JSON.parse(responseText);
				// Cloud Code proto requires functionResponse.response to be an object, not an array.
				// Wrap arrays (and other non-object primitives) so the field is always a plain object.
				responseData = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
					? parsed
					: { output: parsed };
			} catch { responseData = { output: responseText }; }
			// Include id only for Claude — Gemini native models reject the id field in functionResponse
			const fnResponsePart = { functionResponse: { ...(isClaude && toolCallId ? { id: toolCallId } : {}), name: fnName, response: responseData } };
			// Merge consecutive tool results into a single user turn.
			// Claude (via Vertex) requires ALL tool_result blocks in one message
			// directly after the assistant message with tool_use blocks.
			const lastContent = contents[contents.length - 1];
			if (lastContent && lastContent.role === "user" && Array.isArray(lastContent.parts) && lastContent.parts.length > 0 && isRecord(lastContent.parts[0] as any) && (lastContent.parts[0] as any).functionResponse !== undefined) {
				lastContent.parts.push(fnResponsePart);
			} else {
				contents.push({ role: "user", parts: [fnResponsePart] });
			}
		} else {
			// user message
			const msgParts = extractParts(msg.content);

			if (msgParts.length > 0) contents.push({ role: "user", parts: msgParts });
		}
	}


	if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Hello" }] });

	// Build tools / toolConfig if present
	const inputTools = Array.isArray(input.tools) ? (input.tools as OpenAITool[]) : [];
	const geminiTools = convertOpenAIToolsToGemini(inputTools, isClaude);
	const geminiToolConfig = input.tool_choice !== undefined ? convertToolChoiceToGemini(input.tool_choice) : undefined;

	// Cap maxOutputTokens to model limits and build thinkingConfig
	const modelSpec = getModelSpec(input.model);
	const modelFamily = getModelFamily(input.model);
	let maxOutputTokens = typeof input.max_tokens === "number" ? input.max_tokens : undefined;
	if (maxOutputTokens && maxOutputTokens > modelSpec.maxOutputTokens) {
		compatLogger.debug(`Capping ${input.model} maxOutputTokens ${maxOutputTokens} → ${modelSpec.maxOutputTokens}`);
		maxOutputTokens = modelSpec.maxOutputTokens;
	}

	let thinkingConfigObj: Record<string, unknown> | undefined;
	if (modelFamily === "claude" && isThinking) {
		// Claude: snake_case keys required by v1internal
		const tb = modelSpec.thinkingBudget;
		thinkingConfigObj = { include_thoughts: true, thinking_budget: tb };
		if (!maxOutputTokens || maxOutputTokens <= tb) {
			maxOutputTokens = Math.min(tb + 8192, modelSpec.maxOutputTokens);
			compatLogger.debug(`Adjusted Claude maxOutputTokens → ${maxOutputTokens}`);
		}
	} else if (isThinking) {
		// Gemini: camelCase keys; thinkingBudget=-1 means adaptive (omit the field)
		const tb = modelSpec.thinkingBudget;
		thinkingConfigObj = tb === -1
			? { includeThoughts: true }
			: { includeThoughts: true, thinkingBudget: tb };
		if (tb !== -1 && (!maxOutputTokens || maxOutputTokens <= tb)) {
			maxOutputTokens = Math.min(tb + 8192, modelSpec.maxOutputTokens);
			compatLogger.debug(`Adjusted Gemini maxOutputTokens → ${maxOutputTokens}`);
		}
	} else if (input.reasoning_effort) {
		// Non-thinking models with explicit reasoning_effort hint
		const budgets: Record<string, number> = { low: Math.round(modelSpec.thinkingBudget / 4), medium: Math.round(modelSpec.thinkingBudget / 2), high: modelSpec.thinkingBudget };
		const b = budgets[input.reasoning_effort.toLowerCase()];
		if (b) thinkingConfigObj = { includeThoughts: true, thinkingBudget: b };
	}

	const generationConfig: Record<string, unknown> = {
		...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
		...(maxOutputTokens ? { maxOutputTokens } : {}),
		...(thinkingConfigObj ? { thinkingConfig: thinkingConfigObj } : {}),
	};

	const request: Record<string, unknown> = {
		contents,
		generationConfig,
	};

	if (systemParts.length > 0) {
		if (!isClaude && isThinking) {
			// Gemini thinking models (gemini-3.1-pro-high/low) reject the systemInstruction
			// field entirely — prepend system prompt to the first user content turn instead.
			const firstTurn = contents[0];
			if (firstTurn && firstTurn.role === "user" && (firstTurn.parts[0] as any)?.text !== undefined) {
				(firstTurn.parts[0] as any).text = systemParts.join("\n\n") + "\n\n" + (firstTurn.parts[0] as any).text;
			} else if (firstTurn && firstTurn.role === "user") {
				firstTurn.parts.unshift({ text: systemParts.join("\n\n") + "\n\n" });
			} else {
				contents.unshift({
					role: "user",
					parts: [{ text: systemParts.join("\n\n") }],
				});
			}
		} else {
			request.systemInstruction = {
				role: "system",
				parts: [{ text: systemParts.join("\n\n") }],
			};
		}
	}

	if (geminiTools.length > 0) request.tools = geminiTools;
	if (geminiToolConfig) request.toolConfig = geminiToolConfig;

	let mappedModel = input.model;
	if (mappedModel === "gemini-3.1-pro-high") mappedModel = "gemini-pro-agent";
	if (mappedModel === "gemini-3.5-flash-high" || mappedModel === "gemini-3.5-flash" || mappedModel === "gemini-3.5-flash-medium") mappedModel = "gemini-3-flash-agent";
	if (mappedModel === "gpt-oss-120b") mappedModel = "gpt-oss-120b-medium";

	return {
		project: "compat-placeholder",
		model: mappedModel,
		displayModel: input.model,
		userAgent: "antigravity",
		requestType: "agent",
		request,
	};
}

/** Convert Anthropic tools [{name, description, input_schema}] → OpenAI format [{type:"function", function:{name, description, parameters}}] */
function convertAnthropicToolsToOpenAI(tools: unknown): OpenAITool[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const result: OpenAITool[] = [];
	for (const t of tools) {
		if (!isRecord(t) || !isNonEmptyString(t.name)) continue;
		result.push({
			type: "function",
			function: {
				name: t.name as string,
				...(typeof t.description === "string" ? { description: t.description } : {}),
				...(isRecord(t.input_schema) ? { parameters: t.input_schema as Record<string, unknown> } : {}),
			},
		});
	}
	return result.length > 0 ? result : undefined;
}

/** Convert Anthropic tool_choice → OpenAI tool_choice */
function convertAnthropicToolChoice(toolChoice: unknown): unknown {
	if (!isRecord(toolChoice)) return toolChoice;
	if (toolChoice.type === "auto") return "auto";
	if (toolChoice.type === "any") return "required";
	if (toolChoice.type === "tool" && isNonEmptyString(toolChoice.name)) {
		return { type: "function", function: { name: toolChoice.name } };
	}
	return "auto";
}

/**
 * Convert Anthropic-format messages (tool_use / tool_result content blocks)
 * to OpenAI-format messages (tool_calls array / role:"tool" messages).
 */
function convertAnthropicMessagesToOpenAI(messages: ChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];
	for (const msg of messages) {
		// Assistant messages with tool_use content blocks → tool_calls
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const blocks = msg.content as Array<Record<string, unknown>>;
			const toolUseBlocks = blocks.filter(
				(b) => isRecord(b) && b.type === "tool_use" && isNonEmptyString(b.name),
			);
			if (toolUseBlocks.length > 0) {
				const textParts = blocks
					.filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
					.map((b) => b.text as string)
					.join("");
				const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((b) => ({
					id: (b.id as string) || `call_${Date.now().toString(36)}`,
					type: "function" as const,
					function: {
						name: b.name as string,
						arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
					},
				}));
				result.push({ role: "assistant", content: textParts || null, tool_calls: toolCalls });
				continue;
			}
		}
		// User messages with tool_result content blocks → role:"tool" messages
		if (msg.role === "user" && Array.isArray(msg.content)) {
			const blocks = msg.content as Array<Record<string, unknown>>;
			const toolResults = blocks.filter((b) => isRecord(b) && b.type === "tool_result");
			if (toolResults.length > 0) {
				const otherBlocks = blocks.filter((b) => !isRecord(b) || b.type !== "tool_result");
				if (otherBlocks.length > 0) {
					result.push({ role: "user", content: otherBlocks as ChatMessage["content"] });
				}
				for (const tr of toolResults) {
					const content = typeof tr.content === "string"
						? tr.content
						: Array.isArray(tr.content)
						? extractTextFromUnknownContent(tr.content)
						: JSON.stringify(tr.content ?? "");
					result.push({
						role: "tool",
						content,
						tool_call_id: tr.tool_use_id as string,
					});
				}
				continue;
			}
		}
		result.push(msg);
	}
	return result;
}

export function anthropicToAntigravityBody(input: AnthropicMessagesRequest): RequestBody {
	const systemText = typeof input.system === "string" ? input.system : Array.isArray(input.system) ? extractText(input.system as ChatMessage["content"]) : "";
	const tools = convertAnthropicToolsToOpenAI(input.tools);
	const toolChoice = convertAnthropicToolChoice(input.tool_choice);
	const convertedMessages = convertAnthropicMessagesToOpenAI(input.messages);
	return openAIToAntigravityBody({
		model: input.model,
		stream: input.stream,
		temperature: input.temperature,
		max_tokens: input.max_tokens,
		tools,
		tool_choice: toolChoice,
		messages: [
			...(systemText ? [{ role: "system" as const, content: systemText }] : []),
			...convertedMessages,
		],
	});
}

/**
 * Maps an OpenAI reasoning_effort / model name suffix to a Gemini thinkingBudget integer.
 * Cloud Code Assist uses thinkingBudget (integer token count), not thinkingLevel (string).
 * Values match models.json: -high=10001, -low=1001, flash=dynamic(-1 means dynamic).
 * Returns undefined for models that don't need an explicit budget (e.g. Claude, plain flash).
 */
function mapReasoningEffortToThinkingLevel(effort: string | undefined, modelId: string): number | undefined {
	const lowerModel = modelId.toLowerCase();
	const isGemini31Pro = /gemini-3\.1-pro/i.test(modelId);
	const isGemini3Flash = lowerModel.includes("gemini-3-flash") || lowerModel.includes("gemini-3.5-flash");

	let effectiveEffort = effort;
	if (!effectiveEffort) {
		if (lowerModel.endsWith("-high") || lowerModel.includes("gemini-pro-agent")) effectiveEffort = "high";
		else if (lowerModel.endsWith("-low")) effectiveEffort = "low";
		else if (isGemini3Flash) effectiveEffort = "high";
		// Claude models: skip — thinking is handled by the anthropic-beta header
	}

	if (!effectiveEffort) return undefined;

	// Gemini 3.1 Pro uses fixed budgets matching models.json
	if (isGemini31Pro) {
		switch (effectiveEffort.toLowerCase()) {
			case "high": return 10001;
			case "medium": return 5000;
			case "low": return 1001;
			default: return undefined;
		}
	}

	// Flash uses dynamic budget (-1 means let the model decide)
	if (isGemini3Flash) {
		switch (effectiveEffort.toLowerCase()) {
			case "high": return -1;
			case "medium": return 4096;
			case "low": return 1024;
			default: return undefined;
		}
	}

	return undefined;
}

export function parseAntigravitySse(raw: string): CompatCompletion {
	let text = "";
	let thinkingText = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let responseId: string | undefined;
	const toolCallsMap = new Map<string, OpenAIToolCall>();
	let toolCallIndex = 0;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const parsed = JSON.parse(payload) as Record<string, unknown>;
			const response = isRecord(parsed.response) ? parsed.response : parsed;
			if (!responseId && typeof response.responseId === "string") responseId = response.responseId;
			const candidates = Array.isArray(response.candidates) ? response.candidates : [];
			for (const candidate of candidates) {
				if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
				for (const part of candidate.content.parts) {
					if (!isRecord(part)) continue;
					if (typeof part.text === "string") {
						// Route thought blocks separately from normal text
						if (part.thought === true) {
							thinkingText += part.text;
						} else {
							text += part.text;
						}
					} else if (isRecord(part.functionCall)) {
						// Gemini functionCall → OpenAI tool_call
						const fc = part.functionCall;
						const name = typeof fc.name === "string" ? fc.name : "unknown";
						const args = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
						const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
						// Cache thought_signature so we can re-inject it on the next turn
						if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
							cacheThoughtSignature(callId, part.thoughtSignature);
						}
						toolCallsMap.set(name + callId, { id: callId, type: "function", function: { name, arguments: args } });
					}
				}
			}
			const usage = isRecord(response.usageMetadata) ? response.usageMetadata : isRecord(response.usage) ? response.usage : null;
			if (usage) {
				if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
				if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
				if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
				if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
			}
		} catch {
			// Ignore malformed SSE lines from upstream; other chunks may still be valid.
		}
	}

	let parsedText = text;

	// Intercept legacy hallucinated format: [Tool call: name(args)]
	const legacyRegex = /\[Tool call:\s*([a-zA-Z0-9_-]+)\(([\s\S]*?)\)\]/g;
	let match;
	while ((match = legacyRegex.exec(parsedText)) !== null) {
		const name = match[1];
		const args = match[2].trim();
		const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
		toolCallsMap.set(name + callId, { id: callId, type: "function", function: { name, arguments: args } });
	}
	parsedText = parsedText.replace(legacyRegex, "");

	// Intercept new hallucinated XML format: <tool_call name="name">args</tool_call>
	const xmlRegex = /<tool_call name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
	while ((match = xmlRegex.exec(parsedText)) !== null) {
		const name = match[1];
		const args = match[2].trim();
		const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
		toolCallsMap.set(name + callId, { id: callId, type: "function", function: { name, arguments: args } });
	}
	parsedText = parsedText.replace(xmlRegex, "");

	parsedText = parsedText.trim();

	const toolCalls = toolCallsMap.size > 0 ? [...toolCallsMap.values()] : undefined;
	return { text: parsedText, thinkingText: thinkingText || undefined, inputTokens, outputTokens, responseId, toolCalls };
}

function writeJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(payload));
}

function writeResponsesEvent(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function summarizeCompatRequest(body: RequestBody): string {
	const request = isRecord(body.request) ? body.request : {};
	const contents = Array.isArray(request.contents) ? request.contents : [];
	const tools = Array.isArray(request.tools) ? request.tools.length : 0;
	const systemInstruction = isRecord(request.systemInstruction) ? "yes" : "no";
	return `model=${body.model} userAgent=${body.userAgent || "none"} turns=${contents.length} tools=${tools} systemInstruction=${systemInstruction}`;
}

function writeOpenAIStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const created = Math.floor(Date.now() / 1000);
	const id = `chatcmpl-${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
	// Emit reasoning/thinking content first if present
	if (completion.thinkingText) {
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: completion.thinkingText }, finish_reason: null }] })}\n\n`);
	}
	if (completion.toolCalls && completion.toolCalls.length > 0) {
		// Emit tool_call deltas
		for (let i = 0; i < completion.toolCalls.length; i++) {
			const tc = completion.toolCalls[i];
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] })}\n\n`);
		}
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
	} else {
		if (completion.text) {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] })}\n\n`);
		}
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	}
	// Emit usage chunk so agents (hermes, openwebui) can display token statistics
	if (completion.inputTokens > 0 || completion.outputTokens > 0) {
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: completion.inputTokens, completion_tokens: completion.outputTokens, total_tokens: completion.inputTokens + completion.outputTokens } })}\n\n`);
	}
	res.write("data: [DONE]\n\n");
	res.end();
}

function writeAnthropicStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const id = `msg_${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: completion.inputTokens, output_tokens: 0 } } })}\n\n`);
	let contentIndex = 0;
	// Emit thinking block first if present (Anthropic format)
	if (completion.thinkingText) {
		res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`);
		res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "thinking_delta", thinking: completion.thinkingText } })}\n\n`);
		res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`);
		contentIndex++;
	}
	if (completion.text) {
		res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "text", text: "" } })}\n\n`);
		res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "text_delta", text: completion.text } })}\n\n`);
		res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`);
		contentIndex++;
	}
	// Emit tool_use content blocks if present
	let hasToolUse = false;
	if (completion.toolCalls && completion.toolCalls.length > 0) {
		hasToolUse = true;
		for (const tc of completion.toolCalls) {
			let parsedInput: unknown;
			try { parsedInput = JSON.parse(tc.function.arguments || "{}"); } catch { parsedInput = {}; }
			res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} } })}\n\n`);
			res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`);
			res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`);
			contentIndex++;
		}
	}
	const stopReason = hasToolUse ? "tool_use" : "end_turn";
	// message_delta: include both input_tokens and output_tokens so hermes shows full context count
	res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: completion.inputTokens, output_tokens: completion.outputTokens } })}\n\n`);
	res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
	res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	try {
		const body = await readLimitedBody(req);
		return JSON.parse(body.toString("utf-8"));
	} catch (err) {
		if (err instanceof PayloadTooLargeError) throw err;
		throw new Error("Invalid JSON body");
	}
}

async function streamCompatSse(
	body: unknown,
	req: IncomingMessage,
	res: ServerResponse,
	model: string,
	format: "openai" | "anthropic",
): Promise<CompatCompletion> {
	const nodeStream = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
	let text = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let responseId: string | undefined;
	let toolCallIndex = 0;

	const created = Math.floor(Date.now() / 1000);
	const id = format === "openai" ? `chatcmpl-${Date.now().toString(36)}` : `msg_${Date.now().toString(36)}`;

	let anthropicActiveBlockIndex = -1;
	let anthropicActiveBlockType: "thinking" | "text" | null = null;
	let anthropicHasToolUse = false;
	const anthropicToolCalls: OpenAIToolCall[] = [];

	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });

	if (format === "openai") {
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
	} else if (format === "anthropic") {
		res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
	}

	let tailBuffer = "";
	let reqClosed = false;
	req.once("close", () => { reqClosed = true; });

	try {
		for await (const chunk of nodeStream) {
			if (reqClosed) {
				nodeStream.destroy();
				break;
			}
			const str = chunk.toString();
			tailBuffer += str;
			let newlineIdx;
			while ((newlineIdx = tailBuffer.indexOf('\n')) >= 0) {
				const line = tailBuffer.slice(0, newlineIdx).trim();
				tailBuffer = tailBuffer.slice(newlineIdx + 1);

				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === "[DONE]") continue;

				try {
					const parsed = JSON.parse(payload) as Record<string, unknown>;
					const response = isRecord(parsed.response) ? parsed.response : parsed;
					if (!responseId && typeof response.responseId === "string") responseId = response.responseId;

					const candidates = Array.isArray(response.candidates) ? response.candidates : [];
					if (candidates.length > 0 && candidates[0]?.content?.parts) {
						// DEBUG LOGGING to see what Google is actually sending for thinking
						if (candidates[0].content.parts.some((p: any) => p.thought === true || p.text)) {
							console.log(`[DEBUG] Received parts:`, JSON.stringify(candidates[0].content.parts));
						}
					}
					for (const candidate of candidates) {
						if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
						for (const part of candidate.content.parts) {
							if (!isRecord(part)) continue;
							if (typeof part.text === "string" && part.text) {
								if (part.thought === true) {
									// Thought block → reasoning_content (OpenAI) or thinking_delta (Anthropic)
									if (format === "openai") {
										res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: part.text }, finish_reason: null }] })}\n\n`);
									} else {
										if (anthropicActiveBlockType !== "thinking") {
											if (anthropicActiveBlockType === "text") {
												res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
											}
											anthropicActiveBlockIndex = 0;
											anthropicActiveBlockType = "thinking";
											res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`);
										}
										res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "thinking_delta", thinking: part.text } })}\n\n`);
									}
								} else {
									text += part.text;
									if (format === "openai") {
										res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] })}\n\n`);
									} else {
										if (anthropicActiveBlockType !== "text") {
											if (anthropicActiveBlockType === "thinking") {
												res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
												anthropicActiveBlockIndex = 1;
											} else {
												anthropicActiveBlockIndex = 0;
											}
											anthropicActiveBlockType = "text";
											res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "text", text: "" } })}\n\n`);
										}
										res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "text_delta", text: part.text } })}\n\n`);
									}
								}
							} else if (isRecord(part.functionCall)) {
								const fc = part.functionCall;
								const name = typeof fc.name === "string" ? fc.name : "unknown";
								const args = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
								const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
								// Cache thought_signature so we can re-inject it on the next turn
								if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
									cacheThoughtSignature(callId, part.thoughtSignature);
								}
								if (format === "openai") {
									res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex - 1, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] })}\n\n`);
								} else {
									// Close any active text/thinking block before emitting tool_use
									if (anthropicActiveBlockType !== null) {
										res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
										anthropicActiveBlockType = null;
									}
									anthropicActiveBlockIndex++;
									anthropicHasToolUse = true;
									anthropicToolCalls.push({ id: callId, type: "function", function: { name, arguments: args } });
									let parsedInput: unknown;
									try { parsedInput = JSON.parse(args); } catch { parsedInput = {}; }
									res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "tool_use", id: callId, name, input: {} } })}\n\n`);
									res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`);
									res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
								}
							}
						}
					}
					const usage = isRecord(response.usageMetadata) ? response.usageMetadata : isRecord(response.usage) ? response.usage : null;
					if (usage) {
						if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
						if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
						if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
						if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
					}
				} catch {
					// Ignore malformed JSON chunks
				}
			}
		}
	} catch (err) {
		compatLogger.warn(`Stream read error: ${err}`);
	}

	if (!reqClosed && !res.writableEnded) {
		if (format === "openai") {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			// Emit a usage chunk so agents (hermes, openwebui, etc.) can display token statistics
			if (inputTokens > 0 || outputTokens > 0) {
				res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
			}
			res.write("data: [DONE]\n\n");
		} else {
			if (anthropicActiveBlockType !== null) {
				res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`);
			}
			const anthropicStopReason = anthropicHasToolUse ? "tool_use" : "end_turn";
			// message_delta carries output_tokens; also include input_tokens so Hermes shows full context count
			res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anthropicStopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } })}\n\n`);
			res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
		}
		res.end();
	}

	return { text, inputTokens, outputTokens, responseId, toolCalls: anthropicToolCalls.length > 0 ? anthropicToolCalls : undefined };
}

async function streamResponsesSse(
	body: unknown,
	req: IncomingMessage,
	res: ServerResponse,
	request: OpenAIResponsesRequest,
	responseId: string,
	previousResponseId: string | null,
	createdAt: number,
): Promise<CompatCompletion> {
	const nodeStream = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
	let text = "";
	let thinkingText = "";
	let inputTokens = 0;
	let outputTokens = 0;
	const toolCalls: OpenAIToolCall[] = [];
	let toolCallIndex = 0;
	let nextOutputIndex = 0;
	let messageOutputIndex = -1;
	let messageItemId = "";
	let reasoningOutputIndex = -1;
	let reasoningItemId = "";
	let reasoningDone = false;
	let reqClosed = false;
	req.once("close", () => { reqClosed = true; });

	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
	const emptyCompletion: CompatCompletion = { text: "", thinkingText: undefined, inputTokens: 0, outputTokens: 0, toolCalls: [] };
	writeResponsesEvent(res, { type: "response.created", response: buildResponsesResponse(request, responseId, createdAt, emptyCompletion, "in_progress", previousResponseId) });
	writeResponsesEvent(res, { type: "response.in_progress", response: buildResponsesResponse(request, responseId, createdAt, emptyCompletion, "in_progress", previousResponseId) });

	let tailBuffer = "";
	try {
		for await (const chunk of nodeStream) {
			if (reqClosed) {
				nodeStream.destroy();
				break;
			}
			tailBuffer += chunk.toString();
			let newlineIdx;
			while ((newlineIdx = tailBuffer.indexOf("\n")) >= 0) {
				const line = tailBuffer.slice(0, newlineIdx).trim();
				tailBuffer = tailBuffer.slice(newlineIdx + 1);
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === "[DONE]") continue;
				try {
					const parsed = JSON.parse(payload) as Record<string, unknown>;
					const response = isRecord(parsed.response) ? parsed.response : parsed;
					const candidates = Array.isArray(response.candidates) ? response.candidates : [];
					for (const candidate of candidates) {
						if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
						for (const part of candidate.content.parts) {
							if (!isRecord(part)) continue;
							if (typeof part.text === "string" && part.text) {
								if (part.thought === true) {
									// Stream reasoning content via Responses API reasoning events.
									// First thought chunk: open the reasoning output item.
									if (reasoningOutputIndex === -1) {
										reasoningOutputIndex = nextOutputIndex++;
										reasoningItemId = makeCompatId("rs");
										writeResponsesEvent(res, {
											type: "response.output_item.added",
											output_index: reasoningOutputIndex,
											item: { id: reasoningItemId, type: "reasoning", status: "in_progress", summary: [] },
										});
									}
									writeResponsesEvent(res, {
										type: "response.reasoning_summary_text.delta",
										item_id: reasoningItemId,
										output_index: reasoningOutputIndex,
										summary_index: 0,
										delta: part.text,
									});
									thinkingText += part.text;
									continue;
								}
								// Non-thought text arriving: close reasoning item immediately so Codex
								// sees a completed reasoning block before any content/tool items.
								if (reasoningOutputIndex !== -1 && !reasoningDone) {
									reasoningDone = true;
									writeResponsesEvent(res, { type: "response.reasoning_summary_text.done", item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0, text: thinkingText });
									writeResponsesEvent(res, { type: "response.output_item.done", output_index: reasoningOutputIndex, item: { id: reasoningItemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: thinkingText }] } });
								}
								if (messageOutputIndex === -1) {
									messageOutputIndex = nextOutputIndex++;
									messageItemId = makeCompatId("msg");
									writeResponsesEvent(res, {
										type: "response.output_item.added",
										output_index: messageOutputIndex,
										item: {
											id: messageItemId,
											type: "message",
											status: "completed",
											role: "assistant",
											content: [{ type: "output_text", text: "", annotations: [] }],
										},
									});
								}
								text += part.text;
								writeResponsesEvent(res, {
									type: "response.output_text.delta",
									item_id: messageItemId,
									output_index: messageOutputIndex,
									content_index: 0,
									delta: part.text,
								});
							} else if (isRecord(part.functionCall)) {
								// functionCall arriving: close reasoning item immediately if still open
								if (reasoningOutputIndex !== -1 && !reasoningDone) {
									reasoningDone = true;
									writeResponsesEvent(res, { type: "response.reasoning_summary_text.done", item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0, text: thinkingText });
									writeResponsesEvent(res, { type: "response.output_item.done", output_index: reasoningOutputIndex, item: { id: reasoningItemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: thinkingText }] } });
								}
								const fc = part.functionCall;
								const name = typeof fc.name === "string" ? fc.name : "unknown";
								const args = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
								const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
								if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
									cacheThoughtSignature(callId, part.thoughtSignature);
								}
								toolCalls.push({ id: callId, type: "function", function: { name, arguments: args } });
								const item = {
									id: makeCompatId("fc"),
									type: "function_call",
									call_id: callId,
									name,
									arguments: args,
									status: "completed",
								};
								const outputIndex = nextOutputIndex++;
								writeResponsesEvent(res, { type: "response.output_item.added", output_index: outputIndex, item });
								writeResponsesEvent(res, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: outputIndex, delta: args });
								writeResponsesEvent(res, { type: "response.function_call_arguments.done", item_id: item.id, output_index: outputIndex, arguments: args });
								writeResponsesEvent(res, { type: "response.output_item.done", output_index: outputIndex, item });
							}
						}
					}
					const usage = isRecord(response.usageMetadata) ? response.usageMetadata : isRecord(response.usage) ? response.usage : null;
					if (usage) {
						if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
						if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
						if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
						if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
					}
				} catch {
					// Ignore malformed JSON chunks
				}
			}
		}
	} catch (err) {
		compatLogger.warn(`Responses stream read error: ${err}`);
	}

	const completion: CompatCompletion = {
		text,
		thinkingText: thinkingText || undefined,
		inputTokens,
		outputTokens,
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
	};
	if (!reqClosed && !res.writableEnded) {
		// Close reasoning item if it was never closed mid-stream
		if (reasoningOutputIndex !== -1 && !reasoningDone) {
			writeResponsesEvent(res, {
				type: "response.reasoning_summary_text.done",
				item_id: reasoningItemId,
				output_index: reasoningOutputIndex,
				summary_index: 0,
				text: thinkingText,
			});
			writeResponsesEvent(res, {
				type: "response.output_item.done",
				output_index: reasoningOutputIndex,
				item: {
					id: reasoningItemId,
					type: "reasoning",
					status: "completed",
					summary: [{ type: "summary_text", text: thinkingText }],
				},
			});
		}
		if (messageOutputIndex !== -1) {
			writeResponsesEvent(res, {
				type: "response.output_text.done",
				item_id: messageItemId,
				output_index: messageOutputIndex,
				content_index: 0,
				text,
			});
			writeResponsesEvent(res, {
				type: "response.output_item.done",
				output_index: messageOutputIndex,
				item: {
					id: messageItemId,
					type: "message",
					status: "completed",
					role: "assistant",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			});
		}
		writeResponsesEvent(res, {
			type: "response.completed",
			response: buildResponsesResponse(request, responseId, createdAt, completion, "completed", previousResponseId),
		});
		res.end();
	}
	return completion;
}

async function completeResponsesViaRotator(
	req: IncomingMessage,
	res: ServerResponse,
	rotator: AccountRotator,
	request: OpenAIResponsesRequest,
	body: RequestBody,
	responseId: string,
	previousResponseId: string | null,
): Promise<{ completion: CompatCompletion; status: number; errorText?: string; streamed: boolean }> {
	const createdAt = Math.floor(Date.now() / 1000);
	const outcome = await withRotation(rotator, body.model, flattenHeaders(req.headers), body,
		async (response) => {
			const completion = await streamResponsesSse(response.body, req, res, request, responseId, previousResponseId, createdAt);
			if (completion.inputTokens > 0 || completion.outputTokens > 0) {
				rotator.recordTokenUsage(body.displayModel || body.model, completion.inputTokens, completion.outputTokens);
			}
			return completion;
		},
	);
	if (!outcome.ok) {
		return {
			completion: { text: "", inputTokens: 0, outputTokens: 0 },
			status: outcome.status,
			errorText: outcome.retryAfterMs ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}` : outcome.errorText,
			streamed: false,
		};
	}
	return { completion: outcome.result, status: 200, streamed: true };
}

async function completeViaRotator(
	req: IncomingMessage,
	res: ServerResponse,
	rotator: AccountRotator,
	body: RequestBody,
	streamMode: "none" | "openai" | "anthropic",
): Promise<{ completion: CompatCompletion; status: number; errorText?: string; streamed: boolean }> {
	const outcome = await withRotation(rotator, body.model, flattenHeaders(req.headers), body,
		async (response) => {
			if (streamMode === "none") {
				const raw = await response.text();
				const completion = parseAntigravitySse(raw);
				if (completion.inputTokens > 0 || completion.outputTokens > 0) {
					rotator.recordTokenUsage(body.displayModel || body.model, completion.inputTokens, completion.outputTokens);
				}
				return completion;
			} else {
				const completion = await streamCompatSse(response.body, req, res, body.displayModel || body.model, streamMode);
				if (completion.inputTokens > 0 || completion.outputTokens > 0) {
					rotator.recordTokenUsage(body.displayModel || body.model, completion.inputTokens, completion.outputTokens);
				}
				return completion;
			}
		},
	);
	if (!outcome.ok) {
		if (outcome.status === 404) {
			compatLogger.warn(
				`Compat upstream 404 endpoint=${outcome.endpoint || "unknown"} ${summarizeCompatRequest(body)} error=${(outcome.errorText || "").slice(0, 300)}`,
			);
		}
		return {
			completion: { text: "", inputTokens: 0, outputTokens: 0 },
			status: outcome.status,
			errorText: outcome.retryAfterMs ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}` : outcome.errorText,
			streamed: false,
		};
	}
	return { completion: outcome.result, status: 200, streamed: streamMode !== "none" };
}


const MODEL_CATALOG = [
	{ id: "gemini-3.5-flash-medium", family: "gemini-3.5-flash", ctx: 1048576, quotaPool: "gemini-3.5-flash", multimodal: true, tools: true },
	{ id: "gemini-3.5-flash-high", family: "gemini-3.5-flash", ctx: 1048576, quotaPool: "gemini-3.5-flash", multimodal: true, tools: true },
	{ id: "gemini-3-flash", family: "gemini-3.5-flash", ctx: 1048576, quotaPool: "gemini-3.5-flash", multimodal: true, tools: true },
	{ id: "gemini-3.1-pro-low", family: "gemini-3.1-pro", ctx: 1048576, quotaPool: "gemini-3.1-pro", multimodal: true, tools: true },
	{ id: "gemini-3.1-pro-high", family: "gemini-3.1-pro", ctx: 1048576, quotaPool: "gemini-3.1-pro", multimodal: true, tools: true },
	{ id: "claude-sonnet-4-6", family: "claude", ctx: 500000, quotaPool: "claude-opus-4-6-thinking", multimodal: true, tools: true },
	{ id: "claude-opus-4-6-thinking", family: "claude", ctx: 500000, quotaPool: "claude-opus-4-6-thinking", multimodal: true, tools: true },
	{ id: "gpt-oss-120b-medium", family: "gpt-oss", ctx: 131072, quotaPool: "claude-opus-4-6-thinking", multimodal: false, tools: true },
] as const;

export function serveOpenAIModels(res: ServerResponse): void {
	writeJson(res, 200, {
		object: "list",
		data: MODEL_CATALOG.map(({ id, ctx, family, quotaPool, multimodal, tools }) => ({
			id,
			object: "model",
			created: 0,
			owned_by: "pi-antigravity-rotator",
			context_window: ctx,
			max_model_len: ctx,
			meta: {
				context_length: ctx,
				family,
				quota_pool: quotaPool,
				multimodal,
				tool_calling: tools,
			}
		})),
	});
}

export function serveGeminiModels(res: ServerResponse): void {
	writeJson(res, 200, {
		models: MODEL_CATALOG.map(({ id, ctx, family, quotaPool, multimodal, tools }) => ({
			name: `models/${id}`,
			baseModelId: family,
			version: "v2.0",
			displayName: id,
			description: `Pi Antigravity Rotator Gemini-compatible model entry for ${id}`,
			inputTokenLimit: ctx,
			outputTokenLimit: ctx,
			supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
			capabilities: {
				tools,
				multimodal,
				quotaPool,
			},
		})),
	});
}

export async function handleGeminiGenerateContent(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { error: { message: "Payload too large", status: "INVALID_ARGUMENT" } });
		return writeJson(res, 400, { error: { message: "Invalid JSON body", status: "INVALID_ARGUMENT" } });
	}
	if (!isRecord(parsed)) return writeJson(res, 400, { error: { message: "Body must be an object", status: "INVALID_ARGUMENT" } });

	const pathname = new URL(req.url || "/", "http://localhost").pathname;
	const modelToken = pathname.match(/\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/)?.[1];
	const model = modelToken ? decodeURIComponent(modelToken).replace(/^models\//, "") : null;
	if (!model) return writeJson(res, 400, { error: { message: "Model path is required", status: "INVALID_ARGUMENT" } });

	const body: RequestBody = {
		model,
		project: "",
		request: {
			contents: Array.isArray(parsed.contents) ? parsed.contents : [],
			systemInstruction: parsed.systemInstruction,
			generationConfig: parsed.generationConfig,
			tools: parsed.tools,
		},
	};
	const result = await completeViaRotator(req, res, rotator, body, "none");
	if (result.status !== 200) {
		return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", status: "UPSTREAM_ERROR" } });
	}
	if (result.streamed) return;
	writeJson(res, 200, {
		candidates: [{
			content: {
				role: "model",
				parts: [{ text: result.completion.text }],
			},
			finishReason: "STOP",
		}],
		usageMetadata: {
			promptTokenCount: result.completion.inputTokens,
			candidatesTokenCount: result.completion.outputTokens,
			totalTokenCount: result.completion.inputTokens + result.completion.outputTokens,
		},
	});
}

export async function handleOpenAIChatCompletions(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { error: { message: "Payload too large", type: "invalid_request_error" } });
		return writeJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
	}
	const validation = validateOpenAIChatCompletionRequest(normalizeOpenAIChatCompletionRequest(parsed));
	if (!validation.ok) return writeJson(res, 400, { error: { message: validation.errors.join("; "), type: "invalid_request_error" } });

	const started = Date.now();
	const streamMode = validation.value.stream ? "openai" : "none";
	const result = await completeViaRotator(req, res, rotator, openAIToAntigravityBody(validation.value), streamMode);
	if (result.status !== 200) {
		compatLogger.warn(`OpenAI compat upstream failed status=${result.status} model=${validation.value.model}`);
		if (!res.headersSent) {
			return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", type: "upstream_error" } });
		}
		return;
	}
	if (result.streamed) {
		return;
	}
	const hasToolCalls = result.completion.toolCalls && result.completion.toolCalls.length > 0;
	writeJson(res, 200, {
		id: `chatcmpl-${started.toString(36)}`,
		object: "chat.completion",
		created: Math.floor(started / 1000),
		model: validation.value.model,
		choices: [{
			index: 0,
			message: {
				role: "assistant",
				...(hasToolCalls
					? { content: null, tool_calls: result.completion.toolCalls }
					: { content: result.completion.text }
				),
				...(result.completion.thinkingText ? { reasoning_content: result.completion.thinkingText } : {})
			},
			finish_reason: hasToolCalls ? "tool_calls" : "stop",
		}],
		usage: {
			prompt_tokens: result.completion.inputTokens,
			completion_tokens: result.completion.outputTokens,
			total_tokens: result.completion.inputTokens + result.completion.outputTokens,
		},
	});
}

export async function handleOpenAIResponsesCreate(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { error: { message: "Payload too large", type: "invalid_request_error" } });
		return writeJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
	}

	const normalized = normalizeOpenAIResponsesRequest(parsed);
	const validation = validateOpenAIResponsesRequest(normalized);
	if (!validation.ok) return writeJson(res, 400, { error: { message: validation.errors.join("; "), type: "invalid_request_error" } });

	let converted: ResponsesConversionResult;
	try {
		converted = convertResponsesToChatRequest(validation.value);
	} catch (err) {
		return writeJson(res, 400, { error: { message: err instanceof Error ? err.message : String(err), type: "invalid_request_error" } });
	}

	const responseId = makeCompatId("resp");
	const createdAt = Math.floor(Date.now() / 1000);
	const requestBody = openAIToAntigravityBody(converted.chatRequest);
	requestBody.requestId = responseId;

	if (validation.value.store !== false) {
		setStoredResponse(responseId, {
			response: buildResponsesResponse(validation.value, responseId, createdAt, { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] }, "in_progress", converted.previousResponseId),
			inputItems: converted.inputItems,
			conversationMessages: converted.conversationMessages,
			callIdToName: new Map(),
			expiresAt: Date.now() + RESPONSES_STORE_TTL_MS,
		});
	}

	if (validation.value.stream) {
		const result = await completeResponsesViaRotator(req, res, rotator, validation.value, requestBody, responseId, converted.previousResponseId);
		if (result.status !== 200) {
			responsesStore.delete(responseId);
			if (!res.headersSent) return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", type: "upstream_error" } });
			return;
		}
		if (validation.value.store !== false) {
			const responseObject = buildResponsesResponse(validation.value, responseId, createdAt, result.completion, "completed", converted.previousResponseId);
			saveResponsesEntry(responseObject, converted.inputItems, converted.conversationMessages, result.completion);
		}
		return;
	}

	const result = await completeViaRotator(req, res, rotator, requestBody, "none");
	if (result.status !== 200) {
		responsesStore.delete(responseId);
		return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", type: "upstream_error" } });
	}

	const responseObject = buildResponsesResponse(validation.value, responseId, createdAt, result.completion, "completed", converted.previousResponseId);
	if (validation.value.store !== false) {
		saveResponsesEntry(responseObject, converted.inputItems, converted.conversationMessages, result.completion);
	} else {
		responsesStore.delete(responseId);
	}
	writeJson(res, 200, responseObject);
}

export function handleOpenAIResponsesRetrieve(_req: IncomingMessage, res: ServerResponse, responseId: string): void {
	const entry = getStoredResponse(responseId);
	if (!entry) return writeJson(res, 404, { error: { message: `Response not found: ${responseId}`, type: "invalid_request_error" } });
	writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesDelete(_req: IncomingMessage, res: ServerResponse, responseId: string): void {
	writeJson(res, 200, { id: responseId, object: "response.deleted", deleted: responsesStore.delete(responseId) });
}

export function handleOpenAIResponsesCancel(_req: IncomingMessage, res: ServerResponse, responseId: string): void {
	const entry = getStoredResponse(responseId);
	if (!entry) return writeJson(res, 404, { error: { message: `Response not found: ${responseId}`, type: "invalid_request_error" } });
	if (entry.response.status === "in_progress") entry.response.status = "cancelled";
	writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesInputItems(_req: IncomingMessage, res: ServerResponse, responseId: string): void {
	const entry = getStoredResponse(responseId);
	if (!entry) return writeJson(res, 404, { error: { message: `Response not found: ${responseId}`, type: "invalid_request_error" } });
	writeJson(res, 200, { object: "list", data: entry.inputItems, has_more: false, first_id: entry.inputItems[0]?.id ?? null, last_id: entry.inputItems.at(-1)?.id ?? null });
}

export async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { type: "error", error: { type: "invalid_request_error", message: "Payload too large" } });
		return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
	}
	const validation = validateAnthropicMessagesRequest(normalizeAnthropicMessagesRequest(parsed));
	if (!validation.ok) return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: validation.errors.join("; ") } });

	const started = Date.now();
	const streamMode = validation.value.stream ? "anthropic" : "none";
	const result = await completeViaRotator(req, res, rotator, anthropicToAntigravityBody(validation.value), streamMode);
	if (result.status !== 200) {
		compatLogger.warn(`Anthropic compat upstream failed status=${result.status} model=${validation.value.model}`);
		if (!res.headersSent) {
			return writeJson(res, result.status, { type: "error", error: { type: "upstream_error", message: result.errorText || "Upstream error" } });
		}
		return;
	}
	if (result.streamed) {
		return;
	}
	const contentBlocks: Array<Record<string, unknown>> = [];
	if (result.completion.thinkingText) {
		contentBlocks.push({ type: "thinking", thinking: result.completion.thinkingText });
	}
	if (result.completion.text) {
		contentBlocks.push({ type: "text", text: result.completion.text });
	}
	if (result.completion.toolCalls && result.completion.toolCalls.length > 0) {
		for (const tc of result.completion.toolCalls) {
			let parsedInput: unknown;
			try { parsedInput = JSON.parse(tc.function.arguments || "{}"); } catch { parsedInput = {}; }
			contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsedInput });
		}
	}
	const stopReason = (result.completion.toolCalls && result.completion.toolCalls.length > 0) ? "tool_use" : "end_turn";
	writeJson(res, 200, {
		id: `msg_${started.toString(36)}`,
		type: "message",
		role: "assistant",
		model: validation.value.model,
		content: contentBlocks,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: {
			input_tokens: result.completion.inputTokens,
			output_tokens: result.completion.outputTokens,
		},
	});
}
