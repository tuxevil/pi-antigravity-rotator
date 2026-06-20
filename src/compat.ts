import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { logger, redactSensitive } from "./logger.js";
import type { AccountRotator } from "./rotator.js";
import { applyModelAlias, resolveQuotaModelKey } from "./types.js";
import { withRotation, flattenHeaders, type RequestBody } from "./proxy.js";
import { ResponsesStore, type StoredResponseEntry } from "./responses-store.js";
import {
  isRecord,
  sanitizeGeminiSchema,
  sanitizeClaudeViaGeminiSchema,
} from "./compat/schema-sanitizer.js";
import {
  DEFAULT_MODEL_SPECS,
  setModelSpecsOverride,
  getActiveModelSpecs,
  getModelFamily,
  getModelSpec,
  isThinkingModel,
} from "./compat/model-specs.js";
import type { ModelSpec } from "./compat/model-specs.js";
import {
  thoughtSignatureCache,
  responsesStore,
  makeCompatId,
  getStoredResponse,
  setStoredResponse,
  resetResponsesStoreForTests,
  loadResponsesStore,
  flushResponsesStore,
  flushResponsesStoreSync,
  cacheThoughtSignature,
} from "./compat/cache.js";
import {
  isNonEmptyString,
  extractText,
  extractParts,
  normalizeOpenAIChatCompletionRequest,
  normalizeOpenAIResponsesRequest,
  normalizeAnthropicMessagesRequest,
  convertResponsesToChatRequest,
  openAIToAntigravityBody,
  anthropicToAntigravityBody,
  mapReasoningEffortToThinkingLevel,
  validateOpenAIChatCompletionRequest,
  validateOpenAIResponsesRequest,
  validateAnthropicMessagesRequest,
  buildResponsesResponse,
  saveResponsesEntry,
} from "./compat/translators.js";
import type {
  ChatMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIChatCompletionRequest,
  OpenAIResponsesRequest,
  AnthropicMessagesRequest,
  CompatCompletion,
  AntigravityPart,
  GeminiContent,
  ResponsesConversionResult,
} from "./compat/translators.js";

export {
  isRecord,
  sanitizeGeminiSchema,
  sanitizeClaudeViaGeminiSchema,
  DEFAULT_MODEL_SPECS,
  setModelSpecsOverride,
  getActiveModelSpecs,
  getModelFamily,
  getModelSpec,
  isThinkingModel,
  resetResponsesStoreForTests,
  loadResponsesStore,
  flushResponsesStore,
  flushResponsesStoreSync,
  normalizeOpenAIChatCompletionRequest,
  normalizeOpenAIResponsesRequest,
  normalizeAnthropicMessagesRequest,
  openAIToAntigravityBody,
  anthropicToAntigravityBody,
  validateOpenAIChatCompletionRequest,
  validateOpenAIResponsesRequest,
  validateAnthropicMessagesRequest,
};
export type {
  ModelSpec,
  ChatMessage,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIChatCompletionRequest,
  OpenAIResponsesRequest,
  AnthropicMessagesRequest,
  CompatCompletion,
};

const compatLogger = logger.child("compat");

const VALIDATION_LOG_MAX_CHARS = 200;

export function logValidationFailure(scope: string, payload: unknown): void {
  const truncated = redactSensitive(JSON.stringify(payload));
  const clipped =
    truncated.length > VALIDATION_LOG_MAX_CHARS
      ? `${truncated.slice(0, VALIDATION_LOG_MAX_CHARS)}…[+${truncated.length - VALIDATION_LOG_MAX_CHARS} chars]`
      : truncated;
  compatLogger.warn(`${scope}: ${clipped}`);
}

// Interfaces and types have been moved to src/compat/translators.ts

// Response Output types
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

type ResponseOutputItem =
  | ResponseMessageOutputItem
  | ResponseFunctionCallOutputItem;

// Cache and stores have been moved to src/compat/cache.ts

// Helper and translation functions have been moved to src/compat/translators.ts

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
      if (!responseId && typeof response.responseId === "string")
        responseId = response.responseId;
      const candidates = Array.isArray(response.candidates)
        ? response.candidates
        : [];
      for (const candidate of candidates) {
        if (
          !isRecord(candidate) ||
          !isRecord(candidate.content) ||
          !Array.isArray(candidate.content.parts)
        )
          continue;
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
            if (
              typeof part.thoughtSignature === "string" &&
              part.thoughtSignature
            ) {
              cacheThoughtSignature(callId, part.thoughtSignature);
            }
            toolCallsMap.set(name + callId, {
              id: callId,
              type: "function",
              function: { name, arguments: args },
            });
          }
        }
      }
      const usage = isRecord(response.usageMetadata)
        ? response.usageMetadata
        : isRecord(response.usage)
          ? response.usage
          : null;
      if (usage) {
        if (typeof usage.promptTokenCount === "number")
          inputTokens = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === "number")
          outputTokens = usage.candidatesTokenCount;
        if (typeof usage.input_tokens === "number")
          inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number")
          outputTokens = usage.output_tokens;
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
    toolCallsMap.set(name + callId, {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    });
  }
  parsedText = parsedText.replace(legacyRegex, "");

  // Intercept new hallucinated XML format: <tool_call name="name">args</tool_call>
  const xmlRegex = /<tool_call name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  while ((match = xmlRegex.exec(parsedText)) !== null) {
    const name = match[1];
    const args = match[2].trim();
    const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
    toolCallsMap.set(name + callId, {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    });
  }
  parsedText = parsedText.replace(xmlRegex, "");

  parsedText = parsedText.trim();

  const toolCalls =
    toolCallsMap.size > 0 ? [...toolCallsMap.values()] : undefined;
  return {
    text: parsedText,
    thinkingText: thinkingText || undefined,
    inputTokens,
    outputTokens,
    responseId,
    toolCalls,
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function writeResponsesEvent(
  res: ServerResponse,
  payload: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function summarizeCompatRequest(body: RequestBody): string {
  const request = isRecord(body.request) ? body.request : {};
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const tools = Array.isArray(request.tools) ? request.tools.length : 0;
  const systemInstruction = isRecord(request.systemInstruction) ? "yes" : "no";
  return `model=${body.model} userAgent=${body.userAgent || "none"} turns=${contents.length} tools=${tools} systemInstruction=${systemInstruction}`;
}

function writeOpenAIStream(
  res: ServerResponse,
  model: string,
  completion: CompatCompletion,
): void {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now().toString(36)}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
  );
  // Emit reasoning/thinking content first if present
  if (completion.thinkingText) {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: completion.thinkingText }, finish_reason: null }] })}\n\n`,
    );
  }
  if (completion.toolCalls && completion.toolCalls.length > 0) {
    // Emit tool_call deltas
    for (let i = 0; i < completion.toolCalls.length; i++) {
      const tc = completion.toolCalls[i];
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    );
  } else {
    if (completion.text) {
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
  }
  // Emit usage chunk so agents (hermes, openwebui) can display token statistics
  if (completion.inputTokens > 0 || completion.outputTokens > 0) {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: completion.inputTokens, completion_tokens: completion.outputTokens, total_tokens: completion.inputTokens + completion.outputTokens } })}\n\n`,
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeAnthropicStream(
  res: ServerResponse,
  model: string,
  completion: CompatCompletion,
): void {
  const id = `msg_${Date.now().toString(36)}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: completion.inputTokens, output_tokens: 0 } } })}\n\n`,
  );
  let contentIndex = 0;
  // Emit thinking block first if present (Anthropic format)
  if (completion.thinkingText) {
    res.write(
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`,
    );
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "thinking_delta", thinking: completion.thinkingText } })}\n\n`,
    );
    res.write(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`,
    );
    contentIndex++;
  }
  if (completion.text) {
    res.write(
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "text", text: "" } })}\n\n`,
    );
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "text_delta", text: completion.text } })}\n\n`,
    );
    res.write(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`,
    );
    contentIndex++;
  }
  // Emit tool_use content blocks if present
  let hasToolUse = false;
  if (completion.toolCalls && completion.toolCalls.length > 0) {
    hasToolUse = true;
    for (const tc of completion.toolCalls) {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(tc.function.arguments || "{}");
      } catch {
        parsedInput = {};
      }
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} } })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: contentIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`,
      );
      res.write(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentIndex })}\n\n`,
      );
      contentIndex++;
    }
  }
  const stopReason = hasToolUse ? "tool_use" : "end_turn";
  // message_delta: include both input_tokens and output_tokens so hermes shows full context count
  res.write(
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: completion.inputTokens, output_tokens: completion.outputTokens } })}\n\n`,
  );
  res.write(
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  );
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    const body = await readLimitedBody(req);
    return JSON.parse(body.toString("utf-8"));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw err;
    throw new Error("Invalid JSON body", { cause: err });
  }
}

async function streamCompatSse(
  body: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  format: "openai" | "anthropic",
): Promise<CompatCompletion> {
  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let responseId: string | undefined;
  let toolCallIndex = 0;

  const created = Math.floor(Date.now() / 1000);
  const id =
    format === "openai"
      ? `chatcmpl-${Date.now().toString(36)}`
      : `msg_${Date.now().toString(36)}`;

  const openaiToolCalls: OpenAIToolCall[] = [];
  let anthropicActiveBlockIndex = -1;
  let anthropicActiveBlockType: "thinking" | "text" | null = null;
  let anthropicHasToolUse = false;
  const anthropicToolCalls: OpenAIToolCall[] = [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (format === "openai") {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    );
  } else if (format === "anthropic") {
    res.write(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    );
  }

  let tailBuffer = "";
  let reqClosed = false;
  req.once("close", () => {
    reqClosed = true;
  });

  try {
    for await (const chunk of nodeStream) {
      if (reqClosed) {
        nodeStream.destroy();
        break;
      }
      const str = chunk.toString();
      tailBuffer += str;
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
          if (!responseId && typeof response.responseId === "string")
            responseId = response.responseId;

          const candidates = Array.isArray(response.candidates)
            ? response.candidates
            : [];
          if (candidates.length > 0 && candidates[0]?.content?.parts) {
            // DEBUG LOGGING to see what Google is actually sending for thinking
            if (
              candidates[0].content.parts.some(
                (p: any) => p.thought === true || p.text,
              )
            ) {
              console.log(
                `[DEBUG] Received parts:`,
                JSON.stringify(candidates[0].content.parts),
              );
            }
          }
          for (const candidate of candidates) {
            if (
              !isRecord(candidate) ||
              !isRecord(candidate.content) ||
              !Array.isArray(candidate.content.parts)
            )
              continue;
            for (const part of candidate.content.parts) {
              if (!isRecord(part)) continue;
              if (typeof part.text === "string" && part.text) {
                if (part.thought === true) {
                  // Thought block → reasoning_content (OpenAI) or thinking_delta (Anthropic)
                  if (format === "openai") {
                    res.write(
                      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: part.text }, finish_reason: null }] })}\n\n`,
                    );
                  } else {
                    if (anthropicActiveBlockType !== "thinking") {
                      if (anthropicActiveBlockType === "text") {
                        res.write(
                          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                        );
                      }
                      anthropicActiveBlockIndex = 0;
                      anthropicActiveBlockType = "thinking";
                      res.write(
                        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "thinking", thinking: "" } })}\n\n`,
                      );
                    }
                    res.write(
                      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "thinking_delta", thinking: part.text } })}\n\n`,
                    );
                  }
                } else {
                  text += part.text;
                  if (format === "openai") {
                    res.write(
                      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] })}\n\n`,
                    );
                  } else {
                    if (anthropicActiveBlockType !== "text") {
                      if (anthropicActiveBlockType === "thinking") {
                        res.write(
                          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                        );
                        anthropicActiveBlockIndex = 1;
                      } else {
                        anthropicActiveBlockIndex = 0;
                      }
                      anthropicActiveBlockType = "text";
                      res.write(
                        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "text", text: "" } })}\n\n`,
                      );
                    }
                    res.write(
                      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "text_delta", text: part.text } })}\n\n`,
                    );
                  }
                }
              } else if (isRecord(part.functionCall)) {
                const fc = part.functionCall;
                const name = typeof fc.name === "string" ? fc.name : "unknown";
                const args =
                  fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
                const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
                // Cache thought_signature so we can re-inject it on the next turn
                if (
                  typeof part.thoughtSignature === "string" &&
                  part.thoughtSignature
                ) {
                  cacheThoughtSignature(callId, part.thoughtSignature);
                }
                if (format === "openai") {
                  openaiToolCalls.push({
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  });
                  res.write(
                    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex - 1, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] })}\n\n`,
                  );
                } else {
                  // Close any active text/thinking block before emitting tool_use
                  if (anthropicActiveBlockType !== null) {
                    res.write(
                      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                    );
                    anthropicActiveBlockType = null;
                  }
                  anthropicActiveBlockIndex++;
                  anthropicHasToolUse = true;
                  anthropicToolCalls.push({
                    id: callId,
                    type: "function",
                    function: { name, arguments: args },
                  });
                  let parsedInput: unknown;
                  try {
                    parsedInput = JSON.parse(args);
                  } catch {
                    parsedInput = {};
                  }
                  res.write(
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: anthropicActiveBlockIndex, content_block: { type: "tool_use", id: callId, name, input: {} } })}\n\n`,
                  );
                  res.write(
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: anthropicActiveBlockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedInput) } })}\n\n`,
                  );
                  res.write(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
                  );
                }
              }
            }
          }
          const usage = isRecord(response.usageMetadata)
            ? response.usageMetadata
            : isRecord(response.usage)
              ? response.usage
              : null;
          if (usage) {
            if (typeof usage.promptTokenCount === "number")
              inputTokens = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === "number")
              outputTokens = usage.candidatesTokenCount;
            if (typeof usage.input_tokens === "number")
              inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
              outputTokens = usage.output_tokens;
          }
        } catch {
          // Ignore malformed JSON chunks
        }
      }
    }
  } catch (err) {
    compatLogger.warn(
      `Stream read error: ${redactSensitive(String(err)).slice(0, 200)}`,
    );
  }

  if (!reqClosed && !res.writableEnded) {
    if (format === "openai") {
      const openaiFinishReason = toolCallIndex > 0 ? "tool_calls" : "stop";
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: openaiFinishReason }] })}\n\n`,
      );
      // Emit a usage chunk so agents (hermes, openwebui, etc.) can display token statistics
      if (inputTokens > 0 || outputTokens > 0) {
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
    } else {
      if (anthropicActiveBlockType !== null) {
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicActiveBlockIndex })}\n\n`,
        );
      }
      const anthropicStopReason = anthropicHasToolUse ? "tool_use" : "end_turn";
      // message_delta carries output_tokens; also include input_tokens so Hermes shows full context count
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anthropicStopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } })}\n\n`,
      );
      res.write(
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    }
    res.end();
  }

  const collectedToolCalls =
    openaiToolCalls.length > 0
      ? openaiToolCalls
      : anthropicToolCalls.length > 0
        ? anthropicToolCalls
        : undefined;
  return {
    text,
    inputTokens,
    outputTokens,
    responseId,
    toolCalls: collectedToolCalls,
  };
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
  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
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
  req.once("close", () => {
    reqClosed = true;
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emptyCompletion: CompatCompletion = {
    text: "",
    thinkingText: undefined,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
  };
  writeResponsesEvent(res, {
    type: "response.created",
    response: buildResponsesResponse(
      request,
      responseId,
      createdAt,
      emptyCompletion,
      "in_progress",
      previousResponseId,
    ),
  });
  writeResponsesEvent(res, {
    type: "response.in_progress",
    response: buildResponsesResponse(
      request,
      responseId,
      createdAt,
      emptyCompletion,
      "in_progress",
      previousResponseId,
    ),
  });

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
          const candidates = Array.isArray(response.candidates)
            ? response.candidates
            : [];
          for (const candidate of candidates) {
            if (
              !isRecord(candidate) ||
              !isRecord(candidate.content) ||
              !Array.isArray(candidate.content.parts)
            )
              continue;
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
                      item: {
                        id: reasoningItemId,
                        type: "reasoning",
                        status: "in_progress",
                        summary: [],
                      },
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
                      content: [
                        { type: "output_text", text: "", annotations: [] },
                      ],
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
                const fc = part.functionCall;
                const name = typeof fc.name === "string" ? fc.name : "unknown";
                const args =
                  fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
                const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
                if (
                  typeof part.thoughtSignature === "string" &&
                  part.thoughtSignature
                ) {
                  cacheThoughtSignature(callId, part.thoughtSignature);
                }
                toolCalls.push({
                  id: callId,
                  type: "function",
                  function: { name, arguments: args },
                });
                const item = {
                  id: makeCompatId("fc"),
                  type: "function_call",
                  call_id: callId,
                  name,
                  arguments: args,
                  status: "completed",
                };
                const outputIndex = nextOutputIndex++;
                writeResponsesEvent(res, {
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item,
                });
                writeResponsesEvent(res, {
                  type: "response.function_call_arguments.delta",
                  item_id: item.id,
                  output_index: outputIndex,
                  delta: args,
                });
                writeResponsesEvent(res, {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: outputIndex,
                  arguments: args,
                });
                writeResponsesEvent(res, {
                  type: "response.output_item.done",
                  output_index: outputIndex,
                  item,
                });
              }
            }
          }
          const usage = isRecord(response.usageMetadata)
            ? response.usageMetadata
            : isRecord(response.usage)
              ? response.usage
              : null;
          if (usage) {
            if (typeof usage.promptTokenCount === "number")
              inputTokens = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === "number")
              outputTokens = usage.candidatesTokenCount;
            if (typeof usage.input_tokens === "number")
              inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
              outputTokens = usage.output_tokens;
          }
        } catch {
          // Ignore malformed JSON chunks
        }
      }
    }
  } catch (err) {
    compatLogger.warn(
      `Responses stream read error: ${redactSensitive(String(err)).slice(0, 200)}`,
    );
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
      response: buildResponsesResponse(
        request,
        responseId,
        createdAt,
        completion,
        "completed",
        previousResponseId,
      ),
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
): Promise<{
  completion: CompatCompletion;
  status: number;
  errorText?: string;
  streamed: boolean;
}> {
  const createdAt = Math.floor(Date.now() / 1000);
  const outcome = await withRotation(
    rotator,
    body.model,
    flattenHeaders(req.headers),
    body,
    async (response) => {
      const completion = await streamResponsesSse(
        response.body,
        req,
        res,
        request,
        responseId,
        previousResponseId,
        createdAt,
      );
      if (completion.inputTokens > 0 || completion.outputTokens > 0) {
        rotator.recordTokenUsage(
          body.displayModel || body.model,
          completion.inputTokens,
          completion.outputTokens,
        );
      }
      return completion;
    },
  );
  if (!outcome.ok) {
    return {
      completion: { text: "", inputTokens: 0, outputTokens: 0 },
      status: outcome.status,
      errorText: outcome.retryAfterMs
        ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}`
        : outcome.errorText,
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
): Promise<{
  completion: CompatCompletion;
  status: number;
  errorText?: string;
  streamed: boolean;
}> {
  const outcome = await withRotation(
    rotator,
    body.model,
    flattenHeaders(req.headers),
    body,
    async (response) => {
      if (streamMode === "none") {
        const raw = await response.text();
        const completion = parseAntigravitySse(raw);
        if (completion.inputTokens > 0 || completion.outputTokens > 0) {
          rotator.recordTokenUsage(
            body.displayModel || body.model,
            completion.inputTokens,
            completion.outputTokens,
          );
        }
        return completion;
      } else {
        const completion = await streamCompatSse(
          response.body,
          req,
          res,
          body.displayModel || body.model,
          streamMode,
        );
        if (completion.inputTokens > 0 || completion.outputTokens > 0) {
          rotator.recordTokenUsage(
            body.displayModel || body.model,
            completion.inputTokens,
            completion.outputTokens,
          );
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
      errorText: outcome.retryAfterMs
        ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}`
        : outcome.errorText,
      streamed: false,
    };
  }
  return {
    completion: outcome.result,
    status: 200,
    streamed: streamMode !== "none",
  };
}

const MODEL_CATALOG = [
  {
    id: "gemini-3.5-flash-medium",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini-3.5-flash",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.5-flash-high",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini-3.5-flash",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3-flash",
    family: "gemini-3.5-flash",
    ctx: 1048576,
    quotaPool: "gemini-3.5-flash",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.1-pro-low",
    family: "gemini-3.1-pro",
    ctx: 1048576,
    quotaPool: "gemini-3.1-pro",
    multimodal: true,
    tools: true,
  },
  {
    id: "gemini-3.1-pro-high",
    family: "gemini-3.1-pro",
    ctx: 1048576,
    quotaPool: "gemini-3.1-pro",
    multimodal: true,
    tools: true,
  },
  {
    id: "claude-sonnet-4-6",
    family: "claude",
    ctx: 500000,
    quotaPool: "claude-opus-4-6-thinking",
    multimodal: true,
    tools: true,
  },
  {
    id: "claude-opus-4-6-thinking",
    family: "claude",
    ctx: 500000,
    quotaPool: "claude-opus-4-6-thinking",
    multimodal: true,
    tools: true,
  },
  {
    id: "gpt-oss-120b-medium",
    family: "gpt-oss",
    ctx: 131072,
    quotaPool: "claude-opus-4-6-thinking",
    multimodal: false,
    tools: true,
  },
] as const;

export function serveOpenAIModels(res: ServerResponse): void {
  writeJson(res, 200, {
    object: "list",
    data: MODEL_CATALOG.map(
      ({ id, ctx, family, quotaPool, multimodal, tools }) => ({
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
        },
      }),
    ),
  });
}

export function serveGeminiModels(res: ServerResponse): void {
  writeJson(res, 200, {
    models: MODEL_CATALOG.map(
      ({ id, ctx, family, quotaPool, multimodal, tools }) => ({
        name: `models/${id}`,
        baseModelId: family,
        version: "v2.0",
        displayName: id,
        description: `Pi Antigravity Rotator Gemini-compatible model entry for ${id}`,
        inputTokenLimit: ctx,
        outputTokenLimit: ctx,
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
        ],
        capabilities: {
          tools,
          multimodal,
          quotaPool,
        },
      }),
    ),
  });
}

export async function handleGeminiGenerateContent(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", status: "INVALID_ARGUMENT" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", status: "INVALID_ARGUMENT" },
    });
  }
  if (!isRecord(parsed))
    return writeJson(res, 400, {
      error: { message: "Body must be an object", status: "INVALID_ARGUMENT" },
    });

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const modelToken = pathname.match(
    /\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/,
  )?.[1];
  const model = modelToken
    ? decodeURIComponent(modelToken).replace(/^models\//, "")
    : null;
  if (!model)
    return writeJson(res, 400, {
      error: { message: "Model path is required", status: "INVALID_ARGUMENT" },
    });

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
    return writeJson(res, result.status, {
      error: {
        message: result.errorText || "Upstream error",
        status: "UPSTREAM_ERROR",
      },
    });
  }
  if (result.streamed) return;
  writeJson(res, 200, {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: result.completion.text }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: result.completion.inputTokens,
      candidatesTokenCount: result.completion.outputTokens,
      totalTokenCount:
        result.completion.inputTokens + result.completion.outputTokens,
    },
  });
}

export async function handleOpenAIChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", type: "invalid_request_error" },
    });
  }
  const validation = validateOpenAIChatCompletionRequest(
    normalizeOpenAIChatCompletionRequest(parsed),
  );
  if (!validation.ok)
    return writeJson(res, 400, {
      error: {
        message: validation.errors.join("; "),
        type: "invalid_request_error",
      },
    });

  const started = Date.now();
  const streamMode = validation.value.stream ? "openai" : "none";
  const result = await completeViaRotator(
    req,
    res,
    rotator,
    openAIToAntigravityBody(validation.value),
    streamMode,
  );
  if (result.status !== 200) {
    compatLogger.warn(
      `OpenAI compat upstream failed status=${result.status} model=${validation.value.model}`,
    );
    if (!res.headersSent) {
      return writeJson(res, result.status, {
        error: {
          message: result.errorText || "Upstream error",
          type: "upstream_error",
        },
      });
    }
    return;
  }
  if (result.streamed) {
    return;
  }
  const hasToolCalls =
    result.completion.toolCalls && result.completion.toolCalls.length > 0;
  writeJson(res, 200, {
    id: `chatcmpl-${started.toString(36)}`,
    object: "chat.completion",
    created: Math.floor(started / 1000),
    model: validation.value.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(hasToolCalls
            ? { content: null, tool_calls: result.completion.toolCalls }
            : { content: result.completion.text }),
          ...(result.completion.thinkingText
            ? { reasoning_content: result.completion.thinkingText }
            : {}),
        },
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.completion.inputTokens,
      completion_tokens: result.completion.outputTokens,
      total_tokens:
        result.completion.inputTokens + result.completion.outputTokens,
    },
  });
}

export async function handleOpenAIResponsesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    return writeJson(res, 400, {
      error: { message: "Invalid JSON body", type: "invalid_request_error" },
    });
  }

  const normalized = normalizeOpenAIResponsesRequest(parsed);
  const validation = validateOpenAIResponsesRequest(normalized);
  if (!validation.ok)
    return writeJson(res, 400, {
      error: {
        message: validation.errors.join("; "),
        type: "invalid_request_error",
      },
    });

  let converted: ResponsesConversionResult;
  try {
    converted = convertResponsesToChatRequest(validation.value);
  } catch (err) {
    return writeJson(res, 400, {
      error: {
        message: err instanceof Error ? err.message : String(err),
        type: "invalid_request_error",
      },
    });
  }

  const responseId = makeCompatId("resp");
  const createdAt = Math.floor(Date.now() / 1000);
  const requestBody = openAIToAntigravityBody(converted.chatRequest);
  requestBody.requestId = responseId;

  if (validation.value.store !== false) {
    const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    setStoredResponse(responseId, {
      response: buildResponsesResponse(
        validation.value,
        responseId,
        createdAt,
        { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] },
        "in_progress",
        converted.previousResponseId,
      ),
      inputItems: converted.inputItems,
      conversationMessages: converted.conversationMessages as unknown as Array<
        Record<string, unknown>
      >,
      callIdToName: {},
      expiresAt,
    });
  }

  if (validation.value.stream) {
    const result = await completeResponsesViaRotator(
      req,
      res,
      rotator,
      validation.value,
      requestBody,
      responseId,
      converted.previousResponseId,
    );
    if (result.status !== 200) {
      responsesStore.delete(responseId);
      if (!res.headersSent)
        return writeJson(res, result.status, {
          error: {
            message: result.errorText || "Upstream error",
            type: "upstream_error",
          },
        });
      return;
    }
    if (validation.value.store !== false) {
      const responseObject = buildResponsesResponse(
        validation.value,
        responseId,
        createdAt,
        result.completion,
        "completed",
        converted.previousResponseId,
      );
      saveResponsesEntry(
        responseObject,
        converted.inputItems,
        converted.conversationMessages,
        result.completion,
      );
    }
    return;
  }

  const result = await completeViaRotator(
    req,
    res,
    rotator,
    requestBody,
    "none",
  );
  if (result.status !== 200) {
    responsesStore.delete(responseId);
    return writeJson(res, result.status, {
      error: {
        message: result.errorText || "Upstream error",
        type: "upstream_error",
      },
    });
  }

  const responseObject = buildResponsesResponse(
    validation.value,
    responseId,
    createdAt,
    result.completion,
    "completed",
    converted.previousResponseId,
  );
  if (validation.value.store !== false) {
    saveResponsesEntry(
      responseObject,
      converted.inputItems,
      converted.conversationMessages,
      result.completion,
    );
  } else {
    responsesStore.delete(responseId);
  }
  writeJson(res, 200, responseObject);
}

export function handleOpenAIResponsesRetrieve(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  writeJson(res, 200, {
    id: responseId,
    object: "response.deleted",
    deleted: responsesStore.delete(responseId),
  });
}

export function handleOpenAIResponsesCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  if (entry.response.status === "in_progress")
    entry.response.status = "cancelled";
  writeJson(res, 200, entry.response);
}

export function handleOpenAIResponsesInputItems(
  _req: IncomingMessage,
  res: ServerResponse,
  responseId: string,
): void {
  const entry = getStoredResponse(responseId);
  if (!entry)
    return writeJson(res, 404, {
      error: {
        message: `Response not found: ${responseId}`,
        type: "invalid_request_error",
      },
    });
  writeJson(res, 200, {
    object: "list",
    data: entry.inputItems,
    has_more: false,
    first_id: entry.inputItems[0]?.id ?? null,
    last_id: entry.inputItems.at(-1)?.id ?? null,
  });
}

export async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError)
      return writeJson(res, 413, {
        type: "error",
        error: { type: "invalid_request_error", message: "Payload too large" },
      });
    return writeJson(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    });
  }
  const validation = validateAnthropicMessagesRequest(
    normalizeAnthropicMessagesRequest(parsed),
  );
  if (!validation.ok)
    return writeJson(res, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: validation.errors.join("; "),
      },
    });

  const started = Date.now();
  const streamMode = validation.value.stream ? "anthropic" : "none";
  const result = await completeViaRotator(
    req,
    res,
    rotator,
    anthropicToAntigravityBody(validation.value),
    streamMode,
  );
  if (result.status !== 200) {
    compatLogger.warn(
      `Anthropic compat upstream failed status=${result.status} model=${validation.value.model}`,
    );
    if (!res.headersSent) {
      return writeJson(res, result.status, {
        type: "error",
        error: {
          type: "upstream_error",
          message: result.errorText || "Upstream error",
        },
      });
    }
    return;
  }
  if (result.streamed) {
    return;
  }
  const contentBlocks: Array<Record<string, unknown>> = [];
  if (result.completion.thinkingText) {
    contentBlocks.push({
      type: "thinking",
      thinking: result.completion.thinkingText,
    });
  }
  if (result.completion.text) {
    contentBlocks.push({ type: "text", text: result.completion.text });
  }
  if (result.completion.toolCalls && result.completion.toolCalls.length > 0) {
    for (const tc of result.completion.toolCalls) {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(tc.function.arguments || "{}");
      } catch {
        parsedInput = {};
      }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
  }
  const stopReason =
    result.completion.toolCalls && result.completion.toolCalls.length > 0
      ? "tool_use"
      : "end_turn";
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
