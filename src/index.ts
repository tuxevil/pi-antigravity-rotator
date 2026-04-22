// Entry point - loads config and starts the proxy

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { AccountRotator } from "./rotator.js";
import { startProxy } from "./proxy.js";

const BASE_DIR = join(dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = join(BASE_DIR, "accounts.json");

function loadConfig(): Config {
	if (!existsSync(CONFIG_PATH)) {
		console.error(`Config not found: ${CONFIG_PATH}`);
		console.error("Copy accounts.example.json to accounts.json and add your credentials.");
		process.exit(1);
	}

	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const config: Config = JSON.parse(raw);

		if (!config.accounts || config.accounts.length === 0) {
			console.error("No accounts configured in accounts.json");
			process.exit(1);
		}

		// Set defaults
		config.proxyPort = config.proxyPort || 51200;
		config.requestsPerRotation = config.requestsPerRotation || 5;
		config.rotateOnQuotaDrop = config.rotateOnQuotaDrop ?? 20;
		config.quotaPollIntervalMs = config.quotaPollIntervalMs || 300_000;

		return config;
	} catch (err) {
		console.error(`Failed to parse ${CONFIG_PATH}: ${err}`);
		process.exit(1);
	}
}

function main(): void {
	console.log("=== Antigravity Rotator ===");
	console.log();

	const config = loadConfig();
	console.log(`Loaded ${config.accounts.length} accounts`);
	console.log(`Rotation threshold: ${config.requestsPerRotation} requests`);
	console.log();

	for (const account of config.accounts) {
		const type = account.type === "pro" ? "[PRO]" : "[FREE]";
		console.log(`  ${type} ${account.label || account.email} (${account.email})`);
	}
	console.log();

	const rotator = new AccountRotator(config);
	startProxy(rotator, config.proxyPort);
}

main();
