import type { IncomingMessage, ServerResponse } from "node:http";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { logger } from "./logger.js";
import type { AccountRotator } from "./rotator.js";
import { resolveQuotaModelKey } from "./types.js";
import { forwardRequest, flattenHeaders, type RequestBody } from "./proxy.js";

const compatLogger = logger.child("compat");

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | Array<{ type: string; text?: string; [key: string]: unknown }> | null;
}

export interface OpenAIChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	[key: string]: unknown;
}

export interface AnthropicMessagesRequest {
	model: string;
	messages: ChatMessage[];
	system?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	[key: string]: unknown;
}

export interface CompatCompletion {
	text: string;
	inputTokens: number;
	outputTokens: number;
	responseId?: string;
}

type AntigravityPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function extractText(content: ChatMessage["content"]): string {
	return extractParts(content).filter((part): part is { text: string } => "text" in part).map((part) => part.text).join("\n");
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

function hasUnsupportedTools(value: Record<string, unknown>): boolean {
	return (Array.isArray(value.tools) && value.tools.length > 0) || value.tool_choice !== undefined || Array.isArray(value.functions) || value.function_call !== undefined;
}

function validateMessages(value: unknown): value is ChatMessage[] {
	return Array.isArray(value) && value.every((msg) => {
		if (!isRecord(msg)) return false;
		if (!["system", "user", "assistant", "tool"].includes(String(msg.role))) return false;
		return typeof msg.content === "string" || msg.content === null || Array.isArray(msg.content);
	});
}

export function validateOpenAIChatCompletionRequest(value: unknown): { ok: true; value: OpenAIChatCompletionRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!validateMessages(value.messages)) errors.push("body.messages must be an array of chat messages");
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_tokens !== undefined && typeof value.max_tokens !== "number") errors.push("body.max_tokens must be number when provided");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as OpenAIChatCompletionRequest };
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

export function openAIToAntigravityBody(input: OpenAIChatCompletionRequest): RequestBody {
	const parts: AntigravityPart[] = [];
	for (const msg of input.messages) {
		const prefix = msg.role === "system" ? "System" : msg.role === "assistant" ? "Assistant" : msg.role === "tool" ? "Tool" : "User";
		const msgParts = extractParts(msg.content);
		const textParts = msgParts.filter((part): part is { text: string } => "text" in part);
		const imageParts = msgParts.filter((part): part is { inlineData: { mimeType: string; data: string } } => "inlineData" in part);
		if (textParts.length > 0) parts.push({ text: `${prefix}: ${textParts.map((part) => part.text).join("\n")}` });
		parts.push(...imageParts);
	}

	return {
		project: "compat-placeholder",
		model: input.model,
		requestType: "agent",
		request: {
			contents: [{ role: "user", parts: parts.length > 0 ? parts : [{ text: "Hello" }] }],
			generationConfig: {
				...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
				...(typeof input.max_tokens === "number" ? { maxOutputTokens: input.max_tokens } : {}),
			},
		},
	};
}

export function anthropicToAntigravityBody(input: AnthropicMessagesRequest): RequestBody {
	const systemText = typeof input.system === "string" ? input.system : Array.isArray(input.system) ? extractText(input.system as ChatMessage["content"]) : "";
	return openAIToAntigravityBody({
		model: input.model,
		stream: input.stream,
		temperature: input.temperature,
		max_tokens: input.max_tokens,
		messages: [
			...(systemText ? [{ role: "system" as const, content: systemText }] : []),
			...input.messages,
		],
	});
}

export function parseAntigravitySse(raw: string): CompatCompletion {
	let text = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let responseId: string | undefined;

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
					if (isRecord(part) && typeof part.text === "string") text += part.text;
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

	return { text, inputTokens, outputTokens, responseId };
}

function writeJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(payload));
}

function writeOpenAIStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const created = Math.floor(Date.now() / 1000);
	const id = `chatcmpl-${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
	if (completion.text) {
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] })}\n\n`);
	}
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

function writeAnthropicStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const id = `msg_${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: completion.inputTokens, output_tokens: 0 } } })}\n\n`);
	res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
	if (completion.text) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: completion.text } })}\n\n`);
	res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
	res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: completion.outputTokens } })}\n\n`);
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

async function completeViaRotator(
	req: IncomingMessage,
	rotator: AccountRotator,
	body: RequestBody,
): Promise<{ completion: CompatCompletion; status: number; errorText?: string }> {
	const modelKey = resolveQuotaModelKey(body.model) ?? undefined;
	let lastErrorText = "All accounts exhausted or disabled";

	for (let attempt = 0; attempt < 2; attempt++) {
		const account = await rotator.getActiveAccount(body.model);
		if (!account) {
			const retryAfterMs = rotator.getRetryAfterMs(body.model);
			return {
				completion: { text: "", inputTokens: 0, outputTokens: 0 },
				status: retryAfterMs > 0 ? 429 : 503,
				errorText: retryAfterMs > 0 ? `${lastErrorText}; retryAfterMs=${retryAfterMs}` : lastErrorText,
			};
		}

		try {
			rotator.recordUpstreamAttempt(account);
			const response = await forwardRequest(account, body, flattenHeaders(req.headers));
			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				lastErrorText = errorText || `Upstream returned ${response.status}`;
				if (response.status === 429) {
					const retryAfterSeconds = Number(response.headers.get("retry-after"));
					const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 60_000;
					rotator.markExhausted(account, body.model, cooldownMs);
					rotator.recordProvider429(account, body.model, cooldownMs);
					return { completion: { text: "", inputTokens: 0, outputTokens: 0 }, status: 429, errorText: lastErrorText };
				}
				if (response.status >= 500 && attempt === 0) {
					rotator.markError(account, `${response.status}: ${lastErrorText.slice(0, 200)}`);
					await rotator.rotateToNext(body.model);
					continue;
				}
				return { completion: { text: "", inputTokens: 0, outputTokens: 0 }, status: response.status, errorText: lastErrorText };
			}
			const raw = await response.text();
			const completion = parseAntigravitySse(raw);
			rotator.recordRequest(account, body.model);
			if (completion.inputTokens > 0 || completion.outputTokens > 0) {
				rotator.recordTokenUsage(body.model, completion.inputTokens, completion.outputTokens);
			}
			return { completion, status: 200 };
		} catch (err) {
			lastErrorText = err instanceof Error ? err.message : String(err);
			rotator.markError(account, lastErrorText.slice(0, 200));
			if (attempt === 0) {
				await rotator.rotateToNext(body.model);
				continue;
			}
			return { completion: { text: "", inputTokens: 0, outputTokens: 0 }, status: 502, errorText: lastErrorText };
		} finally {
			rotator.finishRequest(account, modelKey);
		}
	}

	return { completion: { text: "", inputTokens: 0, outputTokens: 0 }, status: 502, errorText: lastErrorText };
}

export function serveOpenAIModels(res: ServerResponse): void {
	writeJson(res, 200, {
		object: "list",
		data: ["gemini-3-flash", "gemini-3.1-pro-low", "gemini-3.1-pro-high", "claude-sonnet-4-6", "claude-opus-4-6-thinking"].map((id) => ({
			id,
			object: "model",
			created: 0,
			owned_by: "pi-antigravity-rotator",
		})),
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
	const validation = validateOpenAIChatCompletionRequest(parsed);
	if (!validation.ok) return writeJson(res, 400, { error: { message: validation.errors.join("; "), type: "invalid_request_error" } });
	if (hasUnsupportedTools(parsed as Record<string, unknown>)) return writeJson(res, 400, { error: { message: "Tool/function calling is not implemented in compatibility adapters yet", type: "invalid_request_error" } });

	const started = Date.now();
	const result = await completeViaRotator(req, rotator, openAIToAntigravityBody(validation.value));
	if (result.status !== 200) {
		compatLogger.warn(`OpenAI compat upstream failed status=${result.status} model=${validation.value.model}`);
		return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", type: "upstream_error" } });
	}
	if (validation.value.stream) {
		writeOpenAIStream(res, validation.value.model, result.completion);
		return;
	}
	writeJson(res, 200, {
		id: `chatcmpl-${started.toString(36)}`,
		object: "chat.completion",
		created: Math.floor(started / 1000),
		model: validation.value.model,
		choices: [{ index: 0, message: { role: "assistant", content: result.completion.text }, finish_reason: "stop" }],
		usage: {
			prompt_tokens: result.completion.inputTokens,
			completion_tokens: result.completion.outputTokens,
			total_tokens: result.completion.inputTokens + result.completion.outputTokens,
		},
	});
}

export async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { type: "error", error: { type: "invalid_request_error", message: "Payload too large" } });
		return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
	}
	const validation = validateAnthropicMessagesRequest(parsed);
	if (!validation.ok) return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: validation.errors.join("; ") } });
	if (hasUnsupportedTools(parsed as Record<string, unknown>)) return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Tool/function calling is not implemented in compatibility adapters yet" } });

	const started = Date.now();
	const result = await completeViaRotator(req, rotator, anthropicToAntigravityBody(validation.value));
	if (result.status !== 200) {
		compatLogger.warn(`Anthropic compat upstream failed status=${result.status} model=${validation.value.model}`);
		return writeJson(res, result.status, { type: "error", error: { type: "upstream_error", message: result.errorText || "Upstream error" } });
	}
	if (validation.value.stream) {
		writeAnthropicStream(res, validation.value.model, result.completion);
		return;
	}
	writeJson(res, 200, {
		id: `msg_${started.toString(36)}`,
		type: "message",
		role: "assistant",
		model: validation.value.model,
		content: [{ type: "text", text: result.completion.text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: result.completion.inputTokens,
			output_tokens: result.completion.outputTokens,
		},
	});
}
