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
});
