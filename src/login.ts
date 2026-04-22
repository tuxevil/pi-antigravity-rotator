// Standalone OAuth login helper (fully automated)
// Usage: npm run login
// 1. Opens OAuth URL -> user pastes redirect URL
// 2. Automatically adds account to accounts.json
// 3. Automatically configures ~/.pi/agent/models.json and ~/.pi/agent/auth.json

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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

const BASE_DIR = join(dirname(new URL(import.meta.url).pathname), "..");
const ACCOUNTS_FILE = join(BASE_DIR, "accounts.json");
const PI_DIR = join(homedir(), ".pi", "agent");
const PI_MODELS_FILE = join(PI_DIR, "models.json");
const PI_AUTH_FILE = join(PI_DIR, "auth.json");

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

// =========================================================================
// File management
// =========================================================================

interface AccountEntry {
	email: string;
	refreshToken: string;
	projectId: string;
	label: string;
}

interface AccountsConfig {
	proxyPort: number;
	requestsPerRotation: number;
	rotateOnQuotaDrop: number;
	quotaPollIntervalMs: number;
	accounts: AccountEntry[];
}

function loadOrCreateAccountsConfig(): AccountsConfig {
	if (existsSync(ACCOUNTS_FILE)) {
		try {
			return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
		} catch {
			// Corrupted, start fresh
		}
	}
	return {
		proxyPort: 51200,
		requestsPerRotation: 5,
		rotateOnQuotaDrop: 20,
		quotaPollIntervalMs: 30000,
		accounts: [],
	};
}

function saveAccountsConfig(config: AccountsConfig): void {
	writeFileSync(ACCOUNTS_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function addAccountToConfig(entry: AccountEntry): { isNew: boolean } {
	const config = loadOrCreateAccountsConfig();
	const existing = config.accounts.findIndex((a) => a.email === entry.email);

	if (existing >= 0) {
		// Update existing account
		config.accounts[existing] = entry;
		saveAccountsConfig(config);
		return { isNew: false };
	}

	// Add new account
	config.accounts.push(entry);
	saveAccountsConfig(config);
	return { isNew: true };
}

function ensurePiModelsConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let models: Record<string, unknown> = {};
	if (existsSync(PI_MODELS_FILE)) {
		try {
			models = JSON.parse(readFileSync(PI_MODELS_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	// Ensure providers.google-antigravity.baseUrl is set
	const providers = (models.providers || {}) as Record<string, Record<string, unknown>>;
	const antigravity = providers["google-antigravity"] || {};

	if (antigravity.baseUrl === "http://localhost:51200") {
		return; // Already configured
	}

	antigravity.baseUrl = "http://localhost:51200";
	providers["google-antigravity"] = antigravity;
	models.providers = providers;

	writeFileSync(PI_MODELS_FILE, JSON.stringify(models, null, 2) + "\n", "utf-8");
	console.log(`  Updated ${PI_MODELS_FILE}`);
}

function ensurePiAuthConfig(): void {
	mkdirSync(PI_DIR, { recursive: true });

	let auth: Record<string, unknown> = {};
	if (existsSync(PI_AUTH_FILE)) {
		try {
			auth = JSON.parse(readFileSync(PI_AUTH_FILE, "utf-8"));
		} catch {
			// Corrupted, will overwrite
		}
	}

	const existing = auth["google-antigravity"] as Record<string, unknown> | undefined;
	if (existing?.type === "oauth" && existing?.refresh === "proxy-managed") {
		return; // Already configured
	}

	auth["google-antigravity"] = {
		type: "oauth",
		refresh: "proxy-managed",
		access: "proxy-managed",
		expires: 32503680000000, // year 3000
		projectId: "proxy-managed",
	};

	writeFileSync(PI_AUTH_FILE, JSON.stringify(auth, null, 2) + "\n", "utf-8");
	console.log(`  Updated ${PI_AUTH_FILE}`);
}

// =========================================================================
// Main
// =========================================================================

async function main(): Promise<void> {
	console.log("=== Pi Antigravity Rotator - Add Account ===");
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
	console.log("3. Copy the FULL URL from your browser (it will show a page that won't load).");
	console.log();

	const redirectUrl = await askQuestion("Paste the redirect URL: ");

	if (!redirectUrl) {
		console.error("No URL provided.");
		process.exit(1);
	}

	const parsed = parseRedirectUrl(redirectUrl);

	if (!parsed.code) {
		console.error("Could not extract authorization code from the URL.");
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

	console.log("Getting user info...");
	const email = await getUserEmail(tokenData.access_token);

	console.log("Discovering project...");
	const projectId = await discoverProject(tokenData.access_token);

	const label = email ? email.split("@")[0] : "Account";

	// Save to accounts.json
	console.log();
	const entry: AccountEntry = {
		email: email || "unknown@gmail.com",
		refreshToken: tokenData.refresh_token,
		projectId,
		label,
	};

	const { isNew } = addAccountToConfig(entry);
	console.log(`  ${isNew ? "Added" : "Updated"} ${email} in ${ACCOUNTS_FILE}`);

	// Configure pi
	ensurePiModelsConfig();
	ensurePiAuthConfig();

	// Show summary
	const config = loadOrCreateAccountsConfig();
	console.log();
	console.log(`Done. ${config.accounts.length} account(s) configured:`);
	for (const a of config.accounts) {
		console.log(`  ${a.label} (${a.email})`);
	}
	console.log();
	console.log("Run 'npm start' to start the proxy.");
}

main().catch((err) => {
	console.error("Login failed:", err);
	process.exit(1);
});
