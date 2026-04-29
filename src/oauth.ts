import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID, CLIENT_SECRET, TOKEN_URL } from "./types.js";
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
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

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

export function getOAuthClientConfig(): OAuthClientConfig {
	return {
		clientId: process.env.ANTIGRAVITY_CLIENT_ID || CLIENT_ID,
		clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET || CLIENT_SECRET,
		redirectUri: process.env.ANTIGRAVITY_REDIRECT_URI || DEFAULT_REDIRECT_URI,
	};
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

export async function discoverProject(accessToken: string): Promise<string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
	};

	const endpoints = [
		"https://cloudcode-pa.googleapis.com",
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
					return data.cloudaicompanionProject;
				}
				if (
					data.cloudaicompanionProject &&
					typeof data.cloudaicompanionProject === "object" &&
					data.cloudaicompanionProject.id
				) {
					return data.cloudaicompanionProject.id;
				}
			}
		} catch {
			// Try next endpoint
		}
	}

	return DEFAULT_PROJECT_ID;
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
