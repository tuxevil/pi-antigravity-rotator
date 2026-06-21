// HTTP reverse proxy - forwards requests to Antigravity with credential rotation

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import {
  ANTIGRAVITY_ENDPOINTS,
  REQUEST_CLIENT_METADATA,
  REQUEST_GOOG_API_CLIENT,
  REQUEST_USER_AGENT,
  applyModelAlias,
  resolveQuotaModelKey,
  resolveDisplayModelKey,
} from "./types.js";
import type { AccountRuntime } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import {
  serveDashboard,
  serveStatusApi,
  serveConfigApi,
  serveConfigExportApi,
  serveConfigImportApi,
  serveEnableApi,
  serveDisableApi,
  serveQuarantineApi,
  serveRestoreApi,
  serveRemoveAccountApi,
  serveFreshWindowStartsApi,
  serveAccountFreshWindowStartsApi,
  serveClearInFlightApi,
  serveClearBreakerApi,
} from "./dashboard.js";
import {
  handleHostedCallback,
  serveLoginLanding,
  startHostedLogin,
  serveCliLogin,
  handleCliLoginApi,
} from "./onboarding.js";
import { requireAdmin } from "./admin-auth.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { validateConfig, validateProxyRequestBody } from "./validators.js";
import { logger } from "./logger.js";
import {
  trackFeature,
  reportFlagEvent,
  FLAG_PATTERNS,
  type FlagPattern,
} from "./telemetry.js";
import type { FlagEventData } from "./telemetry.js";
import { startVersionChecker, performSelfUpdate } from "./version-check.js";
import { startNotificationPoller } from "./notification-poller.js";
import {
  handleAnthropicMessages,
  handleGeminiGenerateContent,
  handleOpenAIChatCompletions,
  handleOpenAIResponsesCancel,
  handleOpenAIResponsesCreate,
  handleOpenAIResponsesDelete,
  handleOpenAIResponsesInputItems,
  handleOpenAIResponsesRetrieve,
  serveGeminiModels,
  serveOpenAIModels,
} from "./compat.js";
import { applyConfigDefaults } from "./account-store.js";
import {
  classifyRateLimitReason,
  parseRetryAfterMs,
} from "./rate-limit-parser.js";

const proxyLogger = logger.child("proxy");

const MAX_ENDPOINT_RETRIES = 3;
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes max cooldown
const RESOURCE_EXHAUSTED_COOLDOWN_MS = 30 * 60 * 1000; // Stop hammering provider-side daily/request buckets
const STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // Release account if a stream goes silent.
const LARGE_CONTEXT_WARN_BYTES = 1 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestBody {
  project: string;
  model: string;
  request: unknown;
  requestType?: string;
  userAgent?: string;
  requestId?: string;
  displayModel?: string;
  [key: string]: unknown;
}

export interface ForwardedResponse {
  response: Response;
  endpoint: string;
}

export interface RotationAttemptContext {
  account: AccountRuntime;
  label: string;
  modelKey: string;
  displayModelKey: string;
  requestId: string;
  requestStartMs: number;
  endpoint: string;
}

export type RotationOutcome<T> =
  | { ok: true; result: T; endpoint: string }
  | {
      ok: false;
      status: number;
      errorText: string;
      retryAfterMs?: number;
      endpoint?: string;
    };

/**
 * Discriminated union describing what should happen after inspecting an
 * upstream response. Used by both withRotation (which translates into a
 * RotationOutcome) and handleProxyRequest (which translates into HTTP) to
 * keep the status-code branching in one place.
 */
export type UpstreamAction =
  | {
      kind: "rate-limited";
      cooldownMs: number;
      providerResourceExhausted: boolean;
      errorText: string;
      endpoint: string;
    }
  | { kind: "flagged-401"; errorText: string; endpoint: string }
  | { kind: "flagged-403"; errorText: string; endpoint: string }
  | { kind: "forbidden"; errorText: string; endpoint: string }
  | { kind: "not-found"; errorText: string; endpoint: string }
  | { kind: "bad-request"; errorText: string; endpoint: string }
  | { kind: "server-error-503"; errorText: string; endpoint: string }
  | {
      kind: "rotate-on-5xx";
      httpStatus: number;
      errorText: string;
      endpoint: string;
    }
  | { kind: "success" };

/**
 * Inspect an upstream response and return a tag describing what to do next.
 * Shared between withRotation and handleProxyRequest so the status-code
 * classification logic lives in one place.
 */
export async function classifyUpstreamResponse(
  response: Response,
  endpoint: string,
  account: AccountRuntime,
  model: string,
  modelKey: string,
): Promise<UpstreamAction> {
  if (response.status === 429) {
    const errorText = await response.text().catch(() => "");
    const rateLimitReason = classifyRateLimitReason(errorText, response.status);
    const providerResourceExhausted = rateLimitReason === "quota-exhausted";
    const cooldownMs = providerResourceExhausted
      ? RESOURCE_EXHAUSTED_COOLDOWN_MS
      : capCooldown(parseRetryAfterMs(errorText, response.headers));
    return {
      kind: "rate-limited",
      cooldownMs,
      providerResourceExhausted,
      errorText,
      endpoint,
    };
  }

  if (response.status === 401) {
    const errorText = await response.text().catch(() => "");
    return { kind: "flagged-401", errorText, endpoint };
  }

  if (response.status === 403) {
    const errorText = await response.text().catch(() => "");
    const lower = errorText.toLowerCase();
    const flagPatternsLocal = [
      "infring",
      "suspend",
      "abus",
      "terminat",
      "violat",
      "banned",
      "policy",
      "forbidden",
      "verif",
    ];
    const isFlagged = flagPatternsLocal.some((p) => lower.includes(p));
    if (isFlagged) {
      return { kind: "flagged-403", errorText, endpoint };
    }
    return { kind: "forbidden", errorText, endpoint };
  }

  if (response.status === 404) {
    const errorText = await response.text().catch(() => "");
    return { kind: "not-found", errorText, endpoint };
  }

  if (response.status === 400) {
    const errorText = await response.text().catch(() => "");
    return { kind: "bad-request", errorText, endpoint };
  }

  if (response.status === 503) {
    const errorText = await response.text().catch(() => "");
    return { kind: "server-error-503", errorText, endpoint };
  }

  if (response.status >= 500) {
    const errorText = await response.text().catch(() => "");
    return {
      kind: "rotate-on-5xx",
      httpStatus: response.status,
      errorText,
      endpoint,
    };
  }

  // Reference parameters to satisfy "all parameters are used" without changing behavior.
  void account;
  void model;
  void modelKey;
  return { kind: "success" };
}

function capCooldown(ms: number): number {
  return Math.min(ms, MAX_COOLDOWN_MS);
}

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? String(cause.code) : null;
    const message = "message" in cause ? String(cause.message) : null;
    if (code || message) {
      return `${err.name}: ${err.message} (${[code, message].filter(Boolean).join(": ")})`;
    }
  }
  return `${err.name}: ${err.message}`;
}

function isFetchTransportError(err: unknown): boolean {
  return err instanceof TypeError && err.message === "fetch failed";
}

/** Max bytes kept in the SSE event buffer. A single event is rarely >1MB;
 *  if it is, we keep the last 1MB which is still enough to find usage. */
const SSE_EVENT_BUFFER_MAX = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively search a parsed JSON value for the first usage block we recognise.
 *  Supports Gemini (usageMetadata), OpenAI (usage with prompt_tokens/completion_tokens),
 *  and Anthropic (usage with input_tokens/output_tokens). */
function findUsageInJson(
  value: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (!isRecord(value)) return null;
  // Gemini format
  const gemini = value.usageMetadata;
  if (isRecord(gemini)) {
    const input =
      typeof gemini.promptTokenCount === "number" ? gemini.promptTokenCount : 0;
    const output =
      typeof gemini.candidatesTokenCount === "number"
        ? gemini.candidatesTokenCount
        : 0;
    if (input > 0 || output > 0)
      return { inputTokens: input, outputTokens: output };
  }
  // OpenAI / Anthropic format
  const usage = value.usage;
  if (isRecord(usage)) {
    const input =
      typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : 0;
    const output =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0;
    if (input > 0 || output > 0)
      return { inputTokens: input, outputTokens: output };
  }
  // Recurse into common nesting locations.
  for (const key of ["candidates", "output", "response", "message"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findUsageInJson(item);
        if (found) return found;
      }
    } else if (isRecord(child)) {
      const found = findUsageInJson(child);
      if (found) return found;
    }
  }
  return null;
}

/** Extract usage from a single complete SSE event (one or more `data:` lines
 *  separated by newlines, terminated by a blank line). The last successful
 *  extraction wins (callers should stop scanning once they find usage). */
export function extractUsageFromSseEvent(
  eventText: string,
): { inputTokens: number; outputTokens: number } | null {
  const dataLines: string[] = [];
  for (const raw of eventText.split("\n")) {
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]" || payload === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Fall back to regex on the raw event text. This handles non-standard
    // streams that don't quite produce valid JSON per event.
    const fallback = regexExtractUsage(payload);
    return fallback;
  }
  return findUsageInJson(parsed);
}

/** Last-resort regex extraction for streams that don't yield parseable JSON. */
function regexExtractUsage(
  buffer: string,
): { inputTokens: number; outputTokens: number } | null {
  try {
    const patterns = [
      /"promptTokenCount"\s*:\s*(\d+).*?"candidatesTokenCount"\s*:\s*(\d+)/s,
      /"input_tokens"\s*:\s*(\d+).*?"output_tokens"\s*:\s*(\d+)/s,
    ];
    for (const pattern of patterns) {
      const match = buffer.match(pattern);
      if (match) {
        return {
          inputTokens: parseInt(match[1], 10),
          outputTokens: parseInt(match[2], 10),
        };
      }
    }
  } catch {
    /* extraction failed */
  }
  return null;
}

/** State for the SSE event accumulator used by streamResponseBody. */
class SseEventAccumulator {
  private buffer = "";
  private readonly maxBytes: number;
  constructor(maxBytes: number = SSE_EVENT_BUFFER_MAX) {
    this.maxBytes = maxBytes;
  }

  /** Append a chunk, return any usage extracted from newly-completed events. */
  append(
    chunkText: string,
  ): { inputTokens: number; outputTokens: number } | null {
    this.buffer += chunkText;
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.slice(-this.maxBytes);
    }
    let extracted: { inputTokens: number; outputTokens: number } | null = null;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventText = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const usage = extractUsageFromSseEvent(eventText);
      if (usage && !extracted) extracted = usage;
      boundary = this.buffer.indexOf("\n\n");
    }
    return extracted;
  }

  /** Flush any partial event at end-of-stream. */
  final(): { inputTokens: number; outputTokens: number } | null {
    if (!this.buffer) return null;
    const usage = extractUsageFromSseEvent(this.buffer);
    this.buffer = "";
    return usage;
  }
}

async function readJsonRequest(req: IncomingMessage): Promise<unknown> {
  const body = await readLimitedBody(req);
  return body.length === 0 ? {} : JSON.parse(body.toString("utf-8"));
}

async function streamResponseBody(
  body: Response["body"],
  req: IncomingMessage,
  res: ServerResponse,
  label: string,
  proxyLog: (msg: string, level?: "info" | "warn" | "error") => void,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  firstByteMs: number;
} | null> {
  if (!body) return null;

  const nodeStream = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  const eventAccumulator = new SseEventAccumulator();
  let firstUsage: { inputTokens: number; outputTokens: number } | null = null;
  const streamStartMs = Date.now();
  let firstByteMs = 0;

  const usage = await new Promise<{
    inputTokens: number;
    outputTokens: number;
    firstByteMs: number;
  } | null>((resolve) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      nodeStream.off("data", onData);
      nodeStream.off("end", onEnd);
      nodeStream.off("error", onError);
      nodeStream.off("close", onClose);
      req.off("close", onClientClose);
      res.off("close", onResponseClose);
      res.off("error", onResponseError);
    };

    const finish = (reason?: string): void => {
      if (settled) return;
      settled = true;
      if (reason) proxyLog(`[${label}] Stream closed: ${reason}`, "warn");
      cleanup();
      // Drain any partial event that didn't end with \n\n
      if (!firstUsage) firstUsage = eventAccumulator.final();
      resolve(firstUsage ? { ...firstUsage, firstByteMs } : null);
    };

    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(
          `idle timeout after ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
        );
        if (!nodeStream.destroyed) nodeStream.destroy();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    const onData = (chunk: Buffer): void => {
      if (firstByteMs === 0) firstByteMs = Date.now() - streamStartMs;
      resetIdleTimer();
      // Forward to client immediately (real-time streaming preserved)
      if (!res.destroyed && !res.writableEnded) {
        res.write(chunk);
      }
      // Extract usage from any newly-completed SSE events
      if (!firstUsage) {
        const usage = eventAccumulator.append(chunk.toString());
        if (usage) firstUsage = usage;
      }
    };
    const onEnd = (): void => finish();
    const onError = (err: Error): void => finish(String(err));
    const onClose = (): void => finish();
    // req.aborted is deprecated and unreliable since Node 18+.
    // req.on("close") is the correct signal for client disconnect in Node 22.
    const onClientClose = (): void => {
      // Always destroy when the client disconnects — regardless of writableEnded.
      // The upstream stream from Google may still be open even if res finished writing,
      // which would leave the account stuck in-flight until the idle timeout.
      if (!settled) {
        nodeStream.destroy();
        finish("client closed connection");
      }
    };
    const onResponseClose = (): void => {
      if (!settled) {
        nodeStream.destroy();
        finish("response closed before completion");
      }
    };
    const onResponseError = (err: Error): void => {
      nodeStream.destroy(err);
      finish(String(err));
    };

    nodeStream.on("data", onData);
    nodeStream.once("end", onEnd);
    nodeStream.once("error", onError);
    nodeStream.once("close", onClose);
    req.once("close", onClientClose);
    res.once("close", onResponseClose);
    res.once("error", onResponseError);
    resetIdleTimer();
  });

  return usage;
}

/**
 * Forward a request to the real Antigravity endpoint with credential swapping.
 */
export async function forwardRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
): Promise<ForwardedResponse> {
  // Swap credentials
  body.project = account.config.projectId;

  // Map internal display/compat names to Google upstream names (single source
  // of truth: src/types.ts:applyModelAlias)
  body.model = applyModelAlias(body.model);

  const { displayModel: _displayModel, ...bodyToForward } = body;
  const requestBody = JSON.stringify(bodyToForward);

  // Build headers: keep originals but swap Authorization
  const forwardHeaders: Record<string, string> = {
    ...originalHeaders,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Remove original authorization (any case), provider-set headers, and
  // hop-by-hop headers per RFC 7230 §6.1. The hop-by-hop list prevents
  // leaking client IP (X-Forwarded-For) and prevents IP spoofing in
  // upstream logs (Via).
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    // Forwarding / proxying artefacts that should never reach the upstream
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
    "via",
  ]);
  for (const key of Object.keys(forwardHeaders)) {
    const lowerKey = key.toLowerCase();
    if (
      HOP_BY_HOP.has(lowerKey) ||
      lowerKey === "authorization" ||
      lowerKey === "user-agent" ||
      lowerKey === "x-goog-api-client" ||
      lowerKey === "client-metadata"
    ) {
      delete forwardHeaders[key];
    }
  }
  forwardHeaders["Authorization"] = `Bearer ${account.accessToken}`;
  forwardHeaders["User-Agent"] = REQUEST_USER_AGENT;
  forwardHeaders["X-Goog-Api-Client"] = REQUEST_GOOG_API_CLIENT;
  forwardHeaders["Client-Metadata"] = REQUEST_CLIENT_METADATA;
  // Claude models on Cloud Code Assist (Antigravity) require this beta header to
  // return interleaved thinking blocks. Mirrors pi-mono's needsClaudeThinkingBetaHeader.
  if (/^claude-/i.test(body.model)) {
    forwardHeaders["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }
  delete forwardHeaders["host"];
  delete forwardHeaders["connection"];
  delete forwardHeaders["transfer-encoding"];
  delete forwardHeaders["content-length"];

  // Try endpoints with cascade on 401/403/404
  for (
    let endpointIdx = 0;
    endpointIdx < ANTIGRAVITY_ENDPOINTS.length;
    endpointIdx++
  ) {
    const endpoint = ANTIGRAVITY_ENDPOINTS[endpointIdx];
    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const isProd = endpointIdx === ANTIGRAVITY_ENDPOINTS.length - 1;

    try {
      const controller = !isProd ? new AbortController() : undefined;
      const timeout = controller
        ? setTimeout(() => controller.abort(), 10_000)
        : undefined;

      const response = await fetch(url, {
        method: "POST",
        headers: forwardHeaders,
        body: requestBody,
        signal: controller?.signal,
      });
      if (timeout) clearTimeout(timeout);

      if (
        (response.status === 401 ||
          response.status === 403 ||
          response.status === 404) &&
        endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1
      ) {
        log(`Endpoint ${endpoint} returned ${response.status}, cascading...`);
        response.text().catch(() => {});
        continue;
      }

      return { response, endpoint };
    } catch (err) {
      if (endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1) {
        log(
          `Endpoint ${endpoint} failed: ${err instanceof Error ? err.message : err}, cascading...`,
        );
        continue;
      }
      throw err;
    }
  }

  throw new Error("All endpoints failed");
}

export async function withRotation<T>(
  rotator: AccountRotator,
  model: string,
  originalHeaders: Record<string, string>,
  body: RequestBody,
  onSuccess: (
    response: Response,
    context: RotationAttemptContext,
  ) => Promise<T>,
): Promise<RotationOutcome<T>> {
  const sendNoAccountsAvailable = (reason: string): RotationOutcome<T> => {
    log(`[${model}] No healthy account available: ${reason}`, rotator, "warn");
    const retryAfterMs = rotator.getRetryAfterMs(model);
    if (retryAfterMs > 0) {
      return {
        ok: false,
        status: 429,
        errorText: `All accounts cooling down or model circuit breaker active: ${reason}`,
        retryAfterMs,
      };
    }
    return {
      ok: false,
      status: 503,
      errorText: `All accounts exhausted or disabled: ${reason}`,
    };
  };

  const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
    const nextAccount = await rotator.rotateToNext(model);
    if (nextAccount) {
      rotator.finishRequest(
        nextAccount,
        resolveQuotaModelKey(model) ?? undefined,
      );
    }
    return nextAccount;
  };

  for (let attempt = 0; attempt < MAX_ENDPOINT_RETRIES; attempt++) {
    const account = await rotator.getActiveAccount(model);
    if (!account) {
      return sendNoAccountsAvailable("rotation returned no available account");
    }

    const label = account.config.label || account.config.email;
    const modelKey = resolveQuotaModelKey(model) ?? model;
    const displayModelKey = resolveDisplayModelKey(body.displayModel || model);
    const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
    const requestStartMs = Date.now();
    const logRequestEnd = (status: string | number, extra = ""): void => {
      log(
        `[${requestId}] END account=${label} model=${model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
        rotator,
        status === 200 || status === 0 ? "info" : "warn",
      );
    };

    log(
      `[${requestId}] START account=${label} model=${model} attempt=${attempt + 1}`,
      rotator,
    );

    try {
      const jitterMs = rotator.getSafetyJitterMs(account);
      const globalDelayMs = rotator.getGlobalDelayMs();
      const totalDelayMs = jitterMs + globalDelayMs;
      if (totalDelayMs > 0) {
        if (jitterMs > 0) {
          log(
            `[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`,
            rotator,
            "warn",
          );
        }
        if (globalDelayMs > 0) {
          log(
            `[${requestId}] Global request delay ${globalDelayMs}ms applied to slow down requests`,
            rotator,
            "info",
          );
        }
        await sleep(totalDelayMs);
      }

      rotator.recordUpstreamAttempt(account);
      const forwarded = await forwardRequest(
        account,
        { ...body },
        originalHeaders,
      );
      const { response, endpoint } = forwarded;
      const context: RotationAttemptContext = {
        account,
        label,
        modelKey,
        displayModelKey,
        requestId,
        requestStartMs,
        endpoint,
      };

      const action = await classifyUpstreamResponse(
        response,
        endpoint,
        account,
        model,
        modelKey,
      );

      if (action.kind === "rate-limited") {
        log(
          `[${label}] 429 rate limited${action.providerResourceExhausted ? " (RESOURCE_EXHAUSTED)" : ""}, cooldown ${Math.ceil(action.cooldownMs / 1000)}s. Error text: ${action.errorText.slice(0, 300)}`,
          rotator,
          "warn",
        );
        rotator.markExhausted(
          account,
          model,
          action.cooldownMs,
          action.errorText.slice(0, 300),
        );
        rotator.recordProvider429(account, model, action.cooldownMs);
        logRequestEnd(
          429,
          `cooldownMs=${action.cooldownMs}${action.providerResourceExhausted ? " resourceExhausted=true" : ""}`,
        );
        return {
          ok: false,
          status: 429,
          errorText: action.errorText,
          retryAfterMs: action.cooldownMs,
          endpoint,
        };
      }

      if (action.kind === "flagged-401") {
        log(
          `[${label}] BLOCKED (401): ${action.errorText.slice(0, 200)}`,
          rotator,
          "error",
        );
        const lower401 = action.errorText.toLowerCase();
        const matched401 = FLAG_PATTERNS.filter((p) => lower401.includes(p));
        const ctx401 = rotator.getFlagContext(account, modelKey);
        reportFlagEvent({
          flagHttpStatus: 401,
          flagPatternsMatched:
            matched401.length > 0 ? matched401 : ["blocked_401" as FlagPattern],
          model: modelKey,
          timerType: ctx401.timerType as FlagEventData["timerType"],
          accountQuotaPercent: ctx401.accountQuotaPercent,
          wasProAccount: ctx401.wasProAccount,
          accountTotalRequests: account.totalRequests,
          accountRequestsLastHour: ctx401.accountRequestsLastHour,
          accountConcurrentAtFlag: account.inFlightRequests,
          poolSize: ctx401.poolSize,
          poolHealthyCount: ctx401.poolHealthyCount,
          protectivePauseTriggered: false,
          uptimeSeconds: ctx401.uptimeSeconds,
          timeSinceLastFlagSeconds: -1,
        });
        rotator.markFlagged(
          account,
          `Account blocked (401): ${action.errorText.slice(0, 300)}`,
        );
        logRequestEnd(401);
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          return sendNoAccountsAvailable(
            `no replacement account remained after ${label} was flagged with 401`,
          );
        }
        continue;
      }

      if (action.kind === "flagged-403") {
        log(
          `[${label}] FLAGGED: ${action.errorText.slice(0, 200)}`,
          rotator,
          "error",
        );
        const lower = action.errorText.toLowerCase();
        const matchedPatterns = FLAG_PATTERNS.filter((p) => lower.includes(p));
        const ctx403 = rotator.getFlagContext(account, modelKey);
        reportFlagEvent({
          flagHttpStatus: 403,
          flagPatternsMatched: matchedPatterns,
          model: modelKey,
          timerType: ctx403.timerType as FlagEventData["timerType"],
          accountQuotaPercent: ctx403.accountQuotaPercent,
          wasProAccount: ctx403.wasProAccount,
          accountTotalRequests: account.totalRequests,
          accountRequestsLastHour: ctx403.accountRequestsLastHour,
          accountConcurrentAtFlag: account.inFlightRequests,
          poolSize: ctx403.poolSize,
          poolHealthyCount: ctx403.poolHealthyCount,
          protectivePauseTriggered: false,
          uptimeSeconds: ctx403.uptimeSeconds,
          timeSinceLastFlagSeconds: -1,
        });
        rotator.markFlagged(account, action.errorText.slice(0, 300));
        logRequestEnd(403);
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          return sendNoAccountsAvailable(
            `no replacement account remained after ${label} was flagged with 403`,
          );
        }
        continue;
      }

      if (action.kind === "forbidden") {
        log(
          `[${label}] 403: ${action.errorText.slice(0, 200)}`,
          rotator,
          "warn",
        );
        logRequestEnd(403);
        return {
          ok: false,
          status: 403,
          errorText: action.errorText,
          endpoint,
        };
      }

      if (action.kind === "not-found") {
        log(
          `[${label}] 404 from ${action.endpoint}: ${action.errorText.slice(0, 200)}`,
          rotator,
          "warn",
        );
        logRequestEnd(404, `endpoint=${action.endpoint}`);
        return {
          ok: false,
          status: 404,
          errorText: action.errorText,
          endpoint,
        };
      }

      if (action.kind === "bad-request") {
        log(
          `[${label}] 400 Bad Request from ${action.endpoint}: ${action.errorText.slice(0, 500)}`,
          rotator,
          "warn",
        );
        logRequestEnd(400, `endpoint=${action.endpoint}`);
        return {
          ok: false,
          status: 400,
          errorText: action.errorText,
          endpoint,
        };
      }

      if (action.kind === "server-error-503") {
        log(
          `[${label}] Server error 503: ${action.errorText.slice(0, 200)}`,
          rotator,
          "warn",
        );
        logRequestEnd(503, `endpoint=${action.endpoint}`);
        return {
          ok: false,
          status: 503,
          errorText: action.errorText,
          endpoint,
        };
      }

      if (action.kind === "rotate-on-5xx") {
        log(
          `[${label}] Server error ${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
          rotator,
          "warn",
        );
        logRequestEnd(action.httpStatus, `endpoint=${action.endpoint}`);
        rotator.markError(
          account,
          `${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
        );
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          return sendNoAccountsAvailable(
            `no replacement account remained after ${label} failed with ${action.httpStatus}`,
          );
        }
        continue;
      }

      // success
      const result = await onSuccess(response, context);
      const shouldRotate = rotator.recordRequest(account, model);
      logRequestEnd(response.status, `endpoint=${endpoint}`);
      if (shouldRotate) {
        await rotateAndRelease();
      }
      return { ok: true, result, endpoint };
    } catch (err) {
      const formattedError = formatError(err);
      log(
        `[${label}] Request failed: ${formattedError}`,
        rotator,
        isFetchTransportError(err) ? "warn" : "error",
      );
      logRequestEnd(
        isFetchTransportError(err) ? "fetch-error" : 500,
        `error=${formattedError.slice(0, 120)}`,
      );
      if (!isFetchTransportError(err)) {
        rotator.markError(account, formattedError);
      }
      const nextAccount = await rotateAndRelease();
      if (!nextAccount) {
        return sendNoAccountsAvailable(
          `no replacement account remained after ${label} request error`,
        );
      }
      continue;
    } finally {
      rotator.finishRequest(account, resolveQuotaModelKey(model) ?? undefined);
    }
  }

  return { ok: false, status: 502, errorText: "All retry attempts failed" };
}

function log(
  msg: string,
  rotator?: AccountRotator,
  level: "info" | "warn" | "error" = "info",
): void {
  proxyLogger.log(level, msg);
  rotator?.recordProxyEvent(msg, level);
}

/**
 * Handle a proxied API request.
 */
async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
  onComplete?: () => void,
): Promise<void> {
  let bodyBuffer: Buffer;
  try {
    bodyBuffer = await readLimitedBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payload too large",
          limitBytes: err.limitBytes,
        }),
      );
      return;
    }
    throw err;
  }
  let body: RequestBody;
  try {
    const parsed: unknown = JSON.parse(bodyBuffer.toString("utf-8"));
    const validation = validateProxyRequestBody(parsed);
    if (!validation.ok || !validation.value) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid request body",
          details: validation.errors,
        }),
      );
      return;
    }
    body = validation.value as RequestBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const proxyLog = (
    msg: string,
    level: "info" | "warn" | "error" = "info",
  ): void => {
    log(msg, rotator, level);
  };
  if (bodyBuffer.length > LARGE_CONTEXT_WARN_BYTES) {
    proxyLog(
      `[${body.model}] Large request body ${bodyBuffer.length} bytes; high context pressure increases rate-limit/flag risk`,
      "warn",
    );
  }

  const sendNoAccountsAvailable = (reason: string): void => {
    proxyLog(`[${body.model}] No healthy account available: ${reason}`, "warn");
    const retryAfterMs = rotator.getRetryAfterMs(body.model);
    if (retryAfterMs > 0) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
      res.end(
        JSON.stringify({
          error: "All accounts cooling down or model circuit breaker active",
          reason,
          model: body.model,
          retryAfterMs,
        }),
      );
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "All accounts exhausted or disabled",
        reason,
        model: body.model,
        retryable: false,
      }),
    );
  };
  const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
    const nextAccount = await rotator.rotateToNext(body.model);
    if (nextAccount) {
      rotator.finishRequest(
        nextAccount,
        resolveQuotaModelKey(body.model) ?? undefined,
      );
    }
    return nextAccount;
  };

  for (let attempt = 0; attempt < MAX_ENDPOINT_RETRIES; attempt++) {
    const account = await rotator.getActiveAccount(body.model);
    if (!account) {
      sendNoAccountsAvailable("rotation returned no available account");
      return;
    }

    const label = account.config.label || account.config.email;
    const modelKey = resolveQuotaModelKey(body.model) ?? body.model; // quota routing
    const displayModelKey = resolveDisplayModelKey(body.model); // metrics/logs
    const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
    proxyLog(
      `[${requestId}] START account=${label} model=${body.model} attempt=${attempt + 1}`,
    );
    const requestStartMs = Date.now();
    const logRequestEnd = (status: string | number, extra = ""): void => {
      proxyLog(
        `[${requestId}] END account=${label} model=${body.model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
        status === 200 || status === 0 ? "info" : "warn",
      );
    };
    const recordOutcome = (
      statusCode: number,
      ttfbMs = 0,
      totalMs = Date.now() - requestStartMs,
      inputTokens = 0,
      outputTokens = 0,
    ): void => {
      rotator.recordRequestLog({
        model: modelKey,
        account: label,
        statusCode,
        ttfbMs,
        totalMs,
        inputTokens,
        outputTokens,
      });
    };

    try {
      const jitterMs = rotator.getSafetyJitterMs(account);
      const globalDelayMs = rotator.getGlobalDelayMs();
      const totalDelayMs = jitterMs + globalDelayMs;
      if (totalDelayMs > 0) {
        if (jitterMs > 0) {
          proxyLog(
            `[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`,
            "warn",
          );
        }
        if (globalDelayMs > 0) {
          proxyLog(
            `[${requestId}] Global request delay ${globalDelayMs}ms applied to slow down requests`,
            "info",
          );
        }
        await sleep(totalDelayMs);
      }
      rotator.recordUpstreamAttempt(account);
      const forwarded = await forwardRequest(
        account,
        { ...body },
        flattenHeaders(req.headers),
      );
      const { response, endpoint } = forwarded;

      const action = await classifyUpstreamResponse(
        response,
        endpoint,
        account,
        body.model,
        modelKey,
      );

      if (action.kind === "rate-limited") {
        proxyLog(
          `[${label}] 429 rate limited${action.providerResourceExhausted ? " (RESOURCE_EXHAUSTED)" : ""}, cooldown ${Math.ceil(action.cooldownMs / 1000)}s. Error text: ${action.errorText.slice(0, 300)}`,
          "warn",
        );
        recordOutcome(429);
        logRequestEnd(
          429,
          `cooldownMs=${action.cooldownMs}${action.providerResourceExhausted ? " resourceExhausted=true" : ""} endpoint=${endpoint}`,
        );
        rotator.markExhausted(account, body.model, action.cooldownMs);
        rotator.recordProvider429(account, body.model, action.cooldownMs);

        // Safety first: do NOT immediately retry another account on 429.
        // Provider-side 429s can represent daily/request buckets or shared project pressure;
        // cascading retries burn the full pool and increase ban/flag risk.
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(action.cooldownMs / 1000)),
        });
        res.end(
          JSON.stringify({
            error: action.providerResourceExhausted
              ? "Resource exhausted"
              : "Rate limited",
            reason: action.providerResourceExhausted
              ? `${label} hit provider RESOURCE_EXHAUSTED; not retrying another account to avoid pool-wide hammering`
              : `${label} was rate limited; not retrying another account for account-safety`,
            model: body.model,
            account: label,
            retryAfterMs: action.cooldownMs,
          }),
        );
        return;
      }

      if (action.kind === "flagged-401") {
        proxyLog(
          `[${label}] BLOCKED (401): ${action.errorText.slice(0, 200)}`,
          "error",
        );

        // Telemetry: report flag event BEFORE markFlagged (which may trigger protective pause)
        const lower401 = action.errorText.toLowerCase();
        const matched401 = FLAG_PATTERNS.filter((p) => lower401.includes(p));
        const ctx401 = rotator.getFlagContext(account, modelKey);
        reportFlagEvent({
          flagHttpStatus: 401,
          flagPatternsMatched:
            matched401.length > 0 ? matched401 : ["blocked_401" as FlagPattern],
          model: modelKey,
          timerType: ctx401.timerType as FlagEventData["timerType"],
          accountQuotaPercent: ctx401.accountQuotaPercent,
          wasProAccount: ctx401.wasProAccount,
          accountTotalRequests: account.totalRequests,
          accountRequestsLastHour: ctx401.accountRequestsLastHour,
          accountConcurrentAtFlag: account.inFlightRequests,
          poolSize: ctx401.poolSize,
          poolHealthyCount: ctx401.poolHealthyCount,
          protectivePauseTriggered: false, // not yet — markFlagged decides
          uptimeSeconds: ctx401.uptimeSeconds,
          timeSinceLastFlagSeconds: -1, // filled by reporter
        });

        rotator.markFlagged(
          account,
          `Account blocked (401): ${action.errorText.slice(0, 300)}`,
        );
        logRequestEnd(401, `endpoint=${endpoint}`);
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          sendNoAccountsAvailable(
            `no replacement account remained after ${label} was flagged with 401`,
          );
          return;
        }
        continue;
      }

      if (action.kind === "flagged-403") {
        proxyLog(
          `[${label}] FLAGGED: ${action.errorText.slice(0, 200)}`,
          "error",
        );
        recordOutcome(403);
        logRequestEnd(403, `endpoint=${endpoint}`);

        const matchedPatterns = FLAG_PATTERNS.filter((p) =>
          action.errorText.toLowerCase().includes(p),
        );
        const ctx403 = rotator.getFlagContext(account, modelKey);
        reportFlagEvent({
          flagHttpStatus: 403,
          flagPatternsMatched: matchedPatterns,
          model: modelKey,
          timerType: ctx403.timerType as FlagEventData["timerType"],
          accountQuotaPercent: ctx403.accountQuotaPercent,
          wasProAccount: ctx403.wasProAccount,
          accountTotalRequests: account.totalRequests,
          accountRequestsLastHour: ctx403.accountRequestsLastHour,
          accountConcurrentAtFlag: account.inFlightRequests,
          poolSize: ctx403.poolSize,
          poolHealthyCount: ctx403.poolHealthyCount,
          protectivePauseTriggered: false, // not yet
          uptimeSeconds: ctx403.uptimeSeconds,
          timeSinceLastFlagSeconds: -1, // filled by reporter
        });

        rotator.markFlagged(account, action.errorText.slice(0, 300));
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          sendNoAccountsAvailable(
            `no replacement account remained after ${label} was flagged with 403`,
          );
          return;
        }
        continue;
      }

      if (action.kind === "forbidden") {
        proxyLog(`[${label}] 403: ${action.errorText.slice(0, 200)}`, "warn");
        logRequestEnd(403, `endpoint=${action.endpoint}`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(action.errorText || JSON.stringify({ error: "Forbidden" }));
        return;
      }

      if (action.kind === "not-found") {
        proxyLog(
          `[${label}] 404 from ${action.endpoint}: ${action.errorText.slice(0, 200)}`,
          "warn",
        );
        logRequestEnd(404, `endpoint=${action.endpoint}`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(action.errorText || JSON.stringify({ error: "Not found" }));
        return;
      }

      if (action.kind === "bad-request") {
        proxyLog(
          `[${label}] 400 Bad Request from ${action.endpoint}: ${action.errorText.slice(0, 500)}`,
          "warn",
        );
        logRequestEnd(400, `endpoint=${action.endpoint}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(action.errorText || JSON.stringify({ error: "Bad request" }));
        return;
      }

      if (action.kind === "server-error-503") {
        proxyLog(
          `[${label}] Server error 503: ${action.errorText.slice(0, 200)}`,
          "warn",
        );
        recordOutcome(503);
        logRequestEnd(503, `endpoint=${action.endpoint}`);
        // Return 503 as-is. Capacity errors still consume quota upstream,
        // so retrying on another account would just burn more quota for nothing.
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          action.errorText ||
            JSON.stringify({
              error: "Server unavailable",
              account: label,
              model: body.model,
            }),
        );
        return;
      }

      if (action.kind === "rotate-on-5xx") {
        proxyLog(
          `[${label}] Server error ${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
          "warn",
        );
        recordOutcome(action.httpStatus);
        logRequestEnd(action.httpStatus, `endpoint=${action.endpoint}`);
        rotator.markError(
          account,
          `${action.httpStatus}: ${action.errorText.slice(0, 200)}`,
        );
        const nextAccount = await rotateAndRelease();
        if (!nextAccount) {
          sendNoAccountsAvailable(
            `no replacement account remained after ${label} failed with ${action.httpStatus}`,
          );
          return;
        }
        continue;
      }

      // Success or non-error client response
      const shouldRotate = rotator.recordRequest(account, body.model);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== "transfer-encoding" &&
          key.toLowerCase() !== "connection"
        ) {
          responseHeaders[key] = value;
        }
      });

      res.writeHead(response.status, responseHeaders);

      try {
        const usage = await streamResponseBody(
          response.body,
          req,
          res,
          label,
          proxyLog,
        );
        const totalMs = Date.now() - requestStartMs;
        const ttfbMs = usage?.firstByteMs ?? totalMs;
        rotator.recordLatency(body.displayModel || body.model, ttfbMs, totalMs);
        logRequestEnd(response.status, `ttfbMs=${ttfbMs} endpoint=${endpoint}`);
        rotator.recordRequestLog({
          model: displayModelKey,
          account: label,
          statusCode: response.status,
          ttfbMs,
          totalMs,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        });
        if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
          rotator.recordTokenUsage(
            body.displayModel || body.model,
            usage.inputTokens,
            usage.outputTokens,
          );
        }
      } catch (err) {
        proxyLog(`[${label}] Stream setup error: ${err}`, "warn");
      }
      res.end();

      if (shouldRotate) {
        await rotateAndRelease();
      }
      return;
    } catch (err) {
      const formattedError = formatError(err);
      proxyLog(
        `[${label}] Request failed: ${formattedError}`,
        isFetchTransportError(err) ? "warn" : "error",
      );
      recordOutcome(isFetchTransportError(err) ? 0 : 500);
      logRequestEnd(
        isFetchTransportError(err) ? "fetch-error" : 500,
        `error=${formattedError.slice(0, 120)}`,
      );
      if (!isFetchTransportError(err)) {
        rotator.markError(account, formattedError);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const nextAccount = await rotateAndRelease();
      if (!nextAccount) {
        sendNoAccountsAvailable(
          `no replacement account remained after ${label} request error`,
        );
        return;
      }
      continue;
    } finally {
      rotator.finishRequest(
        account,
        resolveQuotaModelKey(body.model) ?? undefined,
      );
      if (onComplete) onComplete();
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify({ error: "All retry attempts failed" }));
}

export function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) {
      flat[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

export function startProxy(
  rotator: AccountRotator,
  port: number,
  bindHost = "0.0.0.0",
): void {
  startVersionChecker();
  startNotificationPoller();
  const sseClients = new Set<ServerResponse>();
  let sseBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const SSE_THROTTLE_MS = 1000; // max 1 push/second

  const scheduleSseBroadcast = (): void => {
    if (sseBroadcastTimer) return; // already scheduled
    sseBroadcastTimer = setTimeout(() => {
      sseBroadcastTimer = null;
      if (sseClients.size === 0) return;
      const data = JSON.stringify(rotator.getStatus());
      for (const client of sseClients) {
        try {
          client.write(`data: ${data}\n\n`);
        } catch {
          sseClients.delete(client);
        }
      }
    }, SSE_THROTTLE_MS);
  };

  // Hook into rotator state changes to trigger SSE
  const origSaveState = rotator.saveState.bind(rotator);
  rotator.saveState = (): void => {
    origSaveState();
    scheduleSseBroadcast();
  };

  const server = createServer((req, res) => {
    const method = req.method?.toUpperCase();
    const url = req.url || "";
    const pathname = url.split("?")[0];

    if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      if (!requireAdmin(req, res)) return;
      trackFeature("dashboard");
      serveDashboard(res);
      return;
    }

    if (method === "GET" && pathname === "/login") {
      if (!requireAdmin(req, res)) return;
      trackFeature("hostedLogin");
      serveLoginLanding(res);
      return;
    }

    if (method === "GET" && pathname === "/login-cli") {
      if (!requireAdmin(req, res)) return;
      trackFeature("cliLogin");
      serveCliLogin(res);
      return;
    }

    if (method === "POST" && pathname === "/api/cli-login") {
      if (!requireAdmin(req, res)) return;
      handleCliLoginApi(req, res, rotator).catch((err) => {
        log(`CLI login error: ${err}`, rotator, "error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ ok: false, error: "Internal login error" }));
      });
      return;
    }

    if (method === "GET" && pathname === "/auth/antigravity/start") {
      if (!requireAdmin(req, res)) return;
      startHostedLogin(req, res);
      return;
    }

    if (method === "GET" && pathname === "/auth/antigravity/callback") {
      if (!requireAdmin(req, res)) return;
      handleHostedCallback(req, res, rotator).catch((err) => {
        log(`Hosted callback error: ${err}`, rotator, "error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        }
        res.end("<h1>Internal login error</h1>");
      });
      return;
    }

    if (method === "GET" && pathname === "/api/status") {
      if (!requireAdmin(req, res)) return;
      serveStatusApi(res, rotator);
      return;
    }

    if (method === "GET" && pathname === "/api/config") {
      if (!requireAdmin(req, res)) return;
      serveConfigApi(res, rotator);
      return;
    }

    if (method === "GET" && pathname === "/api/config/export") {
      if (!requireAdmin(req, res)) return;
      serveConfigExportApi(res, rotator);
      return;
    }

    if (
      (method === "PUT" && pathname === "/api/config") ||
      (method === "POST" && pathname === "/api/config/import")
    ) {
      if (!requireAdmin(req, res)) return;
      readJsonRequest(req)
        .then((parsed) => {
          const candidate =
            parsed &&
            typeof parsed === "object" &&
            "config" in (parsed as Record<string, unknown>)
              ? (parsed as { config: unknown }).config
              : parsed;
          const validation = validateConfig(candidate);
          if (!validation.ok || !validation.value) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, errors: validation.errors }));
            return;
          }
          serveConfigImportApi(
            res,
            rotator,
            applyConfigDefaults(validation.value),
          );
        })
        .catch((err) => {
          res.writeHead(err instanceof PayloadTooLargeError ? 413 : 400, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      if (!requireAdmin(req, res)) return;
      // Server-Sent Events for live dashboard
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n"); // keepalive comment
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "POST" && url.startsWith("/api/enable/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(url.slice("/api/enable/".length));
      serveEnableApi(res, rotator, email);
      return;
    }

    if (method === "POST" && url.startsWith("/api/disable/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(url.slice("/api/disable/".length));
      serveDisableApi(res, rotator, email);
      return;
    }

    if (method === "POST" && url.startsWith("/api/quarantine/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(url.slice("/api/quarantine/".length));
      serveQuarantineApi(res, rotator, email);
      return;
    }

    if (method === "POST" && url.startsWith("/api/restore/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(url.slice("/api/restore/".length));
      serveRestoreApi(res, rotator, email);
      return;
    }

    if (method === "POST" && url.startsWith("/api/remove-account/")) {
      if (!requireAdmin(req, res)) return;
      const email = decodeURIComponent(
        url.slice("/api/remove-account/".length),
      );
      serveRemoveAccountApi(res, rotator, email);
      return;
    }

    if (method === "POST" && url.startsWith("/api/clear-inflight/")) {
      if (!requireAdmin(req, res)) return;
      const rest = url.slice("/api/clear-inflight/".length);
      const firstSlash = rest.indexOf("/");
      const email = decodeURIComponent(
        firstSlash >= 0 ? rest.slice(0, firstSlash) : rest,
      );
      const modelKey =
        firstSlash >= 0
          ? decodeURIComponent(rest.slice(firstSlash + 1))
          : undefined;
      serveClearInFlightApi(res, rotator, email, modelKey);
      return;
    }

    if (method === "POST" && url.startsWith("/api/clear-breaker/")) {
      if (!requireAdmin(req, res)) return;
      const rest = url.slice("/api/clear-breaker/".length);
      const modelKey =
        rest && rest !== "all" ? decodeURIComponent(rest) : undefined;
      serveClearBreakerApi(res, rotator, modelKey);
      return;
    }

    if (
      method === "POST" &&
      (url === "/api/settings/fresh-window-starts/on" ||
        url === "/api/settings/fresh-window-starts/off")
    ) {
      if (!requireAdmin(req, res)) return;
      trackFeature("freshWindowToggle");
      serveFreshWindowStartsApi(res, rotator, url.endsWith("/on"));
      return;
    }

    if (
      method === "POST" &&
      url.startsWith("/api/account-fresh-window-starts/") &&
      (url.endsWith("/on") || url.endsWith("/off"))
    ) {
      if (!requireAdmin(req, res)) return;
      const rest = url.slice("/api/account-fresh-window-starts/".length);
      const lastSlash = rest.lastIndexOf("/");
      const email = decodeURIComponent(rest.slice(0, lastSlash));
      const enabled = rest.slice(lastSlash + 1) === "on";
      serveAccountFreshWindowStartsApi(res, rotator, email, enabled);
      return;
    }

    if (method === "POST" && pathname === "/api/self-update") {
      if (!requireAdmin(req, res)) return;
      trackFeature("selfUpdate");
      try {
        const result = performSelfUpdate();
        res.writeHead(result.ok ? 200 : 500, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: String(err) }));
      }
      return;
    }

    // OpenAI-compatible adapter route (additive; does not affect native v1internal route)
    if (method === "GET" && pathname === "/v1/models") {
      serveOpenAIModels(res);
      return;
    }

    if (method === "GET" && pathname === "/v1beta/models") {
      serveGeminiModels(res);
      return;
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      handleOpenAIChatCompletions(req, res, rotator).catch((err) => {
        log(`OpenAI compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal OpenAI compat error",
              type: "server_error",
            },
          }),
        );
      });
      return;
    }

    if (method === "POST" && pathname === "/v1/responses") {
      handleOpenAIResponsesCreate(req, res, rotator).catch((err) => {
        log(`OpenAI responses compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal OpenAI responses compat error",
              type: "server_error",
            },
          }),
        );
      });
      return;
    }

    const responseMatch = pathname.match(
      /^\/v1\/responses\/([^/]+)(?:\/(cancel|input_items))?$/,
    );
    if (responseMatch) {
      const responseId = decodeURIComponent(responseMatch[1]);
      const action = responseMatch[2] || "";
      if (method === "GET" && !action)
        return handleOpenAIResponsesRetrieve(req, res, responseId);
      if (method === "DELETE" && !action)
        return handleOpenAIResponsesDelete(req, res, responseId);
      if (method === "POST" && action === "cancel")
        return handleOpenAIResponsesCancel(req, res, responseId);
      if (method === "GET" && action === "input_items")
        return handleOpenAIResponsesInputItems(req, res, responseId);
    }

    // Anthropic-compatible adapter route (additive; does not affect native v1internal route)
    if (method === "POST" && pathname === "/v1/messages") {
      handleAnthropicMessages(req, res, rotator).catch((err) => {
        log(`Anthropic compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "server_error",
              message: "Internal Anthropic compat error",
            },
          }),
        );
      });
      return;
    }

    if (
      method === "POST" &&
      /\/v1beta\/models\/.+:(generateContent|streamGenerateContent)$/.test(
        pathname,
      )
    ) {
      handleGeminiGenerateContent(req, res, rotator).catch((err) => {
        log(`Gemini compat error: ${err}`, rotator, "error");
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Internal Gemini compat error",
              status: "INTERNAL",
            },
          }),
        );
      });
      return;
    }

    // Proxy route
    if (method === "POST" && url.includes("v1internal")) {
      handleProxyRequest(req, res, rotator, scheduleSseBroadcast).catch(
        (err) => {
          log(`Unhandled error: ${err}`, rotator, "error");
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal proxy error" }));
        },
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, bindHost, () => {
    log(`Listening on ${bindHost}:${port}`, rotator);
    log(`Dashboard: http://localhost:${port}/dashboard`, rotator);
    log(`Hosted login: http://localhost:${port}/login`, rotator);
  });
}
