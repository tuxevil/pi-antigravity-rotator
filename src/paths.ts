// Config directory resolution
// Default: ~/.pi-antigravity-rotator/
// Override: --config-dir <path> or PI_ROTATOR_DIR env var

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DEFAULT_DIR = join(homedir(), ".pi-antigravity-rotator");

let configDir: string | null = null;

export function getConfigDir(): string {
	if (configDir) return configDir;

	// Check CLI arg
	const idx = process.argv.indexOf("--config-dir");
	if (idx !== -1 && process.argv[idx + 1]) {
		configDir = process.argv[idx + 1];
	} else if (process.env.PI_ROTATOR_DIR) {
		configDir = process.env.PI_ROTATOR_DIR;
	} else {
		configDir = DEFAULT_DIR;
	}

	mkdirSync(configDir, { recursive: true });
	return configDir;
}

export function getAccountsPath(): string {
	return join(getConfigDir(), "accounts.json");
}

export function getStatePath(): string {
	return join(getConfigDir(), "state.json");
}

export function getTokenUsagePath(): string {
	return join(getConfigDir(), "token-usage.json");
}
