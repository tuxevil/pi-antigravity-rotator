import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { extractVirtualKey, authenticateVirtualKey } from "../src/key-auth.js";

test("extractVirtualKey extracts Bearer token rk-...", () => {
  const req = {
    headers: {
      authorization: "Bearer rk-1234567890abcdef1234567890abcdef",
    },
  } as unknown as IncomingMessage;

  const key = extractVirtualKey(req);
  assert.equal(key, "rk-1234567890abcdef1234567890abcdef");
});

test("extractVirtualKey extracts x-rotator-key header", () => {
  const req = {
    headers: {
      "x-rotator-key": "rk-abcdef1234567890abcdef1234567890",
    },
  } as unknown as IncomingMessage;

  const key = extractVirtualKey(req);
  assert.equal(key, "rk-abcdef1234567890abcdef1234567890");
});

test("extractVirtualKey extracts x-api-key header", () => {
  const req = {
    headers: {
      "x-api-key": "rk-9999991234567890abcdef1234567890",
    },
  } as unknown as IncomingMessage;

  const key = extractVirtualKey(req);
  assert.equal(key, "rk-9999991234567890abcdef1234567890");
});

test("extractVirtualKey extracts from query string", () => {
  const req = {
    headers: { host: "localhost:3000" },
    url: "/v1/chat/completions?rotator_key=rk-7890abcdef1234567890abcdef123456",
  } as unknown as IncomingMessage;

  const key = extractVirtualKey(req);
  assert.equal(key, "rk-7890abcdef1234567890abcdef123456");
});

test("extractVirtualKey returns null when no virtual key present", () => {
  const req = {
    headers: { authorization: "Bearer some-other-token" },
    url: "/v1/chat/completions",
  } as unknown as IncomingMessage;

  const key = extractVirtualKey(req);
  assert.equal(key, null);
});

test("authenticateVirtualKey permits request when DB is not configured (backward compatibility)", async () => {
  const req = {
    headers: {},
  } as unknown as IncomingMessage;

  const result = await authenticateVirtualKey(req);
  assert.equal(result.authenticated, true);
  assert.equal(result.key, null);
});
