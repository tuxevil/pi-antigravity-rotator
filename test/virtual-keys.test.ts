import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hashKey,
  maskKey,
  lookupVirtualKey,
  listVirtualKeys,
  hasAnyVirtualKeys,
} from "../src/virtual-keys.js";

test("hashKey uses PBKDF2 (64-char hex, deterministic, differs from SHA256)", () => {
  const input = "rk-testkey123";
  const hash1 = hashKey(input);
  const hash2 = hashKey(input);
  const hash3 = hashKey("rk-otherkey456");

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
  assert.equal(hash1.length, 64);

  const sha256 = createHash("sha256").update(input.trim()).digest("hex");
  assert.notEqual(
    hash1,
    sha256,
    "PBKDF2 hash must differ from raw SHA256 for migration safety",
  );
});

test("maskKey masks raw key showing prefix and suffix", () => {
  const masked = maskKey("rk-1234567890abcdef1234567890abcdef");
  assert.equal(masked, "rk-123...cdef");
});

test("lookupVirtualKey returns null when DB is not configured", async () => {
  const result = await lookupVirtualKey("rk-nonexistent123456789012345678");
  assert.equal(result, null);
});

test("listVirtualKeys returns empty array when DB is not configured", async () => {
  const keys = await listVirtualKeys();
  assert.deepEqual(keys, []);
});

test("hasAnyVirtualKeys returns false when DB is not configured", async () => {
  const hasKeys = await hasAnyVirtualKeys();
  assert.equal(hasKeys, false);
});
