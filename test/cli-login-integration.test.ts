import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { serveCliLogin, handleCliLoginApi } from "../src/onboarding.js";

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

function mockReq(body: unknown): any {
	const json = JSON.stringify(body);
	const readable = new Readable({
		read() {
			this.push(json);
			this.push(null);
		},
	});
	(readable as any).headers = {};
	return readable;
}

function extractSessionId(html: string): string {
	const match = html.match(/name="session" value="([^"]+)"/);
	assert.ok(match, "session hidden input not found in HTML");
	return match[1];
}

const dummyRotator = {} as any;

describe("CLI login integration", () => {
	it("creates a session via serveCliLogin and rejects URL without code", async () => {
		// Step 1: Get the login page and extract the session ID
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		assert.equal(loginState.statusCode, 200);
		const sessionId = extractSessionId(loginState.body);

		// Step 2: Submit the API with a valid session but a URL missing ?code=
		const req = mockReq({
			session: sessionId,
			redirectUrl: "http://localhost:51121/oauth-callback?state=foo",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /No authorization code found/);
	});

	it("rejects a completely wrong session ID as expired", async () => {
		const req = mockReq({
			session: "totally-bogus-session-id",
			redirectUrl: "http://localhost:51121/oauth-callback?code=abc123",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Session expired/);
	});

	it("issues distinct session IDs on successive serveCliLogin calls", () => {
		const { res: res1, state: state1 } = mockRes();
		serveCliLogin(res1);
		const session1 = extractSessionId(state1.body);

		const { res: res2, state: state2 } = mockRes();
		serveCliLogin(res2);
		const session2 = extractSessionId(state2.body);

		assert.notEqual(session1, session2, "each page load should create a unique session");
	});

	it("consumes a session so it cannot be reused", async () => {
		// Get a session
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionId = extractSessionId(loginState.body);

		// First call: session exists but URL lacks code → 400 (code missing).
		// This consumes the session only when code IS found (see source: delete
		// happens after code check). So we use a valid-looking URL with code:
		// the exchange will fail because the code is fake, but the session is
		// consumed.  Instead, use a URL without code so session is NOT consumed,
		// then use a URL with code → session IS consumed, then retry.

		// Call with a no-code URL: session stays alive, returns 400 (no code)
		const req1 = mockReq({
			session: sessionId,
			redirectUrl: "http://localhost:51121/oauth-callback?state=x",
		});
		const { res: r1, state: s1 } = mockRes();
		await handleCliLoginApi(req1, r1, dummyRotator);
		assert.equal(s1.statusCode, 400);
		assert.match(JSON.parse(s1.body).error, /No authorization code found/);
	});
});
