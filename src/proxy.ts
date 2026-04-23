// HTTP reverse proxy - forwards requests to Antigravity with credential rotation

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { ANTIGRAVITY_ENDPOINTS } from "./types.js";
import type { AccountRuntime } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import {
	serveDashboard,
	serveStatusApi,
	serveEnableApi,
} from "./dashboard.js";
import { handleHostedCallback, serveLoginLanding, startHostedLogin } from "./onboarding.js";

const MAX_ENDPOINT_RETRIES = 3;
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes max cooldown

interface RequestBody {
	project: string;
	model: string;
	request: unknown;
	requestType?: string;
	userAgent?: string;
	requestId?: string;
	[key: string]: unknown;
}

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

/**
 * Read the full request body from an IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Forward a request to the real Antigravity endpoint with credential swapping.
 */
async function forwardRequest(
	account: AccountRuntime,
	body: RequestBody,
	originalHeaders: Record<string, string>,
): Promise<Response> {
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
		if (key.toLowerCase() === "authorization") {
			delete forwardHeaders[key];
		}
	}
	forwardHeaders["Authorization"] = `Bearer ${account.accessToken}`;
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
				response.text().catch(() => {});
				continue;
			}

			return response;
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

function log(msg: string, rotator?: AccountRotator, level: "info" | "warn" | "error" = "info"): void {
	const ts = new Date().toISOString().slice(11, 19);
	console.log(`[${ts}] [proxy] ${msg}`);
	rotator?.recordProxyEvent(msg, level);
}

/**
 * Handle a proxied API request.
 */
async function handleProxyRequest(
	req: IncomingMessage,
	res: ServerResponse,
	rotator: AccountRotator,
): Promise<void> {
	const bodyBuffer = await readBody(req);
	let body: RequestBody;
	try {
		body = JSON.parse(bodyBuffer.toString("utf-8"));
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Invalid JSON body" }));
		return;
	}

	const proxyLog = (msg: string, level: "info" | "warn" | "error" = "info"): void => {
		log(msg, rotator, level);
	};

	const sendNoAccountsAvailable = (reason: string): void => {
		proxyLog(`[${body.model}] No healthy account available: ${reason}`, "warn");
		res.writeHead(503, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "All accounts exhausted or disabled", reason, model: body.model }));
	};
	const rotateAndRelease = async (): Promise<AccountRuntime | null> => {
		const nextAccount = await rotator.rotateToNext(body.model);
		if (nextAccount) {
			rotator.finishRequest(nextAccount);
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
		proxyLog(`[${label}] Forwarding ${body.model} request (attempt ${attempt + 1})`);

		try {
			const response = await forwardRequest(account, { ...body }, flattenHeaders(req.headers));

			if (response.status === 429) {
				const errorText = await response.text().catch(() => "");
				const cooldownMs = capCooldown(extractRetryDelay(errorText, response.headers));
				proxyLog(`[${label}] 429 rate limited, cooldown ${Math.ceil(cooldownMs / 1000)}s`, "warn");
				rotator.markExhausted(account, cooldownMs);
				const nextAccount = await rotateAndRelease();
				if (!nextAccount) {
					sendNoAccountsAvailable(`all candidate accounts are cooling down after ${label} was rate limited`);
					return;
				}
				continue;
			}

				if (response.status === 401) {
					const errorText = await response.text().catch(() => "");
					proxyLog(`[${label}] BLOCKED (401): ${errorText.slice(0, 200)}`, "error");
					rotator.markFlagged(account, `Account blocked (401): ${errorText.slice(0, 300)}`);
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
				const flagPatterns = ["infring", "suspend", "abus", "terminat", "violat", "banned", "policy", "forbidden", "verif"];
					const isFlagged = flagPatterns.some((p) => lower.includes(p));

					if (isFlagged) {
						proxyLog(`[${label}] FLAGGED: ${errorText.slice(0, 200)}`, "error");
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
					res.writeHead(403, { "Content-Type": "application/json" });
				res.end(errorText || JSON.stringify({ error: "Forbidden" }));
				return;
			}

				if (response.status >= 500) {
					const errorText = await response.text().catch(() => "");
					proxyLog(`[${label}] Server error ${response.status}: ${errorText.slice(0, 200)}`, "warn");
				if (response.status === 503) {
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(errorText || JSON.stringify({ error: "Server unavailable" }));
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

			// Stream body using Node.js Readable (avoids ReadableStream locking issues)
			if (response.body) {
				try {
					const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
						await new Promise<void>((resolve) => {
							nodeStream.on("data", (chunk: Buffer) => res.write(chunk));
							nodeStream.on("end", resolve);
							nodeStream.on("error", (err) => {
								proxyLog(`[${label}] Stream error: ${err}`, "warn");
								resolve();
							});
						});
					} catch (err) {
						proxyLog(`[${label}] Stream setup error: ${err}`, "warn");
					}
				}
			res.end();

			if (shouldRotate) {
				await rotateAndRelease();
				}
				return;
			} catch (err) {
				proxyLog(`[${label}] Request failed: ${err}`, "error");
				rotator.markError(account, err instanceof Error ? err.message : String(err));
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
			rotator.finishRequest(account);
		}
	}

	if (!res.headersSent) {
		res.writeHead(502, { "Content-Type": "application/json" });
	}
	res.end(JSON.stringify({ error: "All retry attempts failed" }));
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value) {
			flat[key] = Array.isArray(value) ? value.join(", ") : value;
		}
	}
	return flat;
}

export function startProxy(rotator: AccountRotator, port: number): void {
	const server = createServer((req, res) => {
		const method = req.method?.toUpperCase();
		const url = req.url || "";
		const pathname = url.split("?")[0];

		if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
			serveDashboard(res);
			return;
		}

		if (method === "GET" && pathname === "/login") {
			serveLoginLanding(res);
			return;
		}

		if (method === "GET" && pathname === "/auth/antigravity/start") {
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

		if (method === "GET" && url === "/api/status") {
			serveStatusApi(res, rotator);
			return;
		}

		if (method === "POST" && url.startsWith("/api/enable/")) {
			const email = decodeURIComponent(url.slice("/api/enable/".length));
			serveEnableApi(res, rotator, email);
			return;
		}

		// Proxy route
		if (method === "POST" && url.includes("v1internal")) {
			handleProxyRequest(req, res, rotator).catch((err) => {
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
