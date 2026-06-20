import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  isDbConfigured,
  getCachedAdminToken,
  setCachedAdminToken,
} from "./db-store.js";

interface AdminAuthRequest {
  url?: string;
  headers: IncomingMessage["headers"];
}

const ADMIN_TOKEN_FILENAME = ".admin-token";

let persistedToken: string | null = null;

/**
 * Set the persisted admin token at runtime. Called by index.ts after
 * ensureAdminToken resolves the effective token. Subsequent calls to
 * getConfiguredAdminToken() will return this token if no env var is set.
 */
export function setPersistedAdminToken(token: string | null): void {
  persistedToken = token && token.length > 0 ? token : null;
}

export function getConfiguredAdminToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env.PI_ROTATOR_ADMIN_TOKEN?.trim();
  if (token) return token;
  return persistedToken;
}

/**
 * Generate a cryptographically secure admin token (32 random bytes, hex).
 * 64 hex characters = 256 bits of entropy.
 */
export function generateAdminToken(): string {
  return randomBytes(32).toString("hex");
}

export function readPersistedAdminToken(configDir: string): string | null {
  if (isDbConfigured()) {
    return getCachedAdminToken();
  }
  const tokenPath = join(configDir, ADMIN_TOKEN_FILENAME);
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, "utf-8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

export function writePersistedAdminToken(
  configDir: string,
  token: string,
): void {
  if (isDbConfigured()) {
    setCachedAdminToken(token);
    return;
  }
  const tokenPath = join(configDir, ADMIN_TOKEN_FILENAME);
  writeFileSync(tokenPath, token, { mode: 0o600, encoding: "utf-8" });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Best effort: some filesystems (e.g. Windows) don't support POSIX perms.
  }
}

export interface ResolvedAdminToken {
  token: string;
  source: "env" | "file" | "generated";
  generated: boolean;
}

/**
 * Resolve the effective admin token, generating and persisting one if needed.
 * Priority: PI_ROTATOR_ADMIN_TOKEN env var > .admin-token file > generate new.
 *
 * When a token is generated, it is persisted to .admin-token with 0600 perms
 * and returned. The caller is responsible for printing it to the operator.
 */
export function ensureAdminToken(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAdminToken {
  const envToken = env.PI_ROTATOR_ADMIN_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env", generated: false };
  }

  const fileToken = readPersistedAdminToken(configDir);
  if (fileToken) {
    return { token: fileToken, source: "file", generated: false };
  }

  const newToken = generateAdminToken();
  try {
    writePersistedAdminToken(configDir, newToken);
  } catch {
    // If we cannot write the file (read-only fs, perms), still return the
    // token for this session. The next restart will simply generate again.
  }
  return { token: newToken, source: "generated", generated: true };
}

export function getRequestAdminToken(req: AdminAuthRequest): string | null {
  const headerToken = req.headers["x-rotator-admin-token"];
  if (typeof headerToken === "string" && headerToken) return headerToken;
  if (Array.isArray(headerToken) && headerToken[0]) return headerToken[0];

  const authorization = req.headers.authorization;
  if (
    typeof authorization === "string" &&
    authorization.toLowerCase().startsWith("bearer ")
  ) {
    return authorization.slice("bearer ".length).trim();
  }

  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    return requestUrl.searchParams.get("token");
  } catch {
    return null;
  }
}

export function isAdminAuthorized(
  req: AdminAuthRequest,
  expectedToken: string | null = getConfiguredAdminToken(),
): boolean {
  if (!expectedToken) return true;
  return getRequestAdminToken(req) === expectedToken;
}

export function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isAdminAuthorized(req)) return true;
  res.writeHead(401, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}
