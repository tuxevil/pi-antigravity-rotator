import { addAccountToConfig, ensurePiAuthConfig, ensurePiModelsConfig, loadOrCreateAccountsConfig, saveAccountsConfig } from "./account-store.js";
import { createAuthorizationFlow, exchangeAuthorizationCode, startLocalOAuthServer } from "./codex-oauth.js";
import { getAccountsPath } from "./paths.js";
import type { AccountConfig } from "./types.js";

const ACCOUNTS_FILE = getAccountsPath();

export async function runCodexLogin(): Promise<void> {
	console.log("=== Pi Antigravity Rotator - OpenAI Codex Login ===");
	console.log();

	const { verifier, state, url } = await createAuthorizationFlow();

	console.log("1. Open this URL in your browser to sign in to OpenAI Codex:");
	console.log();
	console.log(url);
	console.log();
	console.log("2. Complete the OpenAI sign-in.");
	console.log("Waiting for the callback automatically on port 1455...");
	console.log();

	const serverInfo = await startLocalOAuthServer(state);

	const codeResult = await serverInfo.waitForCode();
	serverInfo.close();

	if (!codeResult || !codeResult.code) {
		console.error("Authentication timed out or failed.");
		process.exit(1);
	}

	console.log("Exchanging authorization code for tokens...");
	let tokenData;
	try {
		tokenData = await exchangeAuthorizationCode(codeResult.code, verifier);
	} catch (err: any) {
		console.error("Token exchange failed:", err.message || err);
		process.exit(1);
	}

	const email = tokenData.email;
	const accountId = tokenData.accountId;

	console.log();
	console.log(`OpenAI Login Successful!`);
	console.log(`  Email: ${email}`);
	console.log(`  Account ID: ${accountId}`);

	const config = loadOrCreateAccountsConfig();
	const existingIndex = config.accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());

	if (existingIndex >= 0) {
		const existing = config.accounts[existingIndex]!;
		existing.codexRefreshToken = tokenData.refreshToken;
		existing.codexAccountId = accountId;
		saveAccountsConfig(config);
		console.log(`  [Matched] Updated Codex credentials for existing account ${email} in ${ACCOUNTS_FILE}`);
	} else {
		console.log();
		console.log(`  [New] Creating a new account entry for ${email}.`);
		console.log(`  > NOTE: Google Antigravity credentials (for Gemini/Claude) are missing.`);
		console.log(`  > To enable Google models for this account, run: pi-antigravity-rotator login`);

		const entry: AccountConfig = {
			email,
			refreshToken: "", // Will need a Google login to fill this in
			projectId: "",
			codexRefreshToken: tokenData.refreshToken,
			codexAccountId: accountId,
			label: email.split("@")[0] || "CodexAccount",
		};

		config.accounts.push(entry);
		saveAccountsConfig(config);
		console.log(`  Added ${email} to ${ACCOUNTS_FILE}`);
	}

	ensurePiModelsConfig();
	ensurePiAuthConfig();

	console.log();
	console.log(`Done. ${config.accounts.length} account(s) configured.`);
	console.log("Run 'npm start' to start the proxy.");
}

if (process.argv[1]?.includes("codex-login")) {
	runCodexLogin().catch((err) => {
		console.error("Codex Login failed:", err);
		process.exit(1);
	});
}
