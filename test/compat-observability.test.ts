import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
  handleAnthropicMessages,
  handleGeminiGenerateContent,
  handleOpenAIChatCompletions,
  handleOpenAIResponsesCreate,
  resetResponsesStoreForTests,
} from "../src/compat.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import { ANTIGRAVITY_ENDPOINTS, type AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

type RequestLogCapture = {
  model: string;
  account: string;
  statusCode: number;
  ttfbMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
};

type Tracking = {
  requestLogs: RequestLogCapture[];
  latencies: Array<{ model: string | undefined; ttfbMs: number; totalMs: number }>;
  tokenUsage: Array<{ model: string | undefined; inputTokens: number; outputTokens: number }>;
  recordRequests: number;
  finishRequests: number;
};

type ResponseStub = ServerResponse & {
  statusCodeCaptured: number;
  body: string;
};

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

afterEach(() => {
  endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
  resetResponsesStoreForTests();
  stopVersionChecker();
  stopNotificationPoller();
});

function createTracking(): Tracking {
  return {
    requestLogs: [],
    latencies: [],
    tokenUsage: [],
    recordRequests: 0,
    finishRequests: 0,
  };
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

function createRotatorStub(tracking: Tracking): AccountRotator {
  const account = createAccount();
  return {
    getActiveAccount: async () => account,
    getRetryAfterMs: () => 0,
    rotateToNext: async () => null,
    finishRequest: () => {
      tracking.finishRequests++;
    },
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
    recordRequest: () => {
      tracking.recordRequests++;
      return false;
    },
    recordProxyEvent: () => {},
    getGlobalDelayMs: () => 0,
    recordLatency: (
      model: string | undefined,
      ttfbMs: number,
      totalMs: number,
    ) => {
      tracking.latencies.push({ model, ttfbMs, totalMs });
    },
    recordRequestLog: (entry: RequestLogCapture) => {
      tracking.requestLogs.push(entry);
    },
    recordTokenUsage: (
      model: string | undefined,
      inputTokens: number,
      outputTokens: number,
    ) => {
      tracking.tokenUsage.push({ model, inputTokens, outputTokens });
    },
    saveState: () => {},
    getStatus: () => ({ accounts: [] }),
  } as unknown as AccountRotator;
}

function requestStream(
  method: string,
  url: string,
  payload?: unknown,
): IncomingMessage & PassThrough {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "user-agent": "compat-observability-test",
  };
  process.nextTick(() => stream.end(body));
  return stream;
}

function responseStub(): ResponseStub {
  let headersSent = false;
  let writableEnded = false;
  const res = {
    statusCodeCaptured: 0,
    body: "",
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    writeHead(status: number) {
      this.statusCodeCaptured = status;
      headersSent = true;
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      writableEnded = true;
      return this;
    },
  } as ResponseStub;
  return res;
}

async function listenServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await closeServer(server);
}

async function startTestProxy(rotator: AccountRotator): Promise<Server> {
  const server = startProxy(rotator, 0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

async function postAndAbortAfterFirstChunk(
  url: string,
  payload: unknown,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.once("data", () => {
          res.destroy();
          req.destroy();
          resolve();
        });
      },
    );
    req.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") return;
      reject(err);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      reject(new Error("timed out waiting for first response chunk"));
    });
    req.end(body);
  });
}

async function assertCompatAbortReleasesInFlight(
  path: string,
  payload: unknown,
): Promise<void> {
  let upstreamResponse: ServerResponse | undefined;
  const upstream = await listenServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamResponse = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
  });
  endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

  const tracking = createTracking();
  const rotator = createRotatorStub(tracking);
  const proxy = await startTestProxy(rotator);
  const port = (proxy.address() as AddressInfo).port;

  try {
    await postAndAbortAfterFirstChunk(
      `http://127.0.0.1:${port}${path}`,
      payload,
    );

    await waitFor(() => tracking.finishRequests === 1);
  } finally {
    upstreamResponse?.destroy();
    await closeHttpServer(proxy);
    await closeHttpServer(upstream.server);
  }
}

function assertCompatObservability(
  tracking: Tracking,
  statusCode: number,
  inputTokens: number,
  outputTokens: number,
): void {
  assert.equal(tracking.requestLogs.length, 1);
  assert.equal(tracking.latencies.length, 1);
  assert.equal(tracking.requestLogs[0].statusCode, statusCode);
  assert.equal(tracking.requestLogs[0].account, "test-account");
  assert.equal(tracking.requestLogs[0].inputTokens, inputTokens);
  assert.equal(tracking.requestLogs[0].outputTokens, outputTokens);
  assert.equal(tracking.requestLogs[0].ttfbMs >= 0, true);
  assert.equal(tracking.requestLogs[0].totalMs >= tracking.requestLogs[0].ttfbMs, true);
  assert.equal(tracking.latencies[0].ttfbMs, tracking.requestLogs[0].ttfbMs);
  assert.equal(tracking.latencies[0].totalMs, tracking.requestLogs[0].totalMs);
}

describe("compat observability", () => {
  it("records request log, latency, and token usage for successful compat routes", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7}}}\n\n',
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const cases: Array<{
        name: string;
        request: IncomingMessage & PassThrough;
        run: (
          req: IncomingMessage,
          res: ServerResponse,
          rotator: AccountRotator,
        ) => Promise<void>;
      }> = [
        {
          name: "openai chat",
          request: requestStream("POST", "/v1/chat/completions", {
            model: "gemini-3.5-flash",
            messages: [{ role: "user", content: "ping" }],
          }),
          run: handleOpenAIChatCompletions,
        },
        {
          name: "anthropic messages",
          request: requestStream("POST", "/v1/messages", {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "ping" }],
          }),
          run: handleAnthropicMessages,
        },
        {
          name: "gemini generateContent",
          request: requestStream(
            "POST",
            "/v1beta/models/gemini-3-flash:generateContent",
            {
              contents: [{ role: "user", parts: [{ text: "ping" }] }],
            },
          ),
          run: handleGeminiGenerateContent,
        },
      ];

      for (const testCase of cases) {
        const tracking = createTracking();
        const rotator = createRotatorStub(tracking);
        const res = responseStub();
        await testCase.run(testCase.request, res, rotator);

        assert.equal(res.statusCodeCaptured, 200, testCase.name);
        assertCompatObservability(tracking, 200, 11, 7);
        assert.equal(tracking.tokenUsage.length, 1, testCase.name);
        assert.equal(tracking.tokenUsage[0].inputTokens, 11);
        assert.equal(tracking.tokenUsage[0].outputTokens, 7);
        assert.equal(tracking.recordRequests, 1, testCase.name);
      }
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("records failed compat upstream responses without token double-counting", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporarily down" }));
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const tracking = createTracking();
      const rotator = createRotatorStub(tracking);
      const req = requestStream("POST", "/v1/chat/completions", {
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "ping" }],
      });
      const res = responseStub();
      await handleOpenAIChatCompletions(req, res, rotator);

      assert.equal(res.statusCodeCaptured, 503);
      assertCompatObservability(tracking, 503, 0, 0);
      assert.equal(tracking.tokenUsage.length, 0);
      assert.equal(tracking.recordRequests, 0);
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("records Responses streaming observability with parsed usage", async () => {
    const upstream = await listenServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          [
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"po"}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ng"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
            "",
          ].join("\n"),
        );
      });
    });
    endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

    try {
      const tracking = createTracking();
      const rotator = createRotatorStub(tracking);
      const req = requestStream("POST", "/v1/responses", {
        model: "gemini-3.5-flash",
        input: "ping",
        stream: true,
      });
      const res = responseStub();
      await handleOpenAIResponsesCreate(req, res, rotator);

      assert.equal(res.statusCodeCaptured, 200);
      assert.match(res.body, /"type":"response.completed"/);
      assertCompatObservability(tracking, 200, 5, 3);
      assert.equal(tracking.tokenUsage.length, 1);
      assert.equal(tracking.tokenUsage[0].inputTokens, 5);
      assert.equal(tracking.tokenUsage[0].outputTokens, 3);
    } finally {
      await closeServer(upstream.server);
    }
  });

  it("releases an in-flight compat chat request when the client disconnects before upstream completes", async () => {
    await assertCompatAbortReleasesInFlight("/v1/chat/completions", {
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "hold the stream open" }],
      stream: true,
    });
  });

  it("releases an in-flight Responses request when the client disconnects before upstream completes", async () => {
    await assertCompatAbortReleasesInFlight("/v1/responses", {
      model: "gemini-3.5-flash",
      input: "hold the stream open",
      stream: true,
    });
  });
});
