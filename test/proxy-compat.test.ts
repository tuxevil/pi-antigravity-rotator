import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";
import { openAIToAntigravityBody } from "../src/compat.js";
import { forwardRequest, withRotation, type RequestBody } from "../src/proxy.js";
import { ANTIGRAVITY_ENDPOINTS, type AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

type Capture = {
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
};

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

afterEach(() => {
	endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
});

async function listenServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Server did not bind to a TCP port");
	}
	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
	};
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

function createAccount(): AccountRuntime {
	return {
		config: {
			email: "test@example.com",
			projectId: "test-project",
			refreshToken: "refresh-token",
			label: "test-account",
		},
		accessToken: "access-token",
		tokenExpires: Date.now() + 60_000,
		requestsSinceRotation: 0,
		totalRequests: 0,
		cooldownsByModel: {},
		quotaExhaustedAt: 0,
		quota: [],
		lastQuotaPoll: 0,
		lastUsed: 0,
		lastError: null,
		consecutiveErrors: 0,
		disabled: false,
		flagged: false,
		inFlightRequests: 0,
		inFlightByModel: {},
		allowFreshWindowStartsOverride: false,
		dailyRequestCount: 0,
		dailyRequestDay: "2026-05-16",
		healthScore: 1,
		tokenBucket: {
			tokens: 50,
			lastRefillAt: Date.now(),
		},
	};
}

function createRotatorStub(account: AccountRuntime): AccountRotator {
	return {
		getActiveAccount: async () => account,
		getRetryAfterMs: () => 0,
		rotateToNext: async () => null,
		finishRequest: () => {},
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => {},
		recordProvider429: () => {},
		getFlagContext: () => ({
			timerType: "fresh",
			accountQuotaPercent: 0,
			wasProAccount: false,
			accountRequestsLastHour: 0,
			poolSize: 1,
			poolHealthyCount: 1,
			uptimeSeconds: 0,
		}),
		markFlagged: () => {},
		markError: () => {},
		recordRequest: () => false,
		recordProxyEvent: () => {},
		getGlobalDelayMs: () => 0,
	} as unknown as AccountRotator;
}

describe("proxy compat integration", () => {
	it("cascades daily 404 to prod and preserves the compat payload", async () => {
		const capturesDaily: Capture[] = [];
		const capturesProd: Capture[] = [];

		const daily = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesDaily.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }));
			});
		});
		const prod = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesProd.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, daily.url, prod.url);

		const body = openAIToAntigravityBody({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "ping" },
			],
		});

		try {
			const outcome = await withRotation(
				createRotatorStub(createAccount()),
				body.model,
				{ "user-agent": "OpenAI/1.0.0" },
				body,
				async () => "unexpected-success",
			);

			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.status, 404);
				assert.equal(outcome.endpoint, prod.url);
				assert.match(outcome.errorText, /NOT_FOUND/);
			}

			assert.equal(capturesDaily.length, 1);
			assert.equal(capturesProd.length, 1);
			assert.match(capturesDaily[0].url, /v1internal:streamGenerateContent\?alt=sse/);
			assert.match(capturesDaily[0].body, /"systemInstruction"/);
			assert.match(capturesDaily[0].body, /"contents":\[\{"role":"user","parts":\[\{"text":"ping"\}\]\}\]/);
			assert.match(capturesDaily[0].body, /"userAgent":"antigravity"/);
			assert.equal(capturesDaily[0].headers.authorization, "Bearer access-token");
			assert.equal(capturesDaily[0].headers["user-agent"], "antigravity/1.107.0 darwin/arm64");
			assert.equal(capturesDaily[0].headers["x-goog-api-client"], "google-cloud-sdk vscode_cloudshelleditor/0.1");
			assert.equal(capturesDaily[0].headers["client-metadata"], "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"MACOS\",\"pluginType\":\"GEMINI\"}");
		} finally {
			await closeServer(daily.server);
			await closeServer(prod.server);
		}
	});

	it("stops at the daily endpoint when it succeeds", async () => {
		const capturesDaily: Capture[] = [];
		const capturesProd: Capture[] = [];

		const daily = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesDaily.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n');
			});
		});
		const prod = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				capturesProd.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "should not reach prod" }));
			});
		});

		endpointOverrides.splice(0, endpointOverrides.length, daily.url, prod.url);

		const account = createAccount();
		const body = openAIToAntigravityBody({
			model: "gemini-3-flash",
			messages: [{ role: "user", content: "ping" }],
		});

		try {
			const forwarded = await forwardRequest(account, { ...body }, { "user-agent": "OpenAI/1.0.0" });
			assert.equal(forwarded.endpoint, daily.url);

			const outcome = await withRotation(
				createRotatorStub(account),
				body.model,
				{ "user-agent": "OpenAI/1.0.0" },
				body as RequestBody,
				async (response) => response.text(),
			);

			assert.equal(outcome.ok, true);
			if (outcome.ok) {
				assert.equal(outcome.endpoint, daily.url);
				assert.match(outcome.result, /"text":"ok"/);
			}
			assert.equal(capturesDaily.length >= 1, true);
			assert.equal(capturesProd.length, 0);
		} finally {
			await closeServer(daily.server);
			await closeServer(prod.server);
		}
	});
});
