// HTTP reverse proxy - forwards requests to Antigravity with credential rotation

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
	ANTIGRAVITY_ENDPOINTS,
	REQUEST_CLIENT_METADATA,
	REQUEST_GOOG_API_CLIENT,
	REQUEST_USER_AGENT,
	resolveQuotaModelKey,
	resolveDisplayModelKey,
} from "./types.js";
import type { AccountRuntime } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import {
	serveDashboard,
	serveStatusApi,
	serveEnableApi,
	serveFreshWindowStartsApi,
	serveAccountFreshWindowStartsApi,
	serveClearInFlightApi,
} from "./dashboard.js";
import { handleHostedCallback, serveLoginLanding, startHostedLogin } from "./onboarding.js";
import { requireAdmin } from "./admin-auth.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { validateProxyRequestBody } from "./validators.js";
import { logger } from "./logger.js";
import { trackFeature, reportFlagEvent, FLAG_PATTERNS, type FlagPattern } from "./telemetry.js";
import type { FlagEventData } from "./telemetry.js";
import { startVersionChecker, performSelfUpdate } from "./version-check.js";
import { startNotificationPoller } from "./notification-poller.js";
import { handleAnthropicMessages, handleOpenAIChatCompletions, serveOpenAIModels } from "./compat.js";

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
	| { ok: false; status: number; errorText: string; retryAfterMs?: number; endpoint?: string };

/**
 * Extract retry delay from error response (mirrors pi-mono's extractRetryDelay).
 * Returns delay in milliseconds.
 */
function extractRetryDelay(errorText: string, headers: Headers): number {
	// Check headers
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) {
			return Math.ceil(seconds * 1000 + 1000);
		}
	}

	const resetAfter = headers.get("x-ratelimit-reset-after");
	if (resetAfter) {
		const seconds = Number(resetAfter);
		if (Number.isFinite(seconds) && seconds > 0) {
			return Math.ceil(seconds * 1000 + 1000);
		}
	}

	// Parse body patterns
	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
		const seconds = parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			return Math.ceil(((hours * 60 + minutes) * 60 + seconds) * 1000 + 1000);
		}
	}

	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	// Default: 60 seconds
	return 60_000;
}

function capCooldown(ms: number): number {
	return Math.min(ms, MAX_COOLDOWN_MS);
}

function isResourceExhausted(errorText: string): boolean {
	const lower = errorText.toLowerCase();
	return lower.includes("resource_exhausted") || lower.includes("resource exhausted");
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

/** Extract token usage from SSE stream or JSON response body */
function extractTokenUsage(buffer: string): { inputTokens: number; outputTokens: number } | null {
	try {
		// Look for usageMetadata/usage anywhere in the buffer via regex
		// Handles both SSE `data: {...}` and raw JSON chunks
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
	} catch { /* extraction failed */ }
	return null;
}

// Keep last ~32KB of stream to find usage metadata in the final chunk
const USAGE_TAIL_BYTES = 32 * 1024;

async function streamResponseBody(
	body: Response["body"],
	req: IncomingMessage,
	res: ServerResponse,
	label: string,
	proxyLog: (msg: string, level?: "info" | "warn" | "error") => void,
): Promise<{ inputTokens: number; outputTokens: number; firstByteMs: number } | null> {
	if (!body) return null;

	const nodeStream = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
	let tailBuffer = "";
	const streamStartMs = Date.now();
	let firstByteMs = 0;

	const usage = await new Promise<{ inputTokens: number; outputTokens: number; firstByteMs: number } | null>((resolve) => {
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
			const extracted = extractTokenUsage(tailBuffer);
			resolve(extracted ? { ...extracted, firstByteMs } : null);
		};

		const resetIdleTimer = (): void => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				finish(`idle timeout after ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`);
				if (!nodeStream.destroyed) nodeStream.destroy();
			}, STREAM_IDLE_TIMEOUT_MS);
		};

		const onData = (chunk: Buffer): void => {
			if (firstByteMs === 0) firstByteMs = Date.now() - streamStartMs;
			resetIdleTimer();
			const str = chunk.toString();
			tailBuffer += str;
			if (tailBuffer.length > USAGE_TAIL_BYTES) {
				tailBuffer = tailBuffer.slice(-USAGE_TAIL_BYTES);
			}
			if (!res.destroyed && !res.writableEnded) {
				res.write(chunk);
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
	const requestBody = JSON.stringify(body);

	// Build headers: keep originals but swap Authorization
	const forwardHeaders: Record<string, string> = {
		...originalHeaders,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
	};
	// Remove original authorization (any case) and hop-by-hop headers
	for (const key of Object.keys(forwardHeaders)) {
		const lowerKey = key.toLowerCase();
		if (
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
	delete forwardHeaders["host"];
	delete forwardHeaders["connection"];
	delete forwardHeaders["transfer-encoding"];
	delete forwardHeaders["content-length"];

	// Try endpoints with cascade on 401/403/404
	for (let endpointIdx = 0; endpointIdx < ANTIGRAVITY_ENDPOINTS.length; endpointIdx++) {
		const endpoint = ANTIGRAVITY_ENDPOINTS[endpointIdx];
		const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
		const isProd = endpointIdx === ANTIGRAVITY_ENDPOINTS.length - 1;

		try {
			const controller = !isProd ? new AbortController() : undefined;
			const timeout = controller ? setTimeout(() => controller.abort(), 10_000) : undefined;

			const response = await fetch(url, {
				method: "POST",
				headers: forwardHeaders,
				body: requestBody,
				signal: controller?.signal,
			});
			if (timeout) clearTimeout(timeout);

			if ((response.status === 401 || response.status === 403 || response.status === 404) && endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1) {
				log(`Endpoint ${endpoint} returned ${response.status}, cascading...`);
				response.text().catch(() => { });
				continue;
			}

			return { response, endpoint };
		} catch (err) {
			if (endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1) {
				log(`Endpoint ${endpoint} failed: ${err instanceof Error ? err.message : err}, cascading...`);
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
	onSuccess: (response: Response, context: RotationAttemptContext) => Promise<T>,
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
			rotator.finishRequest(nextAccount, resolveQuotaModelKey(model) ?? undefined);
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
		const displayModelKey = resolveDisplayModelKey(model);
		const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
		const requestStartMs = Date.now();
		const logRequestEnd = (status: string | number, extra = ""): void => {
			log(
				`[${requestId}] END account=${label} model=${model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
				rotator,
				status === 200 || status === 0 ? "info" : "warn",
			);
		};

		log(`[${requestId}] START account=${label} model=${model} attempt=${attempt + 1}`, rotator);

		try {
			const jitterMs = rotator.getSafetyJitterMs(account);
			if (jitterMs > 0) {
				log(`[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`, rotator, "warn");
				await sleep(jitterMs);
			}

			rotator.recordUpstreamAttempt(account);
			const forwarded = await forwardRequest(account, { ...body }, originalHeaders);
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

			if (response.status === 429) {
				const errorText = await response.text().catch(() => "");
				const providerResourceExhausted = isResourceExhausted(errorText);
				const cooldownMs = providerResourceExhausted
					? RESOURCE_EXHAUSTED_COOLDOWN_MS
					: capCooldown(extractRetryDelay(errorText, response.headers));
				log(
					`[${label}] 429 rate limited${providerResourceExhausted ? " (RESOURCE_EXHAUSTED)" : ""}, cooldown ${Math.ceil(cooldownMs / 1000)}s. Error text: ${errorText.slice(0, 300)}`,
					rotator,
					"warn",
				);
				rotator.markExhausted(account, model, cooldownMs, errorText.slice(0, 300));
				rotator.recordProvider429(account, model, cooldownMs);
				logRequestEnd(429, `cooldownMs=${cooldownMs}${providerResourceExhausted ? " resourceExhausted=true" : ""}`);
				return {
					ok: false,
					status: 429,
					errorText,
					retryAfterMs: cooldownMs,
					endpoint,
				};
			}

			if (response.status === 401) {
				const errorText = await response.text().catch(() => "");
				log(`[${label}] BLOCKED (401): ${errorText.slice(0, 200)}`, rotator, "error");
				const lower401 = errorText.toLowerCase();
				const matched401 = FLAG_PATTERNS.filter((p) => lower401.includes(p));
				const ctx401 = rotator.getFlagContext(account, modelKey);
				reportFlagEvent({
					flagHttpStatus: 401,
					flagPatternsMatched: matched401.length > 0 ? matched401 : ["blocked_401" as FlagPattern],
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

				rotator.markFlagged(account, `Account blocked (401): ${errorText.slice(0, 300)}`);
				logRequestEnd(401);
				const nextAccount = await rotateAndRelease();
				if (!nextAccount) {
					return sendNoAccountsAvailable(`no replacement account remained after ${label} was flagged with 401`);
				}
				continue;
			}

			if (response.status === 403) {
				const errorText = await response.text().catch(() => "");
				const lower = errorText.toLowerCase();
				const flagPatternsLocal = ["infring", "suspend", "abus", "terminat", "violat", "banned", "policy", "forbidden", "verif"];
				const isFlagged = flagPatternsLocal.some((p) => lower.includes(p));

				if (isFlagged) {
					log(`[${label}] FLAGGED: ${errorText.slice(0, 200)}`, rotator, "error");
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

					rotator.markFlagged(account, errorText.slice(0, 300));
					logRequestEnd(403);
					const nextAccount = await rotateAndRelease();
					if (!nextAccount) {
						return sendNoAccountsAvailable(`no replacement account remained after ${label} was flagged with 403`);
					}
					continue;
				}

				log(`[${label}] 403: ${errorText.slice(0, 200)}`, rotator, "warn");
				logRequestEnd(403);
				return { ok: false, status: 403, errorText, endpoint };
			}

			if (response.status === 404) {
				const errorText = await response.text().catch(() => "");
				log(`[${label}] 404 from ${endpoint}: ${errorText.slice(0, 200)}`, rotator, "warn");
				logRequestEnd(404, `endpoint=${endpoint}`);
				return { ok: false, status: 404, errorText, endpoint };
			}

			if (response.status === 400) {
				const errorText = await response.text().catch(() => "");
				log(`[${label}] 400 Bad Request from ${endpoint}: ${errorText.slice(0, 500)}`, rotator, "warn");
				logRequestEnd(400, `endpoint=${endpoint}`);
				return { ok: false, status: 400, errorText, endpoint };
			}

			if (response.status >= 500) {
				const errorText = await response.text().catch(() => "");
				log(`[${label}] Server error ${response.status}: ${errorText.slice(0, 200)}`, rotator, "warn");
				logRequestEnd(response.status, `endpoint=${endpoint}`);
				if (response.status === 503) {
					return { ok: false, status: 503, errorText, endpoint };
				}
				rotator.markError(account, `${response.status}: ${errorText.slice(0, 200)}`);
				const nextAccount = await rotateAndRelease();
				if (!nextAccount) {
					return sendNoAccountsAvailable(`no replacement account remained after ${label} failed with ${response.status}`);
				}
				continue;
			}

			const result = await onSuccess(response, context);
			const shouldRotate = rotator.recordRequest(account, model);
			logRequestEnd(response.status, `endpoint=${endpoint}`);
			if (shouldRotate) {
				await rotateAndRelease();
			}
			return { ok: true, result, endpoint };
		} catch (err) {
			const formattedError = formatError(err);
			log(`[${label}] Request failed: ${formattedError}`, rotator, isFetchTransportError(err) ? "warn" : "error");
			logRequestEnd(isFetchTransportError(err) ? "fetch-error" : 500, `error=${formattedError.slice(0, 120)}`);
			if (!isFetchTransportError(err)) {
				rotator.markError(account, formattedError);
			}
			const nextAccount = await rotateAndRelease();
			if (!nextAccount) {
				return sendNoAccountsAvailable(`no replacement account remained after ${label} request error`);
			}
			continue;
		} finally {
			rotator.finishRequest(account, resolveQuotaModelKey(model) ?? undefined);
		}
	}

	return { ok: false, status: 502, errorText: "All retry attempts failed" };
}

function log(msg: string, rotator?: AccountRotator, level: "info" | "warn" | "error" = "info"): void {
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
			res.end(JSON.stringify({ error: "Payload too large", limitBytes: err.limitBytes }));
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
			res.end(JSON.stringify({ error: "Invalid request body", details: validation.errors }));
			return;
		}
		body = validation.value as RequestBody;
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Invalid JSON body" }));
		return;
	}

	const proxyLog = (msg: string, level: "info" | "warn" | "error" = "info"): void => {
		log(msg, rotator, level);
	};
	if (bodyBuffer.length > LARGE_CONTEXT_WARN_BYTES) {
		proxyLog(`[${body.model}] Large request body ${bodyBuffer.length} bytes; high context pressure increases rate-limit/flag risk`, "warn");
	}

	const sendNoAccountsAvailable = (reason: string): void => {
		proxyLog(`[${body.model}] No healthy account available: ${reason}`, "warn");
		const retryAfterMs = rotator.getRetryAfterMs(body.model);
		if (retryAfterMs > 0) {
			res.writeHead(429, {
				"Content-Type": "application/json",
				"Retry-After": String(Math.ceil(retryAfterMs / 1000)),
			});
			res.end(JSON.stringify({
				error: "All accounts cooling down or model circuit breaker active",
				reason,
				model: body.model,
				retryAfterMs,
			}));
			return;
		}
		res.writeHead(503, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "All accounts exhausted or disabled", reason, model: body.model, retryable: false }));
	};
	const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
		const nextAccount = await rotator.rotateToNext(body.model);
		if (nextAccount) {
			rotator.finishRequest(nextAccount, resolveQuotaModelKey(body.model) ?? undefined);
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
		const modelKey = resolveQuotaModelKey(body.model) ?? body.model;      // quota routing
		const displayModelKey = resolveDisplayModelKey(body.model);            // metrics/logs
		const requestId = `${modelKey}-${Date.now().toString(36)}-${attempt + 1}`;
		proxyLog(`[${requestId}] START account=${label} model=${body.model} attempt=${attempt + 1}`);
		const requestStartMs = Date.now();
		const logRequestEnd = (status: string | number, extra = ""): void => {
			proxyLog(
				`[${requestId}] END account=${label} model=${body.model} status=${status}${extra ? ` ${extra}` : ""} totalMs=${Date.now() - requestStartMs}`,
				status === 200 || status === 0 ? "info" : "warn",
			);
		};
		const recordOutcome = (statusCode: number, ttfbMs = 0, totalMs = Date.now() - requestStartMs, inputTokens = 0, outputTokens = 0): void => {
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
			if (jitterMs > 0) {
				proxyLog(`[${requestId}] Safety slow-mode jitter ${jitterMs}ms for account/project daily budget pressure`, "warn");
				await sleep(jitterMs);
			}
			rotator.recordUpstreamAttempt(account);
			const forwarded = await forwardRequest(account, { ...body }, flattenHeaders(req.headers));
			const { response, endpoint } = forwarded;

			if (response.status === 429) {
				const errorText = await response.text().catch(() => "");
				const providerResourceExhausted = isResourceExhausted(errorText);
				const cooldownMs = providerResourceExhausted
					? RESOURCE_EXHAUSTED_COOLDOWN_MS
					: capCooldown(extractRetryDelay(errorText, response.headers));
				proxyLog(
					`[${label}] 429 rate limited${providerResourceExhausted ? " (RESOURCE_EXHAUSTED)" : ""}, cooldown ${Math.ceil(cooldownMs / 1000)}s. Error text: ${errorText.slice(0, 300)}`,
					"warn",
				);
				recordOutcome(429);
				logRequestEnd(429, `cooldownMs=${cooldownMs}${providerResourceExhausted ? " resourceExhausted=true" : ""} endpoint=${endpoint}`);
				rotator.markExhausted(account, body.model, cooldownMs);
				rotator.recordProvider429(account, body.model, cooldownMs);

				// Safety first: do NOT immediately retry another account on 429.
				// Provider-side 429s can represent daily/request buckets or shared project pressure;
				// cascading retries burn the full pool and increase ban/flag risk.
				res.writeHead(429, {
					"Content-Type": "application/json",
					"Retry-After": String(Math.ceil(cooldownMs / 1000)),
				});
				res.end(JSON.stringify({
					error: providerResourceExhausted ? "Resource exhausted" : "Rate limited",
					reason: providerResourceExhausted
						? `${label} hit provider RESOURCE_EXHAUSTED; not retrying another account to avoid pool-wide hammering`
						: `${label} was rate limited; not retrying another account for account-safety`,
					model: body.model,
					account: label,
					retryAfterMs: cooldownMs,
				}));
				return;
			}

			if (response.status === 401) {
				const errorText = await response.text().catch(() => "");
				proxyLog(`[${label}] BLOCKED (401): ${errorText.slice(0, 200)}`, "error");

				// Telemetry: report flag event BEFORE markFlagged (which may trigger protective pause)
				const lower401 = errorText.toLowerCase();
				const matched401 = FLAG_PATTERNS.filter(p => lower401.includes(p));
				const ctx401 = rotator.getFlagContext(account, modelKey);
				reportFlagEvent({
					flagHttpStatus: 401,
					flagPatternsMatched: matched401.length > 0 ? matched401 : ["blocked_401" as FlagPattern],
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

				rotator.markFlagged(account, `Account blocked (401): ${errorText.slice(0, 300)}`);
				logRequestEnd(401, `endpoint=${endpoint}`);
				const nextAccount = await rotateAndRelease();
				if (!nextAccount) {
					sendNoAccountsAvailable(`no replacement account remained after ${label} was flagged with 401`);
					return;
				}
				continue;
			}

			if (response.status === 403) {
				const errorText = await response.text().catch(() => "");
				const lower = errorText.toLowerCase();
				const flagPatternsLocal = ["infring", "suspend", "abus", "terminat", "violat", "banned", "policy", "forbidden", "verif"];
				const isFlagged = flagPatternsLocal.some((p) => lower.includes(p));

				if (isFlagged) {
					proxyLog(`[${label}] FLAGGED: ${errorText.slice(0, 200)}`, "error");
					recordOutcome(403);
					logRequestEnd(403, `endpoint=${endpoint}`);

					// Telemetry: report flag event with full anonymous context
					const matchedPatterns = FLAG_PATTERNS.filter(p => lower.includes(p));
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

					rotator.markFlagged(account, errorText.slice(0, 300));
					const nextAccount = await rotateAndRelease();
					if (!nextAccount) {
						sendNoAccountsAvailable(`no replacement account remained after ${label} was flagged with 403`);
						return;
					}
					continue;
				}
				// Non-flagging 403: return to client
				proxyLog(`[${label}] 403: ${errorText.slice(0, 200)}`, "warn");
				logRequestEnd(403, `endpoint=${endpoint}`);
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(errorText || JSON.stringify({ error: "Forbidden" }));
				return;
			}

			if (response.status >= 500) {
				const errorText = await response.text().catch(() => "");
				proxyLog(`[${label}] Server error ${response.status}: ${errorText.slice(0, 200)}`, "warn");
				recordOutcome(response.status);
				logRequestEnd(response.status, `endpoint=${endpoint}`);
				if (response.status === 503) {
					// Return 503 as-is. Capacity errors still consume quota upstream,
					// so retrying on another account would just burn more quota for nothing.
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(errorText || JSON.stringify({ error: "Server unavailable", account: label, model: body.model }));
					return;
				}
				rotator.markError(account, `${response.status}: ${errorText.slice(0, 200)}`);
				const nextAccount = await rotateAndRelease();
				if (!nextAccount) {
					sendNoAccountsAvailable(`no replacement account remained after ${label} failed with ${response.status}`);
					return;
				}
				continue;
			}

			// Success or non-error client response
			const shouldRotate = rotator.recordRequest(account, body.model);

			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				if (key.toLowerCase() !== "transfer-encoding" && key.toLowerCase() !== "connection") {
					responseHeaders[key] = value;
				}
			});

			res.writeHead(response.status, responseHeaders);

			try {
				const usage = await streamResponseBody(response.body, req, res, label, proxyLog);
				const totalMs = Date.now() - requestStartMs;
				const ttfbMs = usage?.firstByteMs ?? totalMs;
				rotator.recordLatency(body.model, ttfbMs, totalMs);
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
					rotator.recordTokenUsage(body.model, usage.inputTokens, usage.outputTokens);
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
			proxyLog(`[${label}] Request failed: ${formattedError}`, isFetchTransportError(err) ? "warn" : "error");
			recordOutcome(isFetchTransportError(err) ? 0 : 500);
			logRequestEnd(isFetchTransportError(err) ? "fetch-error" : 500, `error=${formattedError.slice(0, 120)}`);
			if (!isFetchTransportError(err)) {
				rotator.markError(account, formattedError);
			}
			if (res.headersSent) {
				res.end();
				return;
			}
			const nextAccount = await rotateAndRelease();
			if (!nextAccount) {
				sendNoAccountsAvailable(`no replacement account remained after ${label} request error`);
				return;
			}
			continue;
		} finally {
			rotator.finishRequest(account, resolveQuotaModelKey(body.model) ?? undefined);
			if (onComplete) onComplete();
		}
	}

	if (!res.headersSent) {
		res.writeHead(502, { "Content-Type": "application/json" });
	}
	res.end(JSON.stringify({ error: "All retry attempts failed" }));
}

export function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value) {
			flat[key] = Array.isArray(value) ? value.join(", ") : value;
		}
	}
	return flat;
}

export function startProxy(rotator: AccountRotator, port: number): void {
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

		if (method === "GET" && pathname === "/auth/antigravity/start") {
			if (!requireAdmin(req, res)) return;
			startHostedLogin(req, res);
			return;
		}

		if (method === "GET" && pathname === "/auth/antigravity/callback") {
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

		if (method === "GET" && pathname === "/api/events") {
			if (!requireAdmin(req, res)) return;
			// Server-Sent Events for live dashboard
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
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

		if (method === "POST" && url.startsWith("/api/clear-inflight/")) {
			if (!requireAdmin(req, res)) return;
			const rest = url.slice("/api/clear-inflight/".length);
			const firstSlash = rest.indexOf("/");
			const email = decodeURIComponent(firstSlash >= 0 ? rest.slice(0, firstSlash) : rest);
			const modelKey = firstSlash >= 0 ? decodeURIComponent(rest.slice(firstSlash + 1)) : undefined;
			serveClearInFlightApi(res, rotator, email, modelKey);
			return;
		}

		if (method === "POST" && url?.startsWith("/api/account/swap-windows/")) {
			if (!requireAdmin(req, res)) return;
			const rest = url.slice("/api/account/swap-windows/".length);
			const email = decodeURIComponent(rest);
			const account = rotator.getAccountByEmail(email);
			if (account && account.quotaWindows) {
				for (const m of Object.keys(account.quotaWindows)) {
					const temp = account.quotaWindows[m].pro;
					account.quotaWindows[m].pro = account.quotaWindows[m].free;
					account.quotaWindows[m].free = temp;
				}
				rotator.saveState();
				res.writeHead(200);
				res.end(JSON.stringify({ success: true }));
			} else {
				res.writeHead(404);
				res.end("Account not found");
			}
			return;
		}

		if (method === "POST" && (url === "/api/settings/fresh-window-starts/on" || url === "/api/settings/fresh-window-starts/off")) {
			if (!requireAdmin(req, res)) return;
			trackFeature("freshWindowToggle");
			serveFreshWindowStartsApi(res, rotator, url.endsWith("/on"));
			return;
		}

		if (
			method === "POST" &&
			(url.startsWith("/api/account-fresh-window-starts/") && (url.endsWith("/on") || url.endsWith("/off")))
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
				res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
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

		if (method === "POST" && pathname === "/v1/chat/completions") {
			handleOpenAIChatCompletions(req, res, rotator).catch((err) => {
				log(`OpenAI compat error: ${err}`, rotator, "error");
				if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Internal OpenAI compat error", type: "server_error" } }));
			});
			return;
		}

		// Anthropic-compatible adapter route (additive; does not affect native v1internal route)
		if (method === "POST" && pathname === "/v1/messages") {
			handleAnthropicMessages(req, res, rotator).catch((err) => {
				log(`Anthropic compat error: ${err}`, rotator, "error");
				if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "server_error", message: "Internal Anthropic compat error" } }));
			});
			return;
		}

		// Proxy route
		if (method === "POST" && url.includes("v1internal")) {
			handleProxyRequest(req, res, rotator, scheduleSseBroadcast).catch((err) => {
				log(`Unhandled error: ${err}`, rotator, "error");
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
				}
				res.end(JSON.stringify({ error: "Internal proxy error" }));
			});
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	});

	server.listen(port, "0.0.0.0", () => {
		log(`Listening on 0.0.0.0:${port}`, rotator);
		log(`Dashboard: http://localhost:${port}/dashboard`, rotator);
		log(`Hosted login: http://localhost:${port}/login`, rotator);
	});
}
