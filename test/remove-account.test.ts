import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serveRemoveAccountApi } from "../src/dashboard.js";

function mockRes() {
	const state = { body: "", statusCode: 200, headers: {} as Record<string, string> };
	const res = {
		writeHead(code: number, headers?: Record<string, string>) {
			state.statusCode = code;
			if (headers) state.headers = headers;
		},
		end(chunk?: string) {
			if (chunk) state.body += chunk;
		},
	};
	return { res: res as any, state };
}

describe("serveRemoveAccountApi", () => {
	const mockRotator = {
		removeAccount: (email: string) => email === "exists@test.com",
	};

	it("returns 200 with { ok: true } when rotator.removeAccount succeeds", () => {
		const { res, state } = mockRes();
		serveRemoveAccountApi(res, mockRotator as any, "exists@test.com");
		assert.equal(state.statusCode, 200);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.email, "exists@test.com");
	});

	it("returns 400 with { ok: false } when rotator.removeAccount fails", () => {
		const { res, state } = mockRes();
		serveRemoveAccountApi(res, mockRotator as any, "noexist@test.com");
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.equal(parsed.email, "noexist@test.com");
	});

	it("sets Content-Type to application/json", () => {
		const { res, state } = mockRes();
		serveRemoveAccountApi(res, mockRotator as any, "exists@test.com");
		assert.equal(state.headers["Content-Type"], "application/json");
	});
});
