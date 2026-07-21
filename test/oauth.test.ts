import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverProject, getOAuthClientConfig, warnIfUsingFallbackOAuthCreds } from "../src/oauth.js";
import { CLIENT_ID, CLIENT_SECRET } from "../src/types.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("oauth project discovery", () => {
	it("returns discovered project id from Google", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ cloudaicompanionProject: { id: "proj-123" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await discoverProject("token");
		assert.equal(result.projectId, "proj-123");
		assert.equal(result.source, "google");
		assert.ok(result.endpoint.includes("cloudcode-pa"));
		assert.equal(calls, 1);
	});

	it("fails instead of falling back to a shared project id", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

		await assert.rejects(
			discoverProject("token"),
			/Could not discover Cloud Code companion project ID from Google/,
		);
	});
});

describe("oauth fallback credentials warning", () => {
	beforeEach(() => {
		// Reset the once-per-process flag by capturing the original logger.
		// We cannot reset the module-level warnedAboutFallback directly,
		// so the test ensures subsequent calls still return true.
	});

	it("returns false when both env vars are set", () => {
		assert.equal(
			warnIfUsingFallbackOAuthCreds({
				ANTIGRAVITY_CLIENT_ID: "my-id",
				ANTIGRAVITY_CLIENT_SECRET: "my-secret",
			}),
			false,
		);
	});

	it("returns true and logs when env vars are missing", () => {
		const lines: string[] = [];
		const originalWarn = console.warn;
		console.warn = (line?: unknown) => lines.push(String(line));
		try {
			const result = warnIfUsingFallbackOAuthCreds({});
			assert.equal(result, true);
			assert.equal(lines.length, 1);
			assert.match(lines[0], /Using the bundled legacy OAuth client credentials/);
			assert.match(lines[0], /ANTIGRAVITY_CLIENT_ID/);
			assert.match(lines[0], /ANTIGRAVITY_CLIENT_SECRET/);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("uses the legacy client when env vars are absent", () => {
		const config = getOAuthClientConfig({});
		assert.equal(config.clientId, CLIENT_ID);
		assert.equal(config.clientSecret, CLIENT_SECRET);
	});

	it("warns only once per process even if called repeatedly", () => {
		const lines: string[] = [];
		const originalWarn = console.warn;
		console.warn = (line?: unknown) => lines.push(String(line));
		try {
			warnIfUsingFallbackOAuthCreds({});
			const firstCallLines = lines.length;
			warnIfUsingFallbackOAuthCreds({});
			warnIfUsingFallbackOAuthCreds({});
			assert.equal(lines.length, firstCallLines, "warning should not be duplicated");
			// Still returns true because fallback is in use
			assert.equal(warnIfUsingFallbackOAuthCreds({}), true);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("getOAuthClientConfig still works with env override", () => {
		const originalId = process.env.ANTIGRAVITY_CLIENT_ID;
		const originalSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
		process.env.ANTIGRAVITY_CLIENT_ID = "env-id";
		process.env.ANTIGRAVITY_CLIENT_SECRET = "env-secret";
		try {
			const cfg = getOAuthClientConfig();
			assert.equal(cfg.clientId, "env-id");
			assert.equal(cfg.clientSecret, "env-secret");
		} finally {
			if (originalId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
			else process.env.ANTIGRAVITY_CLIENT_ID = originalId;
			if (originalSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
			else process.env.ANTIGRAVITY_CLIENT_SECRET = originalSecret;
		}
	});

	it("rejects non-HTTP redirect URIs", () => {
		assert.throws(
			() => getOAuthClientConfig({
				ANTIGRAVITY_CLIENT_ID: "env-id",
				ANTIGRAVITY_CLIENT_SECRET: "env-secret",
				ANTIGRAVITY_REDIRECT_URI: "javascript:alert(1)",
			}),
			/Invalid OAuth redirect URI/,
		);
	});
});
