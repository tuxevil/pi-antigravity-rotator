import { isDbConfigured, queryDb } from "./db-store.js";

/**
 * Runs database migrations for virtual keys, spend logs, and daily spend aggregation tables.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */
export async function runKeyMigrations(): Promise<void> {
  if (!isDbConfigured()) return;

  try {
    // 1. Virtual keys table
    await queryDb(`
      CREATE TABLE IF NOT EXISTS rotator_virtual_keys (
        token_hash      VARCHAR(64) PRIMARY KEY,
        key_name        VARCHAR(255) NOT NULL,
        key_alias       VARCHAR(255) NOT NULL,
        user_id         VARCHAR(255),
        models          TEXT[],
        metadata        JSONB DEFAULT '{}',
        blocked         BOOLEAN DEFAULT FALSE,
        last_active     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        created_by      VARCHAR(255)
      );
    `);

    // 2. Spend logs table
    await queryDb(`
      CREATE TABLE IF NOT EXISTS rotator_spend_logs (
        request_id          VARCHAR(64) PRIMARY KEY,
        api_key_hash        VARCHAR(64),
        model               VARCHAR(255) NOT NULL,
        account_email       VARCHAR(255),
        call_type           VARCHAR(50) NOT NULL,
        status              VARCHAR(20) NOT NULL,
        prompt_tokens       INTEGER DEFAULT 0,
        completion_tokens   INTEGER DEFAULT 0,
        total_tokens        INTEGER DEFAULT 0,
        start_time          TIMESTAMPTZ NOT NULL,
        end_time            TIMESTAMPTZ NOT NULL,
        ttfb_ms             INTEGER,
        duration_ms         INTEGER NOT NULL,
        request_messages    JSONB,
        response_content    JSONB,
        metadata            JSONB DEFAULT '{}',
        requester_ip        VARCHAR(45),
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await queryDb(
      `CREATE INDEX IF NOT EXISTS idx_spend_logs_key ON rotator_spend_logs(api_key_hash);`,
    );
    await queryDb(
      `CREATE INDEX IF NOT EXISTS idx_spend_logs_time ON rotator_spend_logs(created_at);`,
    );
    await queryDb(
      `CREATE INDEX IF NOT EXISTS idx_spend_logs_model ON rotator_spend_logs(model);`,
    );

    // 3. Daily spend aggregation table
    await queryDb(`
      CREATE TABLE IF NOT EXISTS rotator_daily_spend (
        id                  SERIAL PRIMARY KEY,
        api_key_hash        VARCHAR(64),
        model               VARCHAR(255) NOT NULL,
        date                DATE NOT NULL,
        prompt_tokens       BIGINT DEFAULT 0,
        completion_tokens   BIGINT DEFAULT 0,
        total_requests      INTEGER DEFAULT 0,
        successful_requests INTEGER DEFAULT 0,
        failed_requests     INTEGER DEFAULT 0,
        total_duration_ms   BIGINT DEFAULT 0,
        UNIQUE(api_key_hash, model, date)
      );
    `);
    await queryDb(
      `CREATE INDEX IF NOT EXISTS idx_daily_spend_key_date ON rotator_daily_spend(api_key_hash, date);`,
    );
  } catch (err) {
    console.error("Failed to run virtual key & spend log migrations:", err);
    throw err;
  }
}
