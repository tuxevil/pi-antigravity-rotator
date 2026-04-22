// Standalone OAuth login helper
// Usage: npm run login
// Performs the Antigravity OAuth flow and outputs credentials to add to accounts.json

import { createServer } from "node:http";
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

async function startCallbackServer(): Promise<{ code: string; state: string }> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url || "", "http://localhost:51121");
			if (url.pathname === "/oauth-callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(`<h2>Error: ${error}</h2>`);
					reject(new Error(`OAuth error: ${error}`));
					server.close();
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<h2>Login successful. You can close this tab.</h2>");
					resolve({ code, state });
					server.close();
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<h2>Missing code or state</h2>");
				}
			}
		});

		server.on("error", reject);
		server.listen(51121, "127.0.0.1", () => {
			console.log("Callback server listening on port 51121...");
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
				const data = (await response.json()) as { cloudaicompanionProject?: string | { id?: string } };
				if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
					return data.cloudaicompanionProject;
				}
				if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object" && data.cloudaicompanionProject.id) {
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
	console.log("=== Antigravity Account Login ===");
	console.log();
	console.log("This will open your browser to authenticate with a Google account.");
	console.log("After login, the credentials will be printed for you to add to accounts.json.");
	console.log();

	const { verifier, challenge } = await generatePKCE();

	// Start callback server and build auth URL
	const callbackPromise = startCallbackServer();

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
	console.log("Open this URL in your browser:");
	console.log();
	console.log(authUrl);
	console.log();

	// Try to open browser automatically
	try {
		const { exec } = await import("node:child_process");
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		exec(`${cmd} "${authUrl}"`);
	} catch {
		// Manual open
	}

	console.log("Waiting for authentication...");
	const { code, state } = await callbackPromise;

	if (state !== verifier) {
		console.error("State mismatch - possible CSRF attack");
		process.exit(1);
	}

	// Exchange code for tokens
	console.log("Exchanging code for tokens...");
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
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
	console.log("If this is a Google One AI Premium subscriber, change \"type\" to \"pro\".");
}

main().catch((err) => {
	console.error("Login failed:", err);
	process.exit(1);
});
