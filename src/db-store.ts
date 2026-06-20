import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./paths.js";
import type { Config } from "./types.js";
import { validateConfig } from "./validators.js";
import { applyConfigDefaults } from "./account-store.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let cachedConfig: Config | null = null;
let cachedAdminToken: string | null = null;
let isInitialized = false;

export function isDbConfigured(): boolean {
	return !!(process.env.PI_ROTATOR_DATABASE_URL || process.env.DATABASE_URL);
}

export async function initDb(): Promise<void> {
	if (!isDbConfigured()) return;
	if (isInitialized) return;

	const connectionString = process.env.PI_ROTATOR_DATABASE_URL || process.env.DATABASE_URL;
	pool = new Pool({
		connectionString,
		ssl: connectionString?.includes("sslmode=require") || connectionString?.includes("ssl=") ? { rejectUnauthorized: false } : undefined,
	});

	// Create table if it doesn't exist
	await pool.query(`
		CREATE TABLE IF NOT EXISTS rotator_settings (
			key VARCHAR(255) PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Load Accounts Config
	const accountsRes = await pool.query("SELECT value FROM rotator_settings WHERE key = $1", ["accounts_json"]);
	if (accountsRes.rows.length > 0) {
		try {
			const parsed = JSON.parse(accountsRes.rows[0].value);
			const validation = validateConfig(parsed);
			if (validation.ok && validation.value) {
				cachedConfig = applyConfigDefaults(validation.value);
			}
		} catch (err) {
			console.error(`Failed to parse accounts config from database: ${err}`);
		}
	}

	// If not found in DB, try to migrate from disk
	if (!cachedConfig) {
		const diskPath = join(getConfigDir(), "accounts.json");
		if (existsSync(diskPath)) {
			try {
				const content = readFileSync(diskPath, "utf-8");
				const parsed = JSON.parse(content);
				const validation = validateConfig(parsed);
				if (validation.ok && validation.value) {
					cachedConfig = applyConfigDefaults(validation.value);
					// Save to DB for future use
					await pool.query(`
						INSERT INTO rotator_settings (key, value, updated_at)
						VALUES ($1, $2, CURRENT_TIMESTAMP)
						ON CONFLICT (key) DO UPDATE
						SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
					`, ["accounts_json", content]);
					console.log("Migrated accounts.json from disk to database");
				}
			} catch (err) {
				console.error(`Failed to migrate accounts.json from disk: ${err}`);
			}
		}
	}

	// Load Admin Token
	const tokenRes = await pool.query("SELECT value FROM rotator_settings WHERE key = $1", ["admin_token"]);
	if (tokenRes.rows.length > 0) {
		cachedAdminToken = tokenRes.rows[0].value.trim();
	}

	// If not found in DB, try to migrate from disk
	if (!cachedAdminToken) {
		const diskTokenPath = join(getConfigDir(), ".admin-token");
		if (existsSync(diskTokenPath)) {
			try {
				const content = readFileSync(diskTokenPath, "utf-8").trim();
				if (content) {
					cachedAdminToken = content;
					// Save to DB
					await pool.query(`
						INSERT INTO rotator_settings (key, value, updated_at)
						VALUES ($1, $2, CURRENT_TIMESTAMP)
						ON CONFLICT (key) DO UPDATE
						SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
					`, ["admin_token", content]);
					console.log("Migrated .admin-token from disk to database");
				}
			} catch (err) {
				console.error(`Failed to migrate .admin-token from disk: ${err}`);
			}
		}
	}

	isInitialized = true;
}

export function getCachedConfig(): Config | null {
	return cachedConfig;
}

export function setCachedConfig(config: Config): void {
	cachedConfig = applyConfigDefaults(config);
	if (isDbConfigured() && pool) {
		// Non-blocking background save to DB
		pool.query(`
			INSERT INTO rotator_settings (key, value, updated_at)
			VALUES ($1, $2, CURRENT_TIMESTAMP)
			ON CONFLICT (key) DO UPDATE
			SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
		`, ["accounts_json", JSON.stringify(cachedConfig, null, 2)]).catch((err) => {
			console.error(`Failed to save accounts config to database in background: ${err}`);
		});
	}
}

export function getCachedAdminToken(): string | null {
	return cachedAdminToken;
}

export function setCachedAdminToken(token: string): void {
	cachedAdminToken = token.trim();
	if (isDbConfigured() && pool) {
		// Non-blocking background save to DB
		pool.query(`
			INSERT INTO rotator_settings (key, value, updated_at)
			VALUES ($1, $2, CURRENT_TIMESTAMP)
			ON CONFLICT (key) DO UPDATE
			SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
		`, ["admin_token", cachedAdminToken]).catch((err) => {
			console.error(`Failed to save admin token to database in background: ${err}`);
		});
	}
}

export async function closeDb(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
	isInitialized = false;
}
