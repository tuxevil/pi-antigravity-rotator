import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getConfiguredAdminToken,
	getRequestAdminToken,
	isAdminAuthorized,
} from "../src/admin-auth.js";

function req(url: string, headers: Record<string, string | string[] | undefined> = {}) {
	return { url, headers };
}

describe("admin auth helpers", () => {
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
});
