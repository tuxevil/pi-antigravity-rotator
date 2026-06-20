import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { serveDashboard } from "../src/dashboard.js";

function renderDashboard(): string {
	let html = "";
	serveDashboard({
		writeHead() {},
		end(chunk: string) {
			html += chunk;
		},
	} as never);
	return html;
}

describe("dashboard", () => {
	it("serves a complete HTML document", () => {
		const html = renderDashboard();
		assert.match(html, /^<!DOCTYPE html>/);
		assert.match(html, /<title>Pi Antigravity Rotator<\/title>/);
		assert.match(html, /<script>/);
	});

	it("contains syntactically valid dashboard JavaScript", () => {
		const html = renderDashboard();
		const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
		assert.ok(script, "dashboard script not found");
		assert.doesNotThrow(() => new Script(script));
	});

	it("includes optional admin-token client support", () => {
		const html = renderDashboard();
		assert.match(html, /X-Rotator-Admin-Token/);
		assert.match(html, /rotatorAdminToken/);
		assert.match(html, /authFetch/);
		assert.match(html, /authEventUrl/);
	});

	it("keeps dashboard masking controls available", () => {
		const html = renderDashboard();
		assert.match(html, /PII: Visible/);
		assert.match(html, /function toggleMask\(\)/);
	});

	it("includes the v2 config editor controls", () => {
		const html = renderDashboard();
		assert.match(html, /Config Editor/);
		assert.match(html, /configEditorModal/);
		assert.match(html, /routingInspectorModal/);
		assert.match(html, /Routing Inspector/);
		assert.match(html, /\/api\/config/);
		assert.match(html, /openConfigEditorModal/);
		assert.match(html, /openRoutingInspectorModal/);
		assert.match(html, /saveConfigEditor/);
		assert.match(html, /Attention Needed/);
	});

	it("declares utf-8 and responsive viewport in head", () => {
		const html = renderDashboard();
		assert.match(html, /charset="?utf-8"?/i);
		assert.match(html, /name="viewport".*content="width=device-width/i);
	});

	it("references all documented admin API endpoints", () => {
		const html = renderDashboard();
		const endpoints = [
			"/api/status",
			"/api/config",
			"/api/events",
			"/api/enable/",
			"/api/disable/",
			"/api/quarantine/",
			"/api/restore/",
			"/api/clear-inflight/",
			"/api/clear-breaker/",
			"/api/settings/fresh-window-starts/",
			"/api/account-fresh-window-starts/",
			"/api/self-update",
		];
		for (const endpoint of endpoints) {
			assert.match(html, new RegExp(endpoint.replace(/\//g, "\\/")), `missing endpoint: ${endpoint}`);
		}
	});

	it("embeds the escapeHtml and jsString helpers used to defend against XSS", () => {
		const html = renderDashboard();
		assert.match(html, /function escapeHtml\(/);
		assert.match(html, /function jsString\(/);
		assert.match(html, /function maskText\(/);
		assert.match(html, /function maskEmail\(/);
	});

	it("escapeHtml correctly escapes the five HTML-sensitive characters", () => {
		const html = renderDashboard();
		const match = html.match(/function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/);
		assert.ok(match, "escapeHtml function not found in dashboard script");
		const fnSrc = match[0];
		// Re-execute the function source in an isolated context to verify behavior.
		const ctx: { escapeHtml?: (s: unknown) => string } = {};
		new Function("ctx", `${fnSrc}; ctx.escapeHtml = escapeHtml;`)(ctx);
		assert.equal(ctx.escapeHtml!("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
		assert.equal(ctx.escapeHtml!("a & b"), "a &amp; b");
		assert.equal(ctx.escapeHtml!('"quoted"'), "&quot;quoted&quot;");
		assert.equal(ctx.escapeHtml!("'apos'"), "&#39;apos&#39;");
		assert.equal(ctx.escapeHtml!(null), "null");
		assert.equal(ctx.escapeHtml!(42), "42");
	});

	it("jsString correctly escapes a single quote, backslash, and newlines", () => {
		const html = renderDashboard();
		// jsString depends on escapeHtml, so include both in the test sandbox.
		const escapeSrc = html.match(/function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/);
		const jsStringSrc = html.match(/function jsString\([^)]*\)\s*{[\s\S]*?\n\s*\}/);
		assert.ok(escapeSrc, "escapeHtml function not found in dashboard script");
		assert.ok(jsStringSrc, "jsString function not found in dashboard script");
		const ctx: { jsString?: (s: string) => string } = {};
		new Function("ctx", `${escapeSrc[0]}\n${jsStringSrc[0]}\nctx.jsString = jsString;`)(ctx);
		assert.equal(ctx.jsString!("hello"), "hello");
		assert.equal(ctx.jsString!("it's"), "it\\&#39;s");
		assert.equal(ctx.jsString!("a\\b"), "a\\\\b");
		assert.equal(ctx.jsString!("line1\nline2"), "line1\\nline2");
	});

	it("does not contain hardcoded OAuth client_id or client_secret", () => {
		const html = renderDashboard();
		// Public Antigravity client_id is .apps.googleusercontent.com
		assert.doesNotMatch(html, /\.apps\.googleusercontent\.com/);
		// client_secret format
		assert.doesNotMatch(html, /GOCSPX-[A-Za-z0-9_-]{20,}/);
	});

	it("does not inline any obvious secret keys (refreshToken, accessToken)", () => {
		const html = renderDashboard();
		assert.doesNotMatch(html, /refreshToken\s*[:=]\s*["']1\/\//);
		assert.doesNotMatch(html, /accessToken\s*[:=]\s*["']ya29\./);
	});
});
