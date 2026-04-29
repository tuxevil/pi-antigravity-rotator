// Entry point - loads config and starts the proxy

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { AccountRotator } from "./rotator.js";
import { startProxy } from "./proxy.js";
import { getAccountsPath, getConfigDir } from "./paths.js";
import { formatValidationErrors, validateConfig } from "./validators.js";
import { TelemetryReporter, setActiveReporter } from "./telemetry.js";

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

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Show a one-time, non-intrusive star reminder after 24h since first install.
 * Creates .first-boot on first run, shows prompt once after 24h,
 * then writes .star-prompted so it never appears again.
 */
function maybeShowStarNudge(): void {
	const dir = getConfigDir();
	const promptedPath = join(dir, ".star-prompted");
	if (existsSync(promptedPath)) return; // already shown, done forever

	const firstBootPath = join(dir, ".first-boot");
	let firstBootMs: number;

	if (existsSync(firstBootPath)) {
		try {
			firstBootMs = parseInt(readFileSync(firstBootPath, "utf-8").trim(), 10);
			if (Number.isNaN(firstBootMs)) return;
		} catch { return; }
	} else {
		// First ever boot — record timestamp
		firstBootMs = Date.now();
		try { writeFileSync(firstBootPath, String(firstBootMs), "utf-8"); } catch { /* best effort */ }
		return; // too early, come back after 24h
	}

	if (Date.now() - firstBootMs < TWENTY_FOUR_HOURS_MS) return; // not yet

	// Show it once
	console.log("  ╭──────────────────────────────────────────────────────────╮");
	console.log("  │  ⭐ Enjoying pi-antigravity-rotator?                     │");
	console.log("  │  github.com/tuxevil/pi-antigravity-rotator              │");
	console.log("  │  A star helps others find it. Thanks!                   │");
	console.log("  ╰──────────────────────────────────────────────────────────╯");
	console.log();

	try { writeFileSync(promptedPath, String(Date.now()), "utf-8"); } catch { /* best effort */ }
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

	maybeShowStarNudge();

	const rotator = new AccountRotator(config);

	// ── Telemetry (anonymous, opt-out via PI_ROTATOR_TELEMETRY=off) ──
	const telemetry = new TelemetryReporter(() => {
		const status = rotator.getStatus();

		// Use getTokenUsage() which correctly reads only the raw minutes buckets
		const tu = rotator.getTokenUsage();
		const tokensByModel: Record<string, { input: number; output: number; requests: number }> = {};
		for (const b of tu.minutes) {
			for (const [model, data] of Object.entries(b.byModel)) {
				if (!tokensByModel[model]) tokensByModel[model] = { input: 0, output: 0, requests: 0 };
				tokensByModel[model].input += data.inputTokens;
				tokensByModel[model].output += data.outputTokens;
				tokensByModel[model].requests += data.requests;
			}
		}

		return {
			accountCount: status.accounts.length,
			modelsUsed: Object.keys(status.activeAccounts),
			totalRequests: status.totalRequestsAllAccounts,
			uptimeSeconds: Math.round(status.uptime / 1000),
			routingHealthState: status.routingHealth.state,
			flaggedCount: status.routingHealth.flaggedCount,
			disabledCount: status.routingHealth.disabledCount,
			proCount: status.accounts.filter(a => a.proDetected).length,
			freeCount: status.accounts.filter(a => !a.proDetected).length,
			tokensByModel,
		};
	});
	setActiveReporter(telemetry);
	void telemetry.start();

	// ── Graceful shutdown ──
	const shutdown = async (): Promise<void> => {
		console.log("\nShutting down...");
		await telemetry.shutdown();
		rotator.stopQuotaPolling();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	startProxy(rotator, config.proxyPort);
}

// Direct execution
if (process.argv[1]?.includes("index")) {
	main();
}
