// Entry point - loads config and starts the proxy

import { readFileSync, existsSync } from "node:fs";
import type { Config } from "./types.js";
import { AccountRotator } from "./rotator.js";
import { startProxy } from "./proxy.js";
import { getAccountsPath } from "./paths.js";
import { formatValidationErrors, validateConfig } from "./validators.js";

function loadConfig(): Config {
	const configPath = getAccountsPath();
	if (!existsSync(configPath)) {
		console.error(`Config not found: ${configPath}`);
		console.error("Run 'pi-antigravity-rotator login' to add your first account.");
		process.exit(1);
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const validation = validateConfig(parsed);
		if (!validation.ok || !validation.value) {
			console.error(`Invalid config ${configPath}: ${formatValidationErrors(validation.errors)}`);
			process.exit(1);
		}
		const config: Config = validation.value;

		if (!config.accounts || config.accounts.length === 0) {
			console.error("No accounts configured. Run 'pi-antigravity-rotator login' to add one.");
			process.exit(1);
		}

		// Set defaults
		config.proxyPort = config.proxyPort || 51200;
		config.requestsPerRotation = config.requestsPerRotation || 5;
		config.rotateOnQuotaDrop = config.rotateOnQuotaDrop ?? 20;
		config.quotaPollIntervalMs = config.quotaPollIntervalMs || 300_000;
		config.maxConcurrentRequestsPerAccount = config.maxConcurrentRequestsPerAccount ?? 1;
		config.protectivePauseMs = config.protectivePauseMs ?? 6 * 60 * 60 * 1000;
		config.useRequestCountRotationWhenQuotaUnknownOnly =
			config.useRequestCountRotationWhenQuotaUnknownOnly ?? true;

		return config;
	} catch (err) {
		console.error(`Failed to parse ${configPath}: ${err}`);
		process.exit(1);
	}
}

export function main(): void {
	console.log("=== Pi Antigravity Rotator ===");
	console.log();

	const config = loadConfig();
	console.log(`Loaded ${config.accounts.length} accounts`);
	console.log(`Rotation: ${config.requestsPerRotation} requests / ${config.rotateOnQuotaDrop}% quota drop`);
	console.log(`Quota poll: every ${Math.round((config.quotaPollIntervalMs || 300000) / 1000)}s`);
	console.log(`Concurrency cap: ${config.maxConcurrentRequestsPerAccount} request/account`);
	console.log(`Protective pause: ${Math.round((config.protectivePauseMs || 0) / 3600000)}h after serious flag`);
	console.log();

	for (const account of config.accounts) {
		console.log(`  ${account.label || account.email} (${account.email})`);
	}
	console.log();

	const rotator = new AccountRotator(config);
	startProxy(rotator, config.proxyPort);
}

// Direct execution
if (process.argv[1]?.includes("index")) {
	main();
}
