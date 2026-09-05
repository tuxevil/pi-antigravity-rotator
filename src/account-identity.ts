import { createHash } from "node:crypto";
import { normalizeAccountConfig } from "./config-normalize.js";
import type {
  AccountConfig,
  AccountRuntime,
  ProviderCredential,
} from "./types.js";
import {
  DEFAULT_PROVIDER,
  getProviderProjectId,
} from "./providers/credential-helpers.js";

function credentialFingerprint(secret?: string): string {
  if (!secret) return "";
  // SHA-256 is intentional: this is a non-secret deduplication fingerprint, not a
  // password hash. It must be deterministic and fast (bcrypt/argon2 would be wrong here).
  return createHash("sha256").update(secret).digest("hex").slice(0, 12); // codeql[js/insufficient-password-hash]
}

export function getProviderCredentialDetails(
  norm: AccountConfig,
  cred?: ProviderCredential,
): {
  provider: string;
  projectId: string;
  providerAccountId: string;
  secret: string;
  fingerprint: string;
} {
  const provider = cred?.provider ?? DEFAULT_PROVIDER;
  const projectId = getProviderProjectId(norm, provider);
  let providerAccountId = cred?.providerAccountId || "";
  let secret = cred?.refreshToken || cred?.apiKey || "";

  if (provider === "google-antigravity") {
    secret ||= norm.refreshToken || norm.apiKey || "";
  } else if (provider === "openai-codex") {
    providerAccountId ||= norm.codexAccountId || "";
    secret ||= norm.codexRefreshToken || "";
  }

  const fingerprint = !projectId && !providerAccountId && secret
    ? credentialFingerprint(secret)
    : "";
  return { provider, projectId, providerAccountId, secret, fingerprint };
}

export function getAccountIdentity(
  account: AccountConfig | AccountRuntime,
): string {
  const config = "config" in account ? account.config : account;
  const norm = normalizeAccountConfig(config);
  const email = norm.email.toLowerCase().trim();
  const creds = (norm.credentials ?? [])
    .slice()
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((credential) => {
      const details = getProviderCredentialDetails(norm, credential);
      return `${details.provider}:${details.projectId}:${details.providerAccountId}:${details.fingerprint}`;
    })
    .join("|");
  if (!creds) {
    const details = getProviderCredentialDetails(norm, {
      provider: DEFAULT_PROVIDER,
    });
    return `${email}#${details.provider}:${details.projectId}:${details.providerAccountId}:${details.fingerprint}`;
  }
  return `${email}#${creds}`;
}

/** Identify the exact provider credential revision used by an async operation. */
export function getCredentialGeneration(
  account: AccountRuntime | AccountConfig,
  providerId: string,
): string {
  const config = "config" in account ? account.config : account;
  const norm = normalizeAccountConfig(config);
  const cred = norm.credentials?.find((candidate) => candidate.provider === providerId);
  const details = getProviderCredentialDetails(
    norm,
    cred ?? { provider: providerId },
  );
  if (!cred && !details.secret) return "none";
  return `${providerId}:${details.projectId}:${details.providerAccountId}:${details.secret}`;
}

/** Persist a credential revision without exposing its raw secret. */
export function getCredentialGenerationFingerprint(
  account: AccountRuntime | AccountConfig,
  providerId: string,
): string {
  return createHash("sha256")
    .update(getCredentialGeneration(account, providerId))
    .digest("hex"); // codeql[js/insufficient-password-hash]
}
