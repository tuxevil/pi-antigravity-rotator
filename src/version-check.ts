// Version check and self-update functionality
// Polls npm registry periodically to detect new releases

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const versionLogger = logger.child("version-check");

export interface UpdateInfo {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	checkedAt: number;
}

const PACKAGE_NAME = "pi-antigravity-rotator";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let cachedInfo: UpdateInfo = {
	currentVersion: "",
	latestVersion: null,
	updateAvailable: false,
	checkedAt: 0,
};
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Read the current version from package.json.
 */
function getCurrentVersion(): string {
	try {
		// Resolve relative to this source file
		const thisDir = dirname(fileURLToPath(import.meta.url));
		const pkgPath = join(thisDir, "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Simple semver comparison: returns true if b > a.
 * Handles standard x.y.z format.
 */
function isNewerVersion(current: string, latest: string): boolean {
	const a = current.split(".").map(Number);
	const b = latest.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (bv > av) return true;
		if (bv < av) return false;
	}
	return false;
}

/**
 * Fetch latest version from npm registry.
 */
async function fetchLatestVersion(): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		const response = await fetch(REGISTRY_URL, {
			headers: { Accept: "application/vnd.npm.install-v1+json" },
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) {
			versionLogger.log("warn", `npm registry returned ${response.status}`);
			return null;
		}

		const data = (await response.json()) as { "dist-tags"?: { latest?: string } };
		return data["dist-tags"]?.latest ?? null;
	} catch (err) {
		// Silently fail — user may be offline
		versionLogger.log("info", `Version check skipped: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/**
 * Perform a version check against npm registry.
 */
async function checkForUpdate(): Promise<UpdateInfo> {
	const currentVersion = getCurrentVersion();
	const latestVersion = await fetchLatestVersion();

	cachedInfo = {
		currentVersion,
		latestVersion,
		updateAvailable: latestVersion !== null && isNewerVersion(currentVersion, latestVersion),
		checkedAt: Date.now(),
	};

	if (cachedInfo.updateAvailable) {
		versionLogger.log("info", `New version available: ${latestVersion} (current: ${currentVersion})`);
	}

	return cachedInfo;
}

/**
 * Get the cached update info. Returns immediately.
 */
export function getUpdateInfo(): UpdateInfo {
	if (!cachedInfo.currentVersion) {
		cachedInfo.currentVersion = getCurrentVersion();
	}
	return { ...cachedInfo };
}

/**
 * Start periodic version checking.
 * Performs an initial check after a short delay (10s) to avoid slowing down startup.
 */
export function startVersionChecker(): void {
	// Initial delayed check
	if (!initialCheckTimer) {
		initialCheckTimer = setTimeout(() => {
			initialCheckTimer = null;
			void checkForUpdate();
		}, 10_000);
		if (initialCheckTimer.unref) {
			initialCheckTimer.unref();
		}
	}

	// Periodic check
	if (!checkTimer) {
		checkTimer = setInterval(() => {
			void checkForUpdate();
		}, CHECK_INTERVAL_MS);

		// Don't keep process alive just for version checking
		if (checkTimer.unref) {
			checkTimer.unref();
		}
	}
}

/**
 * Stop periodic version checking.
 */
export function stopVersionChecker(): void {
	if (initialCheckTimer) {
		clearTimeout(initialCheckTimer);
		initialCheckTimer = null;
	}
	if (checkTimer) {
		clearInterval(checkTimer);
		checkTimer = null;
	}
}

/**
 * Attempt to self-update by running npm install.
 * Returns a result object with success/failure info.
 */
export function performSelfUpdate(): { ok: boolean; from: string; to: string; message: string } {
	const currentVersion = getCurrentVersion();
	const targetVersion = cachedInfo.latestVersion || "latest";

	try {
		// Detect install method: check if we're running from a global npm install
		const isGlobal = isGlobalInstall();
		const cmd = isGlobal
			? `npm install -g ${PACKAGE_NAME}@latest`
			: `npm install ${PACKAGE_NAME}@latest`;

		versionLogger.log("info", `Self-update: running "${cmd}"`);

		const output = execSync(cmd, {
			encoding: "utf-8",
			timeout: 120_000, // 2 minute timeout
			stdio: ["pipe", "pipe", "pipe"],
		});

		versionLogger.log("info", `Self-update completed: ${output.trim().slice(0, 200)}`);

		return {
			ok: true,
			from: currentVersion,
			to: targetVersion,
			message: `Updated from v${currentVersion} to v${targetVersion}. Restart the process to apply the update.`,
		};
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		versionLogger.log("error", `Self-update failed: ${errorMsg}`);

		return {
			ok: false,
			from: currentVersion,
			to: targetVersion,
			message: `Update failed: ${errorMsg.slice(0, 300)}. Try manually: npm install -g ${PACKAGE_NAME}@latest`,
		};
	}
}

/**
 * Detect if the package was installed globally.
 */
function isGlobalInstall(): boolean {
	try {
		// Check if we're in the global npm prefix
		const globalPrefix = execSync("npm prefix -g", { encoding: "utf-8", timeout: 5000 }).trim();
		const thisDir = dirname(fileURLToPath(import.meta.url));
		return thisDir.startsWith(globalPrefix);
	} catch {
		// If we can't determine, default to global (safer for npx users)
		return true;
	}
}
