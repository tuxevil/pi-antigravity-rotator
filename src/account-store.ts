import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAccountsPath } from "./paths.js";
import type { AccountConfig, Config } from "./types.js";

const ACCOUNTS_FILE = getAccountsPath();
const PI_DIR = join(homedir(), ".pi", "agent");
const PI_MODELS_FILE = join(PI_DIR, "models.json");
const PI_AUTH_FILE = join(PI_DIR, "auth.json");

export function loadOrCreateAccountsConfig(): Config {
	if (existsSync(ACCOUNTS_FILE)) {
		try {
			return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8")) as Config;
		} catch {
			// Corrupted, start fresh
		}
	}
	return {
		proxyPort: 51200,
		requestsPerRotation: 5,
		rotateOnQuotaDrop: 20,
		quotaPollIntervalMs: 300000,
		maxConcurrentRequestsPerAccount: 1,
		protectivePauseMs: 21600000,
		useRequestCountRotationWhenQuotaUnknownOnly: true,
		accounts: [],
	};
}

export function saveAccountsConfig(config: Config): void {
	writeFileSync(ACCOUNTS_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addAccountToConfig(entry: AccountConfig): { isNew: boolean } {
	const config = loadOrCreateAccountsConfig();
	const existing = config.accounts.findIndex((a) => a.email === entry.email);

	if (existing >= 0) {
		config.accounts[existing] = { ...config.accounts[existing], ...entry };
		saveAccountsConfig(config);
		return { isNew: false };
	}

	config.accounts.push(entry);
	saveAccountsConfig(config);
	return { isNew: true };
}

export function ensurePiModelsConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let models: Record<string, unknown> = {};
	if (existsSync(PI_MODELS_FILE)) {
		try {
			models = JSON.parse(readFileSync(PI_MODELS_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	const providers = (models.providers || {}) as Record<string, Record<string, unknown>>;
	const antigravity = providers["google-antigravity"] || {};

	if (antigravity.baseUrl === "http://localhost:51200") {
		return;
	}

	antigravity.baseUrl = "http://localhost:51200";
	providers["google-antigravity"] = antigravity;
	models.providers = providers;

	writeFileSync(PI_MODELS_FILE, JSON.stringify(models, null, 2) + "\n", "utf-8");
	console.log(`  Updated ${PI_MODELS_FILE}`);
}

export function ensurePiAuthConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let auth: Record<string, unknown> = {};
	if (existsSync(PI_AUTH_FILE)) {
		try {
			auth = JSON.parse(readFileSync(PI_AUTH_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	const existing = auth["google-antigravity"] as Record<string, unknown> | undefined;
	if (existing?.type === "oauth" && existing?.refresh === "proxy-managed") {
		return;
	}

	auth["google-antigravity"] = {
		type: "oauth",
		refresh: "proxy-managed",
		access: "proxy-managed",
		expires: 32503680000000,
		projectId: "proxy-managed",
	};

	writeFileSync(PI_AUTH_FILE, JSON.stringify(auth, null, 2) + "\n", "utf-8");
	console.log(`  Updated ${PI_AUTH_FILE}`);
}
