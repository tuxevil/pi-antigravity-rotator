import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setPersistedAdminToken } from "../src/admin-auth.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";

function makeRotator() {
  const state = {
    enabledEmail: "",
    events: [] as string[],
  };
  const rotator = {
    saveState() {},
    getStatus() {
      return { accounts: [], security: { adminTokenConfigured: true } };
    },
    enableAccount(email: string) {
      state.enabledEmail = email;
      return email === "user@example.com";
    },
    recordProxyEvent(message: string) {
      state.events.push(message);
    },
  };
  return { rotator, state };
}

async function startTestProxy(rotator: unknown): Promise<Server> {
  const server = startProxy(rotator as never, 0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("proxy admin routes", () => {
  let server: Server | null = null;
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("secret");
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
    if (previousTelemetry === undefined) {
      delete process.env.PI_ROTATOR_TELEMETRY;
    } else {
      process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
    }
  });

  it("matches dynamic admin routes by pathname while preserving query-token auth", async () => {
    const { rotator, state } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/enable/user%40example.com?token=secret`,
      { method: "POST" },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, email: "user@example.com" });
    assert.equal(state.enabledEmail, "user@example.com");
  });

  it("lets hosted OAuth callbacks reach state validation when admin auth is enabled", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/auth/antigravity/callback?code=abc&state=missing`,
    );
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Session Expired/);
    assert.doesNotMatch(body, /Unauthorized/);
  });
});
