import createHash from "node:crypto";
import randomBytes from "node:crypto";
import type { VirtualKey } from "./types.js";
import { isDbConfigured, queryDb } from "./db-store.js";

const KEY_PREFIX = "rk-";
const CACHE_TTL_MS = 60_000; // 1 minute in-memory cache

interface CachedKey {
  key: VirtualKey | null;
  fetchedAt: number;
}

const keyCache = new Map<string, CachedKey>(); // tokenHash -> CachedKey
let hasKeysCache: { value: boolean; fetchedAt: number } | null = null;

// Debounced last_active updates to prevent DB write spam
const pendingLastActive = new Set<string>();
let lastActiveFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function hashKey(rawKey: string): string {
  // codeql [js/insufficient-password-hash] - High-entropy 256-bit API token hash (not user password)
  return createHash.createHash("sha256").update(rawKey.trim()).digest("hex");
}

export function maskKey(rawKey: string): string {
  if (rawKey.length <= 10) return `${rawKey.slice(0, 4)}...`;
  return `${rawKey.slice(0, 6)}...${rawKey.slice(-4)}`;
}

function mapRowToVirtualKey(row: Record<string, unknown>): VirtualKey {
  return {
    tokenHash: String(row.token_hash),
    keyName: String(row.key_name),
    keyAlias: String(row.key_alias),
    userId: row.user_id ? String(row.user_id) : null,
    models: Array.isArray(row.models) ? (row.models as string[]) : [],
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    blocked: Boolean(row.blocked),
    lastActive: row.last_active
      ? new Date(row.last_active as string | number | Date).toISOString()
      : null,
    createdAt: new Date(
      row.created_at as string | number | Date,
    ).toISOString(),
    createdBy: row.created_by ? String(row.created_by) : null,
  };
}

export function clearVirtualKeyCache(): void {
  keyCache.clear();
  hasKeysCache = null;
}

/**
 * Checks whether any virtual keys exist in DB. Cache for 10 seconds.
 */
export async function hasAnyVirtualKeys(): Promise<boolean> {
  if (!isDbConfigured()) return false;

  const now = Date.now();
  if (hasKeysCache && now - hasKeysCache.fetchedAt < 10_000) {
    return hasKeysCache.value;
  }

  try {
    const res = await queryDb<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM rotator_virtual_keys",
    );
    const count = parseInt(res.rows[0]?.count || "0", 10);
    const exists = count > 0;
    hasKeysCache = { value: exists, fetchedAt: now };
    return exists;
  } catch (err) {
    console.error("Failed to check virtual keys count:", err);
    return false;
  }
}

/**
 * Generate a new virtual key (format: rk-{32 random hex chars}).
 * Returns raw key (shown only once to caller) and the stored VirtualKey object.
 */
export async function generateVirtualKey(params: {
  alias: string;
  userId?: string;
  models?: string[];
  metadata?: Record<string, unknown>;
  createdBy?: string;
}): Promise<{ rawKey: string; key: VirtualKey }> {
  if (!isDbConfigured()) {
    throw new Error(
      "Virtual keys require PostgreSQL database (PI_ROTATOR_DATABASE_URL)",
    );
  }

  const randomHex = randomBytes.randomBytes(16).toString("hex");
  const rawKey = `${KEY_PREFIX}${randomHex}`;
  const tokenHash = hashKey(rawKey);
  const keyName = maskKey(rawKey);

  const res = await queryDb(
    `INSERT INTO rotator_virtual_keys
      (token_hash, key_name, key_alias, user_id, models, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      tokenHash,
      keyName,
      params.alias,
      params.userId || null,
      params.models && params.models.length > 0 ? params.models : [],
      JSON.stringify(params.metadata || {}),
      params.createdBy || "admin",
    ],
  );

  const key = mapRowToVirtualKey(res.rows[0]);
  keyCache.set(tokenHash, { key, fetchedAt: Date.now() });
  hasKeysCache = { value: true, fetchedAt: Date.now() };

  return { rawKey, key };
}

/**
 * Look up a key by its raw value (e.g. "rk-a1b2...").
 */
export async function lookupVirtualKey(
  rawKey: string,
): Promise<VirtualKey | null> {
  if (!isDbConfigured() || !rawKey || !rawKey.startsWith(KEY_PREFIX)) {
    return null;
  }

  const tokenHash = hashKey(rawKey);
  const now = Date.now();
  const cached = keyCache.get(tokenHash);

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.key;
  }

  try {
    const res = await queryDb(
      "SELECT * FROM rotator_virtual_keys WHERE token_hash = $1",
      [tokenHash],
    );
    if (res.rows.length === 0) {
      keyCache.set(tokenHash, { key: null, fetchedAt: now });
      return null;
    }

    const key = mapRowToVirtualKey(res.rows[0]);
    keyCache.set(tokenHash, { key, fetchedAt: now });
    return key;
  } catch (err) {
    console.error("Failed to lookup virtual key:", err);
    return null;
  }
}

/**
 * List all virtual keys ordered by created_at DESC.
 */
export async function listVirtualKeys(): Promise<VirtualKey[]> {
  if (!isDbConfigured()) return [];

  try {
    const res = await queryDb(
      "SELECT * FROM rotator_virtual_keys ORDER BY created_at DESC",
    );
    return res.rows.map(mapRowToVirtualKey);
  } catch (err) {
    console.error("Failed to list virtual keys:", err);
    return [];
  }
}

/**
 * Get a virtual key by token hash.
 */
export async function getVirtualKeyByHash(
  tokenHash: string,
): Promise<VirtualKey | null> {
  if (!isDbConfigured()) return null;

  try {
    const res = await queryDb(
      "SELECT * FROM rotator_virtual_keys WHERE token_hash = $1",
      [tokenHash],
    );
    if (res.rows.length === 0) return null;
    return mapRowToVirtualKey(res.rows[0]);
  } catch (err) {
    console.error("Failed to get virtual key by hash:", err);
    return null;
  }
}

/**
 * Update alias, models, blocked status, or metadata of a key.
 */
export async function updateVirtualKey(
  tokenHash: string,
  updates: {
    alias?: string;
    models?: string[];
    blocked?: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<VirtualKey | null> {
  if (!isDbConfigured()) return null;

  const current = await getVirtualKeyByHash(tokenHash);
  if (!current) return null;

  const newAlias = updates.alias !== undefined ? updates.alias : current.keyAlias;
  const newModels =
    updates.models !== undefined ? updates.models : current.models;
  const newBlocked =
    updates.blocked !== undefined ? updates.blocked : current.blocked;
  const newMetadata =
    updates.metadata !== undefined
      ? JSON.stringify(updates.metadata)
      : JSON.stringify(current.metadata || {});

  try {
    const res = await queryDb(
      `UPDATE rotator_virtual_keys
       SET key_alias = $1, models = $2, blocked = $3, metadata = $4
       WHERE token_hash = $5
       RETURNING *`,
      [newAlias, newModels, newBlocked, newMetadata, tokenHash],
    );
    if (res.rows.length === 0) return null;

    const updated = mapRowToVirtualKey(res.rows[0]);
    keyCache.set(tokenHash, { key: updated, fetchedAt: Date.now() });
    return updated;
  } catch (err) {
    console.error("Failed to update virtual key:", err);
    return null;
  }
}

/**
 * Delete a virtual key by hash.
 */
export async function deleteVirtualKey(tokenHash: string): Promise<boolean> {
  if (!isDbConfigured()) return false;

  try {
    const res = await queryDb(
      "DELETE FROM rotator_virtual_keys WHERE token_hash = $1",
      [tokenHash],
    );
    keyCache.delete(tokenHash);
    hasKeysCache = null;
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("Failed to delete virtual key:", err);
    return false;
  }
}

/**
 * Debounced background update of last_active timestamp for a key.
 */
export function touchVirtualKeyLastActive(tokenHash: string): void {
  if (!isDbConfigured()) return;
  pendingLastActive.add(tokenHash);

  if (!lastActiveFlushTimer) {
    lastActiveFlushTimer = setTimeout(() => {
      lastActiveFlushTimer = null;
      void flushLastActive();
    }, 10_000);
    lastActiveFlushTimer.unref();
  }
}

async function flushLastActive(): Promise<void> {
  if (pendingLastActive.size === 0) return;
  const hashes = Array.from(pendingLastActive);
  pendingLastActive.clear();

  try {
    await queryDb(
      `UPDATE rotator_virtual_keys
       SET last_active = NOW()
       WHERE token_hash = ANY($1::text[])`,
      [hashes],
    );
  } catch (err) {
    console.error("Failed to update virtual key last_active:", err);
  }
}
