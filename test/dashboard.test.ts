import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { serveDashboard } from "../src/dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function readDashboardJs(): string {
  return readFileSync(
    join(__dirname, "..", "src", "static", "dashboard.js"),
    "utf-8",
  );
}

describe("dashboard", () => {
  it("serves a complete HTML document", () => {
    const html = renderDashboard();
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>Pi Antigravity Rotator<\/title>/);
    assert.match(html, /<script src="\/static\/dashboard\.js"><\/script>/);
  });

  it("contains syntactically valid dashboard JavaScript", () => {
    const js = readDashboardJs();
    assert.ok(js.length > 0, "dashboard.js is empty");
    assert.doesNotThrow(() => new Script(js));
  });

  it("includes optional admin-token client support", () => {
    const js = readDashboardJs();
    assert.match(js, /X-Rotator-Admin-Token/);
    assert.match(js, /rotatorAdminToken/);
    assert.match(js, /authFetch/);
    assert.match(js, /authEventUrl/);
  });

  it("keeps dashboard masking controls available", () => {
    const html = renderDashboard();
    const js = readDashboardJs();
    assert.match(html, /PII: Visible/);
    assert.match(js, /function toggleMask\(\)/);
  });

  it("includes the v2 config editor controls", () => {
    const html = renderDashboard();
    const js = readDashboardJs();
    assert.match(html, /Config Editor/);
    assert.match(html, /configEditorModal/);
    assert.match(html, /routingInspectorModal/);
    assert.match(html, /Routing Inspector/);
    assert.match(js, /\/api\/config/);
    assert.match(js, /openConfigEditorModal/);
    assert.match(js, /openRoutingInspectorModal/);
    assert.match(js, /saveConfigEditor/);
    assert.match(html, /Attention Needed/);
  });

  it("declares utf-8 and responsive viewport in head", () => {
    const html = renderDashboard();
    assert.match(html, /charset="?utf-8"?/i);
    assert.match(html, /name="viewport".*content="width=device-width/i);
  });

  it("references all documented admin API endpoints", () => {
    const js = readDashboardJs();
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
      assert.match(
        js,
        new RegExp(endpoint.replace(/\//g, "\\/")),
        `missing endpoint: ${endpoint}`,
      );
    }
  });

  it("embeds the escapeHtml and jsString helpers used to defend against XSS", () => {
    const js = readDashboardJs();
    assert.match(js, /function escapeHtml\(/);
    assert.match(js, /function jsString\(/);
    assert.match(js, /function maskText\(/);
    assert.match(js, /function maskEmail\(/);
  });

  it("escapeHtml correctly escapes the five HTML-sensitive characters", () => {
    const js = readDashboardJs();
    const match = js.match(/function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/);
    assert.ok(match, "escapeHtml function not found in dashboard JS");
    const fnSrc = match[0];
    const ctx: { escapeHtml?: (s: unknown) => string } = {};
    new Function("ctx", `${fnSrc}; ctx.escapeHtml = escapeHtml;`)(ctx);
    assert.equal(
      ctx.escapeHtml!("<script>alert(1)</script>"),
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    assert.equal(ctx.escapeHtml!("a & b"), "a &amp; b");
    assert.equal(ctx.escapeHtml!('"quoted"'), "&quot;quoted&quot;");
    assert.equal(ctx.escapeHtml!("'apos'"), "&#39;apos&#39;");
    assert.equal(ctx.escapeHtml!(null), "null");
    assert.equal(ctx.escapeHtml!(42), "42");
  });

  it("jsString correctly escapes a single quote, backslash, and newlines", () => {
    const js = readDashboardJs();
    const escapeSrc = js.match(
      /function escapeHtml\([^)]*\)\s*{[\s\S]*?\n\s*\}/,
    );
    const jsStringSrc = js.match(
      /function jsString\([^)]*\)\s*{[\s\S]*?\n\s*\}/,
    );
    assert.ok(escapeSrc, "escapeHtml function not found in dashboard JS");
    assert.ok(jsStringSrc, "jsString function not found in dashboard JS");
    const ctx: { jsString?: (s: string) => string } = {};
    new Function(
      "ctx",
      `${escapeSrc[0]}\n${jsStringSrc[0]}\nctx.jsString = jsString;`,
    )(ctx);
    assert.equal(ctx.jsString!("hello"), "hello");
    assert.equal(ctx.jsString!("it's"), "it\\&#39;s");
    assert.equal(ctx.jsString!("a\\b"), "a\\\\b");
    assert.equal(ctx.jsString!("line1\nline2"), "line1\\nline2");
  });

  it("does not contain hardcoded OAuth client_id or client_secret", () => {
    const html = renderDashboard();
    assert.doesNotMatch(html, /\.apps\.googleusercontent\.com/);
    assert.doesNotMatch(html, /GOCSPX-[A-Za-z0-9_-]{20,}/);
  });

  it("does not inline any obvious secret keys (refreshToken, accessToken)", () => {
    const html = renderDashboard();
    assert.doesNotMatch(html, /refreshToken\s*[:=]\s*["']1\/\//);
    assert.doesNotMatch(html, /accessToken\s*[:=]\s*["']ya29\./);
  });
});
