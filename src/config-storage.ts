import type { Config } from "./types.js";
import { getCachedConfig, setCachedConfig } from "./db-store.js";
import { getDefaultConfig } from "./config-defaults.js";

export function loadConfig(): Config {
  const cached = getCachedConfig();
  if (cached) return cached;
  return getDefaultConfig();
}

export function loadOrCreateAccountsConfig(): Config {
  try {
    return loadConfig();
  } catch {
    return getDefaultConfig();
  }
}

export function saveAccountsConfig(config: Config): void {
  setCachedConfig(config);
}
