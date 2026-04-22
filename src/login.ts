// Standalone OAuth login helper (remote-friendly)
// Usage: npm run login
// Performs the Antigravity OAuth flow using copy-paste (no local callback server needed)

import { createInterface } from "node:readline";
import { CLIENT_ID, CLIENT_SECRET, TOKEN_URL } from "./types.js";

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const { randomBytes, createHash } = await import("node:crypto");
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		return {};
	}
}

function askQuestion(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function discoverProject(accessToken: string): Promise<string> {
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
			const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
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

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
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

async function main(): Promise<void> {
	console.log("=== Pi Antigravity Rotator - Account Login ===");
	console.log();

	const { verifier, challenge } = await generatePKCE();

	const authParams = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
		access_type: "offline",
		prompt: "consent",
	});

	const authUrl = `${AUTH_URL}?${authParams.toString()}`;

	console.log("1. Open this URL in your browser:");
	console.log();
	console.log(authUrl);
	console.log();
	console.log("2. Complete the Google sign-in.");
	console.log("3. After sign-in, your browser will redirect to a localhost URL that won't load.");
	console.log("4. Copy the FULL URL from your browser's address bar and paste it below.");
	console.log();

	const redirectUrl = await askQuestion("Paste the redirect URL here: ");

	if (!redirectUrl) {
		console.error("No URL provided.");
		process.exit(1);
	}

	const parsed = parseRedirectUrl(redirectUrl);

	if (!parsed.code) {
		console.error("Could not extract authorization code from the URL.");
		console.error("Make sure you copied the full URL including the ?code= parameter.");
		process.exit(1);
	}

	if (parsed.state && parsed.state !== verifier) {
		console.error("State mismatch - the URL does not match this login session.");
		process.exit(1);
	}

	// Exchange code for tokens
	console.log();
	console.log("Exchanging code for tokens...");
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code: parsed.code,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		console.error(`Token exchange failed: ${error}`);
		process.exit(1);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	if (!tokenData.refresh_token) {
		console.error("No refresh token received. Try again.");
		process.exit(1);
	}

	// Get user email and project
	console.log("Getting user info...");
	const email = await getUserEmail(tokenData.access_token);

	console.log("Discovering project...");
	const projectId = await discoverProject(tokenData.access_token);

	console.log();
	console.log("=== Account credentials ===");
	console.log();
	console.log("Add this entry to the 'accounts' array in accounts.json:");
	console.log();

	const entry = {
		email: email || "unknown@gmail.com",
		refreshToken: tokenData.refresh_token,
		projectId,
		label: email ? email.split("@")[0] : "Account",
		type: "free",
	};

	console.log(JSON.stringify(entry, null, 2));
	console.log();
	console.log('If this is a Google One AI Premium subscriber, change "type" to "pro".');
}

main().catch((err) => {
	console.error("Login failed:", err);
	process.exit(1);
});
