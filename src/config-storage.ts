import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAccountsPath } from "./paths.js";
import type { Config } from "./types.js";
import { backupFile, readJsonFile, writeJsonFileAtomic } from "./storage.js";
import { formatValidationErrors, validateConfig } from "./validators.js";
import { isDbConfigured, getCachedConfig, setCachedConfig } from "./db-store.js";
import { applyConfigDefaults, getDefaultConfig } from "./config-defaults.js";

const ACCOUNTS_FILE = getAccountsPath();

export function loadConfigFromDisk(): Config {
	if (isDbConfigured()) {
		const cached = getCachedConfig();
		if (cached) return cached;
	}
	const parsed = readJsonFile<unknown>(ACCOUNTS_FILE);
	if (parsed === null) return getDefaultConfig();
	const validation = validateConfig(parsed);
	if (!validation.ok || !validation.value) {
		throw new Error(formatValidationErrors(validation.errors));
	}
	return applyConfigDefaults(validation.value);
}

export function loadOrCreateAccountsConfig(): Config {
	try {
		return loadConfigFromDisk();
	} catch {
		return getDefaultConfig();
	}
}

export function saveAccountsConfig(config: Config): void {
	if (isDbConfigured()) {
		setCachedConfig(config);
		return;
	}
	backupFile(ACCOUNTS_FILE, "accounts");
	writeJsonFileAtomic(ACCOUNTS_FILE, applyConfigDefaults(config));
}
