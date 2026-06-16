import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ensureAdminToken,
	generateAdminToken,
	getConfiguredAdminToken,
	getRequestAdminToken,
	isAdminAuthorized,
	readPersistedAdminToken,
	setPersistedAdminToken,
	writePersistedAdminToken,
} from "../src/admin-auth.js";

function req(url: string, headers: Record<string, string | string[] | undefined> = {}) {
	return { url, headers };
}

describe("admin auth helpers", () => {
	beforeEach(() => {
		// Reset module-level state between tests so setPersistedAdminToken from
		// one test does not leak into another.
		setPersistedAdminToken(null);
	});

	it("treats missing configured token as legacy open access", () => {
		assert.equal(getConfiguredAdminToken({}), null);
		assert.equal(isAdminAuthorized(req("/api/status"), null), true);
	});

	it("trims configured token and ignores empty values", () => {
		assert.equal(getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "  secret  " }), "secret");
		assert.equal(getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "   " }), null);
	});

	it("accepts x-rotator-admin-token header", () => {
		const request = req("/api/status", { "x-rotator-admin-token": "secret" });
		assert.equal(getRequestAdminToken(request), "secret");
		assert.equal(isAdminAuthorized(request, "secret"), true);
	});

	it("accepts bearer authorization header", () => {
		const request = req("/api/status", { authorization: "Bearer secret" });
		assert.equal(getRequestAdminToken(request), "secret");
		assert.equal(isAdminAuthorized(request, "secret"), true);
	});

	it("accepts token query parameter for browser/SSE access", () => {
		const request = req("/api/events?token=secret");
		assert.equal(getRequestAdminToken(request), "secret");
		assert.equal(isAdminAuthorized(request, "secret"), true);
	});

	it("rejects wrong token when configured", () => {
		assert.equal(isAdminAuthorized(req("/api/status?token=wrong"), "secret"), false);
	});

	it("returns persisted token after setPersistedAdminToken", () => {
		setPersistedAdminToken("persisted-secret");
		assert.equal(getConfiguredAdminToken({}), "persisted-secret");
	});

	it("env var takes priority over persisted token", () => {
		setPersistedAdminToken("persisted-secret");
		assert.equal(getConfiguredAdminToken({ PI_ROTATOR_ADMIN_TOKEN: "env-secret" }), "env-secret");
	});

	it("setPersistedAdminToken(null) clears the persisted token", () => {
		setPersistedAdminToken("persisted-secret");
		setPersistedAdminToken(null);
		assert.equal(getConfiguredAdminToken({}), null);
	});
});

describe("admin token generation and persistence", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rotator-admin-test-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("generateAdminToken returns 64 hex chars (256 bits)", () => {
		const token = generateAdminToken();
		assert.equal(token.length, 64);
		assert.match(token, /^[0-9a-f]{64}$/);
	});

	it("two consecutive tokens are different", () => {
		const a = generateAdminToken();
		const b = generateAdminToken();
		assert.notEqual(a, b);
	});

	it("writePersistedAdminToken writes a file with 0600 perms", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-perm-"));
		try {
			writePersistedAdminToken(subDir, "abc123");
			const path = join(subDir, ".admin-token");
			assert.ok(existsSync(path));
			assert.equal(readFileSync(path, "utf-8"), "abc123");
			const mode = statSync(path).mode & 0o777;
			// On non-Windows filesystems mode should be 0o600.
			// On Windows statSync returns different semantics; only assert when supported.
			if (process.platform !== "win32") {
				assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
			}
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("readPersistedAdminToken returns null when file is absent", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-absent-"));
		try {
			assert.equal(readPersistedAdminToken(subDir), null);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("readPersistedAdminToken trims whitespace", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-whitespace-"));
		try {
			const path = join(subDir, ".admin-token");
			writeFileSync(path, "  mytoken  \n", "utf-8");
			assert.equal(readPersistedAdminToken(subDir), "mytoken");
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("ensureAdminToken returns env var when present", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-env-"));
		try {
			const result = ensureAdminToken(subDir, { PI_ROTATOR_ADMIN_TOKEN: "envtok" });
			assert.equal(result.source, "env");
			assert.equal(result.token, "envtok");
			assert.equal(result.generated, false);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("ensureAdminToken reads from .admin-token when env is absent", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-file-"));
		try {
			writePersistedAdminToken(subDir, "filetok");
			const result = ensureAdminToken(subDir, {});
			assert.equal(result.source, "file");
			assert.equal(result.token, "filetok");
			assert.equal(result.generated, false);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("ensureAdminToken generates and persists a new token when neither is present", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-gen-"));
		try {
			const result = ensureAdminToken(subDir, {});
			assert.equal(result.source, "generated");
			assert.equal(result.generated, true);
			assert.equal(result.token.length, 64);
			// File should now exist and contain the same token
			assert.equal(readPersistedAdminToken(subDir), result.token);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("ensureAdminToken is idempotent: second call returns same file token", () => {
		const subDir = mkdtempSync(join(tmpdir(), "rotator-idem-"));
		try {
			const first = ensureAdminToken(subDir, {});
			const second = ensureAdminToken(subDir, {});
			assert.equal(second.source, "file");
			assert.equal(second.token, first.token);
			assert.equal(second.generated, false);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
		}
	});

	it("requireAdmin now blocks requests when only a persisted token is set", () => {
		// Simulate the runtime: ensureAdminToken -> setPersistedAdminToken
		const subDir = mkdtempSync(join(tmpdir(), "rotator-runtime-"));
		try {
			const resolved = ensureAdminToken(subDir, {});
			setPersistedAdminToken(resolved.token);
			assert.equal(isAdminAuthorized(req("/api/status")), false);
			assert.equal(isAdminAuthorized(req("/api/status", { "x-rotator-admin-token": resolved.token })), true);
		} finally {
			rmSync(subDir, { recursive: true, force: true });
			setPersistedAdminToken(null);
		}
	});

	it("OAuth callback authorization mirrors the rest of the admin surface", () => {
		// No token: callback is open (legacy behaviour).
		setPersistedAdminToken(null);
		assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), true);

		// With a token: callback requires the header.
		setPersistedAdminToken("secret-callback");
		assert.equal(isAdminAuthorized(req("/auth/antigravity/callback")), false);
		assert.equal(
			isAdminAuthorized(req("/auth/antigravity/callback", { "x-rotator-admin-token": "secret-callback" })),
			true,
		);
		assert.equal(
			isAdminAuthorized(req("/auth/antigravity/callback", { authorization: "Bearer secret-callback" })),
			true,
		);
	});
});
