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

function mockReqRaw(raw: string): any {
	const readable = new Readable({
		read() {
			this.push(raw);
			this.push(null);
		},
	});
	(readable as any).headers = {};
	return readable;
}

const dummyRotator = {} as any;

describe("serveCliLogin", () => {
	it("serves a complete HTML document", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<!DOCTYPE html>/);
		assert.equal(state.statusCode, 200);
	});

	it("contains a form with id pasteForm", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<form id="pasteForm"/);
	});

	it("includes a session hidden input", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<input type="hidden" name="session" value="[^"]+"/);
	});

	it("includes a Sign in with Google link", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /Sign in with Google/);
	});

	it("contains the authUrl in the CTA link", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		// The CTA link should contain an href pointing to the OAuth URL
		assert.match(state.body, /<a class="cta" href="[^"]+"/);
	});

	it("includes a textarea for pasting the redirect URL", () => {
		const { res, state } = mockRes();
		serveCliLogin(res);
		assert.match(state.body, /<textarea name="redirectUrl"/);
	});
});

describe("handleCliLoginApi", () => {
	it("returns 400 for invalid JSON body", async () => {
		const req = mockReqRaw("not json{{{");
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Invalid JSON body/);
	});

	it("returns 400 for missing session", async () => {
		const req = mockReq({ redirectUrl: "http://localhost/callback?code=abc" });
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Missing session or redirectUrl/);
	});

	it("returns 400 for missing redirectUrl", async () => {
		const req = mockReq({ session: "some-session-id" });
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Missing session or redirectUrl/);
	});

	it("returns 400 for expired/invalid session", async () => {
		const req = mockReq({
			session: "nonexistent-session-id",
			redirectUrl: "http://localhost/callback?code=abc",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Session expired or invalid/);
	});

	it("returns 400 when no authorization code found in the URL", async () => {
		// First, create a real session via serveCliLogin
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionMatch = loginState.body.match(/name="session" value="([^"]+)"/);
		assert.ok(sessionMatch, "session hidden input not found in HTML");
		const sessionId = sessionMatch[1];

		// Use a URL with no code parameter
		const req = mockReq({
			session: sessionId,
			redirectUrl: "http://localhost:51121/oauth-callback?state=abc",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /No authorization code found/);
	});

	it("returns 400 for an unparseable redirect URL", async () => {
		// Create a valid session first
		const { res: loginRes, state: loginState } = mockRes();
		serveCliLogin(loginRes);
		const sessionMatch = loginState.body.match(/name="session" value="([^"]+)"/);
		assert.ok(sessionMatch);
		const sessionId = sessionMatch[1];

		const req = mockReq({
			session: sessionId,
			redirectUrl: "not a valid url at all",
		});
		const { res, state } = mockRes();
		await handleCliLoginApi(req, res, dummyRotator);
		assert.equal(state.statusCode, 400);
		const parsed = JSON.parse(state.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /Could not parse the URL/);
	});
});
