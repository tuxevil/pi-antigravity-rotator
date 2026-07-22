import randomBytes from "node:crypto";
import type { SpendLog, DailySpend } from "./types.js";
import { isDbConfigured, queryDb } from "./db-store.js";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE_SIZE = 50;
const DEFAULT_KEY_HASH_LABEL = "unauthenticated";

const storeMessagesConfig =
  process.env.PI_ROTATOR_LOG_MESSAGES !== "false" &&
  process.env.PI_ROTATOR_LOG_MESSAGES !== "0";

const storeResponsesConfig =
  process.env.PI_ROTATOR_LOG_RESPONSES !== "false" &&
  process.env.PI_ROTATOR_LOG_RESPONSES !== "0";

let queue: SpendLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let isFlushing = false;

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomBytes.randomBytes(8).toString("hex")}`;
}

/**
 * Enqueue a request log for async DB persistence & aggregation.
 */
export function logSpend(
  log: Omit<SpendLog, "requestId" | "totalTokens"> & {
    requestId?: string;
    totalTokens?: number;
  },
): void {
  const fullLog: SpendLog = {
    requestId: log.requestId || generateRequestId(),
    apiKeyHash: log.apiKeyHash || null,
    model: log.model,
    accountEmail: log.accountEmail || null,
    callType: log.callType,
    status: log.status,
    promptTokens: Math.max(0, log.promptTokens || 0),
    completionTokens: Math.max(0, log.completionTokens || 0),
    totalTokens: Math.max(
      0,
      log.totalTokens || (log.promptTokens || 0) + (log.completionTokens || 0),
    ),
    startTime: log.startTime,
    endTime: log.endTime,
    ttfbMs: log.ttfbMs ?? null,
    durationMs: Math.max(0, log.durationMs || 0),
    requestMessages: storeMessagesConfig ? sanitizePayload(log.requestMessages) : null,
    responseContent: storeResponsesConfig ? sanitizePayload(log.responseContent) : null,
    metadata: log.metadata || {},
    requesterIp: log.requesterIp || null,
    createdAt: new Date().toISOString(),
  };

  queue.push(fullLog);

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushSpendLogs();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushSpendLogs();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function sanitizePayload(payload: unknown): unknown {
  if (!payload) return null;
  try {
    const str = JSON.stringify(payload);
    // Truncate payloads larger than 256KB to avoid exhausting database disk space
    if (str.length > 256 * 1024) {
      return { _truncated: true, preview: str.slice(0, 1000) + "..." };
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Flush accumulated spend logs to database.
 */
export async function flushSpendLogs(): Promise<void> {
  if (isFlushing || queue.length === 0 || !isDbConfigured()) return;
  isFlushing = true;

  const logsToFlush = queue;
  queue = [];

  try {
    for (const log of logsToFlush) {
      // 1. Insert detailed spend log
      await queryDb(
        `INSERT INTO rotator_spend_logs (
          request_id, api_key_hash, model, account_email, call_type, status,
          prompt_tokens, completion_tokens, total_tokens, start_time, end_time,
          ttfb_ms, duration_ms, request_messages, response_content, metadata,
          requester_ip, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (request_id) DO NOTHING`,
        [
          log.requestId,
          log.apiKeyHash,
          log.model,
          log.accountEmail,
          log.callType,
          log.status,
          log.promptTokens,
          log.completionTokens,
          log.totalTokens,
          log.startTime,
          log.endTime,
          log.ttfbMs,
          log.durationMs,
          log.requestMessages ? JSON.stringify(log.requestMessages) : null,
          log.responseContent ? JSON.stringify(log.responseContent) : null,
          JSON.stringify(log.metadata || {}),
          log.requesterIp,
          log.createdAt || new Date().toISOString(),
        ],
      );

      // 2. Upsert daily aggregation
      const dateStr = log.startTime.slice(0, 10); // YYYY-MM-DD
      const keyHashForDaily = log.apiKeyHash || DEFAULT_KEY_HASH_LABEL;
      const isSuccess = log.status === "success" ? 1 : 0;
      const isFail = log.status === "failure" ? 1 : 0;

      await queryDb(
        `INSERT INTO rotator_daily_spend (
          api_key_hash, model, date, prompt_tokens, completion_tokens,
          total_requests, successful_requests, failed_requests, total_duration_ms
        ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
        ON CONFLICT (api_key_hash, model, date) DO UPDATE SET
          prompt_tokens = rotator_daily_spend.prompt_tokens + EXCLUDED.prompt_tokens,
          completion_tokens = rotator_daily_spend.completion_tokens + EXCLUDED.completion_tokens,
          total_requests = rotator_daily_spend.total_requests + 1,
          successful_requests = rotator_daily_spend.successful_requests + EXCLUDED.successful_requests,
          failed_requests = rotator_daily_spend.failed_requests + EXCLUDED.failed_requests,
          total_duration_ms = rotator_daily_spend.total_duration_ms + EXCLUDED.total_duration_ms`,
        [
          keyHashForDaily,
          log.model,
          dateStr,
          log.promptTokens,
          log.completionTokens,
          isSuccess,
          isFail,
          log.durationMs,
        ],
      );
    }
  } catch (err) {
    console.error("Failed to flush spend logs to database:", err);
    // Put unfetched items back in queue if flush failed
    queue = [...logsToFlush, ...queue];
  } finally {
    isFlushing = false;
  }
}

// ── Dashboard Query API Functions ────────────────────────────────────

export interface GetSpendLogsOptions {
  apiKeyHash?: string;
  model?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function getSpendLogs(
  options: GetSpendLogsOptions = {},
): Promise<{ logs: SpendLog[]; total: number }> {
  if (!isDbConfigured()) return { logs: [], total: 0 };

  const limit = Math.min(100, Math.max(1, options.limit || 50));
  const offset = Math.max(0, options.offset || 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.apiKeyHash) {
    params.push(options.apiKeyHash);
    conditions.push(`api_key_hash = $${params.length}`);
  }
  if (options.model) {
    params.push(options.model);
    conditions.push(`model = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const countRes = await queryDb<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM rotator_spend_logs ${whereClause}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count || "0", 10);

    const queryParams = [...params, limit, offset];
    const logsRes = await queryDb(
      `SELECT * FROM rotator_spend_logs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams,
    );

    const logs: SpendLog[] = logsRes.rows.map((row) => ({
      requestId: String(row.request_id),
      apiKeyHash: row.api_key_hash ? String(row.api_key_hash) : null,
      model: String(row.model),
      accountEmail: row.account_email ? String(row.account_email) : null,
      callType: String(row.call_type),
      status: (row.status as "success" | "failure") || "success",
      promptTokens: Number(row.prompt_tokens || 0),
      completionTokens: Number(row.completion_tokens || 0),
      totalTokens: Number(row.total_tokens || 0),
      startTime: new Date(row.start_time as string | Date).toISOString(),
      endTime: new Date(row.end_time as string | Date).toISOString(),
      ttfbMs: row.ttfb_ms !== null ? Number(row.ttfb_ms) : null,
      durationMs: Number(row.duration_ms || 0),
      requestMessages: row.request_messages || null,
      responseContent: row.response_content || null,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {},
      requesterIp: row.requester_ip ? String(row.requester_ip) : null,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));

    return { logs, total };
  } catch (err) {
    console.error("Failed to query spend logs:", err);
    return { logs: [], total: 0 };
  }
}

export async function getDailySpendSummary(options: {
  apiKeyHash?: string;
  startDate?: string;
  endDate?: string;
}): Promise<DailySpend[]> {
  if (!isDbConfigured()) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.apiKeyHash) {
    params.push(options.apiKeyHash);
    conditions.push(`api_key_hash = $${params.length}`);
  }
  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`date >= $${params.length}::date`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`date <= $${params.length}::date`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const res = await queryDb(
      `SELECT * FROM rotator_daily_spend ${whereClause} ORDER BY date DESC, total_requests DESC`,
      params,
    );

    return res.rows.map((row) => ({
      apiKeyHash: row.api_key_hash ? String(row.api_key_hash) : null,
      model: String(row.model),
      date: new Date(row.date as string | Date).toISOString().slice(0, 10),
      promptTokens: Number(row.prompt_tokens || 0),
      completionTokens: Number(row.completion_tokens || 0),
      totalRequests: Number(row.total_requests || 0),
      successfulRequests: Number(row.successful_requests || 0),
      failedRequests: Number(row.failed_requests || 0),
      totalDurationMs: Number(row.total_duration_ms || 0),
    }));
  } catch (err) {
    console.error("Failed to get daily spend summary:", err);
    return [];
  }
}

// ── Spend by Key Aggregation ────────────────────────────────────────

export interface SpendByKey {
  apiKeyHash: string;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationMs: number;
  avgDurationMs: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export async function getSpendByKey(options: {
  startDate?: string;
  endDate?: string;
}): Promise<SpendByKey[]> {
  if (!isDbConfigured()) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`date >= $${params.length}::date`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`date <= $${params.length}::date`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const res = await queryDb(
      `SELECT
        api_key_hash,
        SUM(total_requests)::int as total_requests,
        SUM(prompt_tokens)::bigint as total_prompt_tokens,
        SUM(completion_tokens)::bigint as total_completion_tokens,
        SUM(total_duration_ms)::bigint as total_duration_ms,
        SUM(total_duration_ms)::float / NULLIF(SUM(total_requests), 0) as avg_duration_ms
      FROM rotator_daily_spend
      ${whereClause}
      GROUP BY api_key_hash
      ORDER BY total_prompt_tokens + total_completion_tokens DESC`,
      params,
    );

    const keyHashes = res.rows.map((r) => String(r.api_key_hash));
    const lastSeenRes =
      keyHashes.length > 0
        ? await queryDb(
            `SELECT api_key_hash, MIN(created_at) as first_seen, MAX(created_at) as last_seen
             FROM rotator_spend_logs
             WHERE api_key_hash = ANY($1::text[])
             GROUP BY api_key_hash`,
            [keyHashes],
          )
        : { rows: [] as Array<Record<string, unknown>> };

    const firstLastMap = new Map<string, { firstSeen: string | null; lastSeen: string | null }>();
    for (const row of lastSeenRes.rows) {
      firstLastMap.set(String(row.api_key_hash), {
        firstSeen: row.first_seen ? new Date(row.first_seen as string).toISOString() : null,
        lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
      });
    }

    return res.rows.map((row) => {
      const hash = String(row.api_key_hash);
      const fl = firstLastMap.get(hash) || { firstSeen: null, lastSeen: null };
      return {
        apiKeyHash: hash,
        totalRequests: Number(row.total_requests || 0),
        totalPromptTokens: Number(row.total_prompt_tokens || 0),
        totalCompletionTokens: Number(row.total_completion_tokens || 0),
        totalDurationMs: Number(row.total_duration_ms || 0),
        avgDurationMs: Number(row.avg_duration_ms || 0),
        firstSeen: fl.firstSeen,
        lastSeen: fl.lastSeen,
      };
    });
  } catch (err) {
    console.error("Failed to get spend by key:", err);
    return [];
  }
}

// ── Retention Policy ─────────────────────────────────────────────────

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DAILY_RETENTION_DAYS = 90;
const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setTimeout> | null = null;

function getLogRetentionDays(): number {
  const env = process.env.PI_ROTATOR_LOG_RETENTION_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_LOG_RETENTION_DAYS;
}

async function runRetentionCleanup(): Promise<void> {
  if (!isDbConfigured()) return;

  const logDays = getLogRetentionDays();

  try {
    const logRes = await queryDb<{ deleted: string }>(
      `WITH deleted AS (
        DELETE FROM rotator_spend_logs WHERE created_at < NOW() - ($1 || ' days')::interval
        RETURNING request_id
      )
      SELECT COUNT(*)::text as deleted FROM deleted`,
      [String(logDays)],
    );
    const dailyRes = await queryDb<{ deleted: string }>(
      `WITH deleted AS (
        DELETE FROM rotator_daily_spend WHERE date < CURRENT_DATE - ($1 || ' days')::interval
        RETURNING id
      )
      SELECT COUNT(*)::text as deleted FROM deleted`,
      [String(DAILY_RETENTION_DAYS)],
    );

    const logDeleted = parseInt(logRes.rows[0]?.deleted || "0", 10);
    const dailyDeleted = parseInt(dailyRes.rows[0]?.deleted || "0", 10);

    if (logDeleted > 0 || dailyDeleted > 0) {
      console.log(
        `[retention] Cleaned ${logDeleted} spend logs (${logDays}d policy) and ${dailyDeleted} daily aggregates (${DAILY_RETENTION_DAYS}d policy)`,
      );
    }
  } catch (err) {
    console.error("Retention cleanup failed:", err);
  }
}

export function startRetentionCleanup(): void {
  void runRetentionCleanup();
  retentionTimer = setInterval(() => {
    void runRetentionCleanup();
  }, RETENTION_CHECK_INTERVAL_MS);
  retentionTimer.unref();
}

export function stopRetentionCleanup(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
