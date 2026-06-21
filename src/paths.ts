// Config directory resolution
// Default: ~/.pi-antigravity-rotator/
// Override: --config-dir <path> or PI_ROTATOR_DIR env var

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DEFAULT_DIR = join(homedir(), ".pi-antigravity-rotator");

let configDir: string | null = null;

/**
 * Validate that a user-supplied config dir doesn't contain obvious path
 * traversal. Refuses to mkdir and returns the default if the input contains
 * `..` segments that escape the intended root. Throws otherwise.
 */
export function resolveSafeConfigDir(
  input: string,
  source: "argv" | "env" = "argv",
): string {
  // Check the ORIGINAL input (before resolve() collapses ".."), since
  // resolve("/a/../../b") silently becomes "/b" and would mask the attack.
  const segments = input.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(
        `Refusing --config-dir="${input}" from ${source}: contains '..' segment which could escape the config root. ` +
          `Use an absolute path or PI_ROTATOR_DIR env var set by the container orchestrator.`,
      );
    }
  }
  return resolve(input);
}

export function getConfigDir(): string {
  if (configDir) return configDir;

  // Check CLI arg
  const idx = process.argv.indexOf("--config-dir");
  if (idx !== -1 && process.argv[idx + 1]) {
    configDir = resolveSafeConfigDir(process.argv[idx + 1], "argv");
  } else if (process.env.PI_ROTATOR_DIR) {
    configDir = resolveSafeConfigDir(process.env.PI_ROTATOR_DIR, "env");
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
