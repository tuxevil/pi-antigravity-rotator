import { createHash, randomBytes } from "node:crypto";
import { TOKEN_URL } from "./types.js";
import { fetchWithRetry } from "./fetch-with-retry.js";

export const DEFAULT_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface OAuthClientConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export interface TokenExchangeResult {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export function getOAuthClientConfig(
	env: NodeJS.ProcessEnv = process.env,
): OAuthClientConfig {
	const clientId = env.ANTIGRAVITY_CLIENT_ID?.trim();
	const clientSecret = env.ANTIGRAVITY_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) {
		const missing: string[] = [];
		if (!clientId) missing.push("ANTIGRAVITY_CLIENT_ID");
		if (!clientSecret) missing.push("ANTIGRAVITY_CLIENT_SECRET");
		throw new Error(
			`Missing OAuth client credentials: set ${missing.join(" and ")} before starting OAuth login.`,
		);
	}
	const redirectUri = env.ANTIGRAVITY_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
	try {
		const redirectUrl = new URL(redirectUri);
		if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new Error("Invalid OAuth redirect URI: use an absolute http:// or https:// URL.");
	}

	return {
		clientId,
		clientSecret,
		redirectUri,
	};
}

let warnedAboutFallback = false;

/**
 * Check whether the operator has configured OAuth client credentials.
 * Credentials are deliberately not bundled in the published source. When
 * they are missing, OAuth login cannot start and the operator gets one warning.
 *
 * The warning is printed at most once per process to avoid log spam.
 */
export function warnIfUsingFallbackOAuthCreds(env: NodeJS.ProcessEnv = process.env): boolean {
	const missing: string[] = [];
	if (!env.ANTIGRAVITY_CLIENT_ID?.trim()) missing.push("ANTIGRAVITY_CLIENT_ID");
	if (!env.ANTIGRAVITY_CLIENT_SECRET?.trim()) missing.push("ANTIGRAVITY_CLIENT_SECRET");
	if (missing.length === 0) return false;
	if (warnedAboutFallback) return true;
	warnedAboutFallback = true;
	console.warn(
		"OAuth client credentials are not configured. Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET to your own registered OAuth client before using login.",
	);
	return true;
}

export function isHostedOAuthConfigured(): boolean {
	try {
		const { redirectUri } = getOAuthClientConfig();
		const url = new URL(redirectUri);
		return url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
	} catch {
		return false;
	}
}

export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function generateState(): string {
	return randomBytes(24).toString("base64url");
}

export function buildAuthUrl(state: string, challenge: string): string {
	const oauth = getOAuthClientConfig();
	const authParams = new URLSearchParams({
		client_id: oauth.clientId,
		response_type: "code",
		redirect_uri: oauth.redirectUri,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	});

	return `${AUTH_URL}?${authParams.toString()}`;
}

export async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenExchangeResult> {
	const oauth = getOAuthClientConfig();
	const tokenResponse = await fetchWithRetry(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: oauth.clientId,
			client_secret: oauth.clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: oauth.redirectUri,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	if (!tokenData.refresh_token) {
		throw new Error("No refresh token received. Try again.");
	}

	return {
		accessToken: tokenData.access_token,
		refreshToken: tokenData.refresh_token,
		expiresIn: tokenData.expires_in,
	};
}

export interface ProjectDiscoveryResult {
	projectId: string;
	source: "google";
	endpoint: string;
}

export async function discoverProject(accessToken: string): Promise<ProjectDiscoveryResult> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
	};

	const endpoints = [
		// "https://cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
	];

	for (const endpoint of endpoints) {
		try {
			const response = await fetchWithRetry(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
			});

			if (response.ok) {
				const data = (await response.json()) as {
					cloudaicompanionProject?: string | { id?: string };
				};
				if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
					return { projectId: data.cloudaicompanionProject, source: "google", endpoint };
				}
				if (
					data.cloudaicompanionProject &&
					typeof data.cloudaicompanionProject === "object" &&
					data.cloudaicompanionProject.id
				) {
					return { projectId: data.cloudaicompanionProject.id, source: "google", endpoint };
				}
			}
		} catch {
			// Try next endpoint
		}
	}

	throw new Error("Could not discover Cloud Code companion project ID from Google. If this account is new, open it in Antigravity IDE and send one message first, then retry login. Login failed instead of falling back to a shared projectId.");
}

export async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetchWithRetry("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore
	}
	return undefined;
}
