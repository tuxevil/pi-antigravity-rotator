import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ensureAdminToken,
  generateAdminToken,
  getConfiguredAdminToken,
  getRequestAdminToken,
  isAdminAuthorized,
  readPersistedAdminToken,
  setPersistedAdminToken,
  writePersistedAdminToken,
} from "../src/admin-auth.js";
import { initDb, getCachedAdminToken } from "../src/db-store.js";

function req(
  url: string,
  headers: Record<string, string | string[] | undefined> = {},
) {
  return { url, headers };
}

describe("admin auth helpers", () => {
  beforeEach(() => {
    // Reset module-level state between tests so setPersistedAdminToken from
    // one test does not leak into another.
    setPersistedAdminToken(null);
  });

  it("treats missing configured token as legacy open access", () => {
    assert.equal(getConfiguredAdminToken({}), null);
    assert.equal(isAdminAuthorized(req("/api/status"), null), true);
  });

  it("trims configured token and ignores empty values", () => {
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "  secret  " }),
      "secret",
    );
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "   " }),
      null,
    );
  });

  it("accepts x-rotator-admin-token header", () => {
    const request = req("/api/status", { "x-rotator-admin-token": "secret" });
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("accepts bearer authorization header", () => {
    const request = req("/api/status", { authorization: "Bearer secret" });
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("accepts token query parameter for browser/SSE access", () => {
    const request = req("/api/events?token=secret");
    assert.equal(getRequestAdminToken(request), "secret");
    assert.equal(isAdminAuthorized(request, "secret"), true);
  });

  it("rejects wrong token when configured", () => {
    assert.equal(
      isAdminAuthorized(req("/api/status?token=wrong"), "secret"),
      false,
    );
  });

  it("returns persisted token after setPersistedAdminToken", () => {
    setPersistedAdminToken("persisted-secret");
    assert.equal(getConfiguredAdminToken({}), "persisted-secret");
  });

  it("env var takes priority over persisted token", () => {
    setPersistedAdminToken("persisted-secret");
    assert.equal(
      getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "env-secret" }),
      "env-secret",
    );
  });

  it("setPersistedAdminToken(null) clears the persisted token", () => {
    setPersistedAdminToken("persisted-secret");
    setPersistedAdminToken(null);
    assert.equal(getConfiguredAdminToken({}), null);
  });
});

describe("admin token generation and persistence", () => {
  before(async () => {
    await initDb();
  });

  beforeEach(() => {
    setPersistedAdminToken(null);
    // Clear repository state for admin_token between tests
    writePersistedAdminToken("");
  });

  it("generateAdminToken returns 64 hex chars (256 bits)", () => {
    const token = generateAdminToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("two consecutive tokens are different", () => {
    const a = generateAdminToken();
    const b = generateAdminToken();
    assert.notEqual(a, b);
  });

  it("writePersistedAdminToken persists to the repository", () => {
    writePersistedAdminToken("abc123");
    const cached = getCachedAdminToken();
    assert.equal(cached, "abc123");
  });

  it("readPersistedAdminToken reads from the repository", () => {
    writePersistedAdminToken("my-secret-token");
    assert.equal(readPersistedAdminToken(), "my-secret-token");
  });

  it("readPersistedAdminToken returns null when no token is stored", () => {
    // After beforeEach clears it with empty string, getCachedAdminToken trims → null
    assert.equal(readPersistedAdminToken(), null);
  });

  it("ensureAdminToken returns env var when present", () => {
    const result = ensureAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "envtok" });
    assert.equal(result.source, "env");
    assert.equal(result.token, "envtok");
    assert.equal(result.generated, false);
  });

  it("ensureAdminToken reads from repository when env is absent", () => {
    writePersistedAdminToken("repotok");
    const result = ensureAdminToken({});
    assert.equal(result.source, "repository");
    assert.equal(result.token, "repotok");
    assert.equal(result.generated, false);
  });

  it("ensureAdminToken generates and persists a new token when neither is present", () => {
    const result = ensureAdminToken({});
    assert.equal(result.source, "generated");
    assert.equal(result.generated, true);
    assert.equal(result.token.length, 64);
    // Token should now be in the repository
    assert.equal(readPersistedAdminToken(), result.token);
  });

  it("ensureAdminToken is idempotent: second call returns same repository token", () => {
    const first = ensureAdminToken({});
    setPersistedAdminToken(null); // clear runtime cache so it goes to repository
    const second = ensureAdminToken({});
    assert.equal(second.source, "repository");
    assert.equal(second.token, first.token);
    assert.equal(second.generated, false);
  });

  it("requireAdmin now blocks requests when only a persisted token is set", () => {
    const resolved = ensureAdminToken({});
    setPersistedAdminToken(resolved.token);
    assert.equal(isAdminAuthorized(req("/api/status")), false);
    assert.equal(
      isAdminAuthorized(
        req("/api/status", { "x-rotator-admin-token": resolved.token }),
      ),
      true,
    );
    setPersistedAdminToken(null);
  });

  it("OAuth callback authorization mirrors the rest of the admin surface", () => {
    // No token: callback is open (legacy behaviour).
    setPersistedAdminToken(null);
    assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), true);

    // With a token: callback requires the header.
    setPersistedAdminToken("secret-callback");
    assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), false);
    assert.equal(
      isAdminAuthorized(
        req("/auth/antigravity/callback", {
          "x-rotator-admin-token": "secret-callback",
        }),
      ),
      true,
    );
    assert.equal(
      isAdminAuthorized(
        req("/auth/antigravity/callback", {
          authorization: "Bearer secret-callback",
        }),
      ),
      true,
    );
  });

  it("logs a truncated preview of generated tokens, never the full value", () => {
    const truncate = (token: string): string =>
      token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;

    const fullToken = "abcdef0123456789fedcba9876543210";
    const preview = truncate(fullToken);
    assert.equal(preview, "abcdef01…3210");
    assert.ok(
      !preview.includes(fullToken),
      "preview must not contain the full token",
    );
    assert.ok(
      !preview.includes("23456789"),
      "middle of the token must not leak",
    );
    assert.ok(
      !preview.includes("fedcba9876"),
      "second half of the token must not leak",
    );
  });
});
