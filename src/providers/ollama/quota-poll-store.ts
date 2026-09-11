// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.
// Persistent store of raw quota-poll observations.
//
// Every `GET /api/usage` poll returns each pool's usage as a fraction
// (0..1) with 3-decimal precision, plus per-model request counts inside
// that window. The rotator rounds these to whole percents for routing;
// this store keeps the raw values so operators can correlate tokens
// (from `rotator_spend_logs`) against usage fractions over time and
// calibrate the real per-model monthly budget without burning
// quota (see docs/usage-calibration.md).
//
// Postgres-only, like spend logs: when no database is configured the
// store is a silent no-op.
//
// The table is created lazily on first write. A typical deployment
// current API produces ~1 row per account per poll (monthly), which at the
// default 5-minute poll interval is ~576 rows/account/day.

import { rotatorEnv } from "../../env.js";
import type { OllamaUsageResponse } from "./quota.js";
import { OLLAMA_QUOTA_POOL_KEY } from "../credential-helpers.js";

const RETENTION_DEFAULT_DAYS = 14;

let schemaReady: Promise<void> | null = null;

export interface QuotaPollRecord {
  accountEmail: string;
  polledAt: string;
  pool: "monthly" | "session" | "weekly";
  usageRaw: number;
  percentRemaining: number;
  /** Per-model request counts observed inside this pool's window. */
  models?: Array<{ name: string; request_count?: number }>;
}

export function isQuotaPollStoreEnabled(): boolean {
  return !!(rotatorEnv("DATABASE_URL") || process.env.DATABASE_URL);
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const { queryDb } = await import("../../db-store.js");
      await queryDb(`
        CREATE TABLE IF NOT EXISTS rotator_quota_polls (
          id BIGSERIAL PRIMARY KEY,
          account_email TEXT NOT NULL,
          polled_at TIMESTAMP WITH TIME ZONE NOT NULL,
          pool VARCHAR(16) NOT NULL,
          usage_raw DOUBLE PRECISION NOT NULL,
          percent_remaining INTEGER NOT NULL,
          models_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_quota_polls_account_pool_time
          ON rotator_quota_polls (account_email, pool, polled_at);
      `);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/**
 * Persist one pool's raw observation from a usage poll. Fire-and-forget:
 * failures are logged and never surfaced to the polling loop.
 */
export async function recordQuotaPoll(record: QuotaPollRecord): Promise<void> {
  if (!isQuotaPollStoreEnabled()) return;
  try {
    await ensureSchema();
    const { queryDb } = await import("../../db-store.js");
    await queryDb(
      `INSERT INTO rotator_quota_polls
         (account_email, polled_at, pool, usage_raw, percent_remaining, models_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.accountEmail,
        record.polledAt,
        record.pool,
        record.usageRaw,
        record.percentRemaining,
        record.models && record.models.length > 0
          ? JSON.stringify(record.models)
          : null,
      ],
    );
  } catch (err) {
    console.error(`Failed to record quota poll for ${record.accountEmail}: ${err}`);
  }
}

/**
 * Persist the current monthly pool, or both legacy pools when talking to an
 * older `GET /api/usage` response. No-op when the response lacks the expected
 * shape.
 */
export async function recordUsagePoll(
  accountEmail: string,
  polledAt: string,
  data: OllamaUsageResponse,
): Promise<void> {
  const limits = data?.limits;
  if (!limits || typeof limits !== "object") return;

  const monthlyLimit = limits[OLLAMA_QUOTA_POOL_KEY];
  const pools: Array<"monthly" | "session" | "weekly"> =
    monthlyLimit && typeof monthlyLimit === "object"
      ? [OLLAMA_QUOTA_POOL_KEY]
      : ["session", "weekly"];

  for (const pool of pools) {
    const info = limits[pool] as
      | { usage?: number | string; models?: unknown[] }
      | undefined;
    if (!info || typeof info !== "object") continue;
    const usageRaw =
      typeof info.usage === "number"
        ? info.usage
        : typeof info.usage === "string"
          ? parseFloat(info.usage)
          : NaN;
    if (!Number.isFinite(usageRaw)) continue;

    const models = Array.isArray(info.models)
      ? (info.models.filter(
          (m): m is { name: string; request_count?: number } =>
          !!m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string",
        ))
      : undefined;

    await recordQuotaPoll({
      accountEmail,
      polledAt,
      pool,
      usageRaw,
      percentRemaining: Math.max(0, Math.min(100, Math.round((1 - usageRaw) * 100))),
      models,
    });
  }
}

/**
 * Delete polls older than `days`. Returns the number of rows removed.
 */
export async function pruneQuotaPolls(days: number = RETENTION_DEFAULT_DAYS): Promise<number> {
  if (!isQuotaPollStoreEnabled()) return 0;
  try {
    await ensureSchema();
    const { queryDb } = await import("../../db-store.js");
    const res = await queryDb<{ deleted: string }>(
      `WITH deleted AS (
         DELETE FROM rotator_quota_polls
         WHERE polled_at < NOW() - ($1 || ' days')::interval
         RETURNING id
       )
       SELECT COUNT(*)::text as deleted FROM deleted`,
      [String(days)],
    );
    return parseInt(res.rows[0]?.deleted || "0", 10);
  } catch (err) {
    console.error(`Failed to prune quota polls: ${err}`);
    return 0;
  }
}
