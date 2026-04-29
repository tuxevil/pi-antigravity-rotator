// Standalone OAuth login helper (fully automated)
// Usage: npm run login
// 1. Opens OAuth URL -> user pastes redirect URL
// 2. Automatically adds account to accounts.json
// 3. Automatically configures ~/.pi/agent/models.json and ~/.pi/agent/auth.json

import { createInterface } from "node:readline";
import { addAccountToConfig, ensurePiAuthConfig, ensurePiModelsConfig, loadOrCreateAccountsConfig } from "./account-store.js";
import { buildAuthUrl, discoverProject, exchangeAuthorizationCode, generatePkce, getOAuthClientConfig, getUserEmail } from "./oauth.js";
import type { AccountConfig } from "./types.js";
import { getAccountsPath } from "./paths.js";

const ACCOUNTS_FILE = getAccountsPath();

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

export async function runLogin(): Promise<void> {
	console.log("=== Pi Antigravity Rotator - Add Account ===");
	console.log();

	const oauth = getOAuthClientConfig();
	const { verifier, challenge } = generatePkce();
	const authUrl = buildAuthUrl(verifier, challenge);

	console.log("1. Open this URL in your browser:");
	console.log();
	console.log(authUrl);
	console.log();
	console.log("2. Complete the Google sign-in.");
	console.log(`3. Copy the FULL URL from your browser after it redirects to ${oauth.redirectUri}.`);
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

	console.log();
	console.log("Exchanging code for tokens...");
	const tokenData = await exchangeAuthorizationCode(parsed.code, verifier);

	console.log("Getting user info...");
	const email = await getUserEmail(tokenData.accessToken);

	console.log("Discovering project...");
	const project = await discoverProject(tokenData.accessToken);

	const label = email ? email.split("@")[0] : "Account";
	const entry: AccountConfig = {
		email: email || "unknown@gmail.com",
		refreshToken: tokenData.refreshToken,
		projectId: project.projectId,
		projectSource: project.source,
		label,
	};

	console.log();
	const { isNew } = addAccountToConfig(entry);
	console.log(`  ${isNew ? "Added" : "Updated"} ${entry.email} in ${ACCOUNTS_FILE}`);
	console.log(`  projectId=${project.projectId} (source=${project.source})`);

	ensurePiModelsConfig();
	ensurePiAuthConfig();

	const config = loadOrCreateAccountsConfig();
	console.log();
	console.log(`Done. ${config.accounts.length} account(s) configured:`);
	for (const a of config.accounts) {
		console.log(`  ${a.label || a.email} (${a.email})`);
	}
	console.log();
	console.log("Run 'npm start' to start the proxy.");
}

if (process.argv[1]?.includes("login")) {
	runLogin().catch((err) => {
		console.error("Login failed:", err);
		process.exit(1);
	});
}
