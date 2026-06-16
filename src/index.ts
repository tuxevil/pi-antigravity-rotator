// Entry point - loads config and starts the proxy

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { AccountRotator } from "./rotator.js";
import { startProxy } from "./proxy.js";
import { getConfigDir } from "./paths.js";
import { TelemetryReporter, setActiveReporter } from "./telemetry.js";
import { loadConfigFromDisk } from "./account-store.js";
import { ensureAdminToken, getConfiguredAdminToken, setPersistedAdminToken } from "./admin-auth.js";
import { warnIfUsingFallbackOAuthCreds } from "./oauth.js";
import { warnIfInsecureTelemetryEndpoint } from "./telemetry.js";
import { setModelSpecsOverride, loadResponsesStore, flushResponsesStoreSync } from "./compat.js";
import { setModelAliasesOverride } from "./types.js";
import { writeTextFileAtomic } from "./storage.js";

function loadConfig(): Config {
	const configPath = join(getConfigDir(), "accounts.json");
	if (!existsSync(configPath)) {
		console.error(`Config not found: ${configPath}`);
		console.error("Run 'pi-antigravity-rotator login' to add your first account.");
		process.exit(1);
	}

	try {
		const config = loadConfigFromDisk();

		if (!config.accounts || config.accounts.length === 0) {
			console.error("No accounts configured. Run 'pi-antigravity-rotator login' to add one.");
			process.exit(1);
		}

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
		try { writeTextFileAtomic(firstBootPath, String(firstBootMs)); } catch { /* best effort */ }
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

	try { writeTextFileAtomic(promptedPath, String(Date.now())); } catch { /* best effort */ }
}

/**
 * Resolve the effective admin token at startup. If no PI_ROTATOR_ADMIN_TOKEN
 * env var is set and no .admin-token file exists, a new token is generated,
 * persisted to .admin-token, and printed to the operator once. This ensures
 * admin routes are protected by default on first run.
 */
function bootstrapAdminToken(configDir: string): void {
	const resolved = ensureAdminToken(configDir);
	setPersistedAdminToken(resolved.token);
	if (resolved.source === "generated") {
		console.log();
		console.log("  ╭──────────────────────────────────────────────────────────╮");
		console.log("  │  Generated admin token (persisted to .admin-token):      │");
		console.log(`  │  ${resolved.token}  │`);
		console.log("  │                                                          │");
		console.log("  │  Header: x-rotator-admin-token: <token>                  │");
		console.log("  │  Bearer: Authorization: Bearer <token>                   │");
		console.log("  │  URL:    <url>?token=<token>                             │");
		console.log("  ╰──────────────────────────────────────────────────────────╯");
		console.log();
	}
}

function maybeWarnAboutAdminExposure(config: Config): void {
	if (getConfiguredAdminToken()) return;
	console.warn("WARNING: PI_ROTATOR_ADMIN_TOKEN is not configured.");
	console.warn(`WARNING: Dashboard and /api/* routes are open on ${config.bindHost}:${config.proxyPort}.`);
	console.warn("WARNING: For local-only use, prefer bindHost=127.0.0.1 or set PI_ROTATOR_ADMIN_TOKEN.");
	console.warn();
}

export function main(): void {
	console.log("=== Pi Antigravity Rotator ===");
	console.log();

	const config = loadConfig();
	console.log(`Loaded ${config.accounts.length} accounts`);
	console.log(`Rotation: ${config.requestsPerRotation} requests / ${config.rotateOnQuotaDrop}% quota drop`);
	console.log(`Quota poll: every ${Math.round((config.quotaPollIntervalMs || 300000) / 1000)}s`);
	console.log(`Concurrency cap: ${config.maxConcurrentRequestsPerAccount} request/account, ${config.maxConcurrentRequestsPerProjectModel} request/project+model`);
	console.log(`Bind host: ${config.bindHost}`);
	console.log(`Routing policy: ${config.routingPolicy}`);
	console.log(`Safety breaker: ${config.projectCircuitBreaker429Threshold} provider 429s / ${Math.round((config.projectCircuitBreakerWindowMs || 0) / 60000)}m pauses project+model for ${Math.round((config.projectCircuitBreakerCooldownMs || 0) / 60000)}m`);
	console.log(`Protective pause: ${Math.round((config.protectivePauseMs || 0) / 3600000)}h after serious flag`);
	console.log();

	for (const account of config.accounts) {
		console.log(`  ${account.label || account.email} (${account.email})`);
	}
	console.log();

	maybeShowStarNudge();
	bootstrapAdminToken(getConfigDir());
	maybeWarnAboutAdminExposure(config);
	warnIfUsingFallbackOAuthCreds();
	warnIfInsecureTelemetryEndpoint();
	setModelSpecsOverride(config.modelSpecs ?? null);
	setModelAliasesOverride(config.modelAliases ?? null);
	void loadResponsesStore();

	const rotator = new AccountRotator(config);

	// ── Telemetry (anonymous, opt-out via PI_ROTATOR_TELEMETRY=off) ──
	const telemetry = new TelemetryReporter(() => {
		const status = rotator.getStatus();

		// getTokenUsage() deduplicates rolled-up buckets and exposes tokensByModel
		const tu = rotator.getTokenUsage();
		const tokensByModel = tu.tokensByModel;

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
		flushResponsesStoreSync();
		rotator.flushPendingStateSaveSync();
		rotator.flushPendingTokenUsageSaveSync();
		await telemetry.shutdown();
		rotator.stopQuotaPolling();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	startProxy(rotator, config.proxyPort, config.bindHost || "0.0.0.0");
}

// Direct execution
if (process.argv[1]?.includes("index")) {
	main();
}
