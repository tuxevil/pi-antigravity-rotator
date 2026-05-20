import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfiguredAdminToken } from "./admin-auth.js";
import { getAccountsPath, getConfigDir, getStatePath } from "./paths.js";
import { getTokenUsagePath, loadConfigFromDisk } from "./account-store.js";
import { listBackups, readJsonFile } from "./storage.js";
import type { PersistedState, TokenUsageTiered } from "./types.js";

function checkWritable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK | constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export interface DoctorResult {
	ok: boolean;
	warnings: string[];
	errors: string[];
	info: Record<string, unknown>;
}

export function runDoctor(env: NodeJS.ProcessEnv = process.env): DoctorResult {
	const warnings: string[] = [];
	const errors: string[] = [];
	const configDir = getConfigDir();
	const accountsPath = getAccountsPath();
	const statePath = getStatePath();
	const tokenUsagePath = getTokenUsagePath();

	if (!getConfiguredAdminToken(env)) {
		warnings.push("PI_ROTATOR_ADMIN_TOKEN is not configured; dashboard and /api/* remain open on the bound interface.");
	}

	if (!existsSync(configDir)) {
		errors.push(`Config directory missing: ${configDir}`);
	}
	if (!checkWritable(configDir)) {
		errors.push(`Config directory is not writable: ${configDir}`);
	}

	try {
		loadConfigFromDisk();
	} catch (err) {
		errors.push(`Config validation failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		if (existsSync(statePath)) readJsonFile<PersistedState>(statePath);
	} catch (err) {
		errors.push(`State file is corrupted: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		if (existsSync(tokenUsagePath)) readJsonFile<TokenUsageTiered>(tokenUsagePath);
	} catch (err) {
		errors.push(`Token usage file is corrupted: ${err instanceof Error ? err.message : String(err)}`);
	}

	return {
		ok: errors.length === 0,
		warnings,
		errors,
		info: {
			configDir,
			accountsPath,
			statePath,
			tokenUsagePath,
			backupCount: listBackups().length,
			firstBackup: listBackups()[0] ?? null,
			adminTokenConfigured: !!getConfiguredAdminToken(env),
			bindHost: env.PI_ROTATOR_BIND_HOST ?? null,
		},
	};
}

export function printDoctorReport(result: DoctorResult): void {
	console.log("Pi Antigravity Rotator Doctor");
	console.log();
	console.log(`Status: ${result.ok ? "OK" : "ERROR"}`);
	console.log();
	for (const [key, value] of Object.entries(result.info)) {
		console.log(`${key}: ${typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : JSON.stringify(value)}`);
	}
	if (result.warnings.length > 0) {
		console.log();
		console.log("Warnings:");
		for (const warning of result.warnings) console.log(`- ${warning}`);
	}
	if (result.errors.length > 0) {
		console.log();
		console.log("Errors:");
		for (const error of result.errors) console.log(`- ${error}`);
	}
}
