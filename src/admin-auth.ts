import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { getCachedAdminToken, setCachedAdminToken } from "./db-store.js";

interface AdminAuthRequest {
  url?: string;
  headers: IncomingMessage["headers"];
}

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

export function readPersistedAdminToken(): string | null {
  return getCachedAdminToken();
}

export function writePersistedAdminToken(token: string): void {
  setCachedAdminToken(token);
}

export interface ResolvedAdminToken {
  token: string;
  source: "env" | "repository" | "generated";
  generated: boolean;
}

/**
 * Resolve the effective admin token, generating and persisting one if needed.
 * Priority: PI_ROTATOR_ADMIN_TOKEN env var > repository > generate new.
 *
 * When a token is generated, it is persisted to the repository and returned.
 * The caller is responsible for printing it to the operator.
 */
export function ensureAdminToken(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAdminToken {
  const envToken = env.PI_ROTATOR_ADMIN_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env", generated: false };
  }

  const existing = readPersistedAdminToken();
  if (existing) {
    return { token: existing, source: "repository", generated: false };
  }

  const newToken = generateAdminToken();
  try {
    writePersistedAdminToken(newToken);
  } catch {
    // If we cannot persist (e.g. DB down, read-only fs), still return the
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
