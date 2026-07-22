// Web dashboard for monitoring account rotation status

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./types.js";
import type { AccountRotator } from "./rotator.js";
import { readLimitedBody } from "./body-limit.js";
import {
  generateVirtualKey,
  listVirtualKeys,
  getVirtualKeyByHash,
  updateVirtualKey,
  deleteVirtualKey,
} from "./virtual-keys.js";
import { getSpendLogs, getDailySpendSummary, getSpendByKey } from "./spend-logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Static assets are read once at startup and served via dedicated routes.
const DASHBOARD_CSS = readFileSync(
  join(__dirname, "static", "dashboard.css"),
  "utf-8",
);
const DASHBOARD_JS = readFileSync(
  join(__dirname, "static", "dashboard.js"),
  "utf-8",
);
const DASHBOARD_KEYS_JS = readFileSync(
  join(__dirname, "static", "dashboard-keys.js"),
  "utf-8",
);
const DASHBOARD_LOGS_JS = readFileSync(
  join(__dirname, "static", "dashboard-logs.js"),
  "utf-8",
);

export function serveDashboard(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

export function serveStaticCss(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_CSS);
}

export function serveStaticJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_JS);
}

export function serveStaticKeysJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_KEYS_JS);
}

export function serveStaticLogsJs(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(DASHBOARD_LOGS_JS);
}

export function serveDashboardKeys(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_KEYS_HTML);
}

export function serveDashboardLogs(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_LOGS_HTML);
}

export function serveStatusApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(rotator.getStatus()));
}

export function serveConfigApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(rotator.getConfig()));
}

export function serveConfigExportApi(
  res: ServerResponse,
  rotator: AccountRotator,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition":
      'attachment; filename="pi-antigravity-rotator-config.json"',
  });
  res.end(JSON.stringify(rotator.getConfig(), null, 2));
}

export function serveConfigImportApi(
  res: ServerResponse,
  rotator: AccountRotator,
  config: Config,
): void {
  rotator.replaceConfig(config);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok: true, importedAccounts: config.accounts.length }),
  );
}

export function serveEnableApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): void {
  const ok = rotator.enableAccount(email);
  res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export function serveDisableApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): void {
  const ok = rotator.disableAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export function serveQuarantineApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): void {
  const ok = rotator.quarantineAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export function serveRestoreApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): void {
  const ok = rotator.restoreAccount(email);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export function serveRemoveAccountApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
): void {
  const ok = rotator.removeAccount(email);
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email }));
}

export function serveSetTierApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  tier: string,
): void {
  const ok = rotator.setAccountTier(email, tier);
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email, tier }));
}

export function serveFreshWindowStartsApi(
  res: ServerResponse,
  rotator: AccountRotator,
  enabled: boolean,
): void {
  const changed = rotator.setAllowFreshWindowStarts(enabled);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok: true, changed, allowFreshWindowStarts: enabled }),
  );
}

export function serveAccountFreshWindowStartsApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  enabled: boolean,
): void {
  const ok = rotator.setAccountAllowFreshWindowStartsOverride(email, enabled);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok, email, allowFreshWindowStartsOverride: enabled }),
  );
}

export function serveClearInFlightApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  modelKey?: string,
): void {
  const ok = rotator.clearInFlightRequests(email, modelKey);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, email, modelKey }));
}

export function serveClearBreakerApi(
  res: ServerResponse,
  rotator: AccountRotator,
  modelKey?: string,
): void {
  if (modelKey) {
    rotator.clearModelBreaker(modelKey);
  } else {
    rotator.clearAllBreakers();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

export function serveKickstartApi(
  res: ServerResponse,
  rotator: AccountRotator,
  email: string,
  modelKey?: string,
): void {
  if (modelKey) {
    rotator.kickstartTimerForAccount(email, modelKey).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    });
  } else {
    rotator.kickstartAllFreshTimers(email).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err), results: [] }));
    });
  }
}

export function serveAutoWarmupApi(
  res: ServerResponse,
  rotator: AccountRotator,
  enabled: boolean,
): void {
  const changed = rotator.setAutoWarmup(enabled);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, changed, autoWarmupEnabled: enabled }));
}

// ── Virtual Keys & Spend Logging REST API ────────────────────────────

export async function serveGenerateVirtualKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const rawBody = await readLimitedBody(req);
    const parsed = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf-8")) : {};
    if (!parsed.alias || typeof parsed.alias !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Field 'alias' is required" }));
      return;
    }
    const created = await generateVirtualKey({
      alias: parsed.alias,
      userId: parsed.userId,
      models: parsed.models,
      metadata: parsed.metadata,
      createdBy: parsed.createdBy || "admin",
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...created }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveListVirtualKeysApi(
  res: ServerResponse,
): Promise<void> {
  try {
    const keys = await listVirtualKeys();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, keys }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveGetVirtualKeyApi(
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const key = await getVirtualKeyByHash(tokenHash);
    if (!key) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, key }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveUpdateVirtualKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const rawBody = await readLimitedBody(req);
    const updates = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf-8")) : {};
    const updated = await updateVirtualKey(tokenHash, updates);
    if (!updated) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, key: updated }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveDeleteVirtualKeyApi(
  res: ServerResponse,
  tokenHash: string,
): Promise<void> {
  try {
    const deleted = await deleteVirtualKey(tokenHash);
    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Virtual key not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Virtual key deleted" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveGetSpendLogsApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const keyHash = url.searchParams.get("keyHash") || undefined;
    const model = url.searchParams.get("model") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.has("limit")
      ? parseInt(url.searchParams.get("limit")!, 10)
      : 50;
    const offset = url.searchParams.has("offset")
      ? parseInt(url.searchParams.get("offset")!, 10)
      : 0;

    const result = await getSpendLogs({
      apiKeyHash: keyHash,
      model,
      status,
      limit,
      offset,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveGetSpendSummaryApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const keyHash = url.searchParams.get("keyHash") || undefined;
    const startDate = url.searchParams.get("startDate") || undefined;
    const endDate = url.searchParams.get("endDate") || undefined;

    const summary = await getDailySpendSummary({
      apiKeyHash: keyHash,
      startDate,
      endDate,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, summary }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function serveGetSpendByKeyApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const startDate = url.searchParams.get("startDate") || undefined;
    const endDate = url.searchParams.get("endDate") || undefined;

    const byKey = await getSpendByKey({ startDate, endDate });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, byKey }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function renderAppShell(opts: {
  title: string;
  activeTab: "accounts" | "keys" | "logs";
  contentHtml: string;
  scriptSrc: string;
}): string {
  const pageTitle = opts.title === "Pi Antigravity Rotator" ? opts.title : (opts.title + " — Pi Antigravity Rotator");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>

<div class="update-banner" id="updateBanner">
  <span class="update-badge" id="updateBadgeLabel">NEW</span>
  <div class="update-message" id="updateMessage"></div>
  <div class="update-banner-actions" id="updateActions"></div>
</div>

<div class="notif-container" id="notifContainer"></div>

<div class="header">
  <div class="header-main">
    <div class="header-title-row">
      <h1>Pi Antigravity Rotator</h1>
      <span class="header-version" id="headerVersion">v--</span>
      <button id="maskBtn" class="mask-btn" onclick="toggleMask()">PII: Visible</button>
    </div>
    <div class="header-stats">
      Uptime: <span id="uptime">--</span> |
      Port: <span id="port">--</span> |
      Rotation: <span id="rotation">--</span> reqs |
      Updated: <span id="lastRefresh">--</span> |
      Requests: <span id="totalRequests">0</span>
    </div>
  </div>
  <div class="header-actions">
    <button class="header-icon-btn attention" id="attentionBtn" onclick="openModal('attentionModal')" title="Attention Needed" aria-label="Open attention needed">
      <svg viewBox="0 0 24 24"><path d="M12 8v5"/><path d="M12 17.5h.01"/><path d="M10.3 3.8 2.9 17a2 2 0 0 0 1.75 3h14.7A2 2 0 0 0 21.1 17L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
      <span class="header-icon-badge attention" id="attentionBadge" style="display:none">0</span>
    </button>

    <button class="header-icon-btn heart-beat" id="kofiBtn" onclick="openModal('donationModal')" title="Support the Creator" aria-label="Buy me a coffee">
      <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
    </button>

    <a class="header-icon-btn discord-btn" id="discordBtn" href="https://discord.gg/GgwVqTaKgK" target="_blank" title="Join our Discord" aria-label="Join Discord server">
      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
    </a>
  </div>
</div>

<div class="app-nav-bar" id="appNav">
  <a class="app-nav-tab ${opts.activeTab === "accounts" ? "active" : ""}" id="navAccounts" href="/dashboard">
    <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    Accounts
  </a>
  <a class="app-nav-tab ${opts.activeTab === "keys" ? "active" : ""}" id="navKeys" href="/dashboard/keys">
    <svg viewBox="0 0 24 24"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
    Virtual Keys
  </a>
  <a class="app-nav-tab ${opts.activeTab === "logs" ? "active" : ""}" id="navLogs" href="/dashboard/logs">
    <svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
    Spend Logs
  </a>
</div>

<script>
(function(){
  var t = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("rotatorAdminToken");
  if (t) {
    ["navAccounts", "navKeys", "navLogs"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.getAttribute("href")) {
        var base = el.getAttribute("href").split("?")[0];
        el.href = base + "?token=" + encodeURIComponent(t);
      }
    });
  }
})();
</script>

${opts.contentHtml}

<div class="modal" id="attentionModal" onclick="closeModal(event, 'attentionModal')">
  <div class="modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <strong>Attention Needed</strong>
      <button class="modal-close" onclick="closeModal(null, 'attentionModal')" aria-label="Close attention modal">×</button>
    </div>
    <div id="attentionPanel"></div>
  </div>
</div>

<div class="modal" id="donationModal" onclick="closeModal(event, 'donationModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 500px;">
    <div class="modal-header">
      <strong>Support the Creator</strong>
      <button class="modal-close" onclick="closeModal(null, 'donationModal')" aria-label="Close donation modal">×</button>
    </div>
    <div style="padding: 16px; font-size: 0.95rem; line-height: 1.5; color: var(--text);">
      <p style="margin-bottom:12px;font-weight:bold;">❤️ A quick message from Sebastián (extension creator)</p>
      <p style="margin-bottom:12px;">Hello from Ecuador! I built this tool so that everyone can access AI regardless of their budget.</p>
      <p style="margin-bottom:12px;">To be completely transparent: I'm going through a very difficult financial situation. Instead of giving up, I'm dedicating all my effort to maintaining and improving this project. If you find the extension useful, a small donation (even $1) or <strong>donating a secondary Google account to share its API quota</strong> for testing and development means the world to me right now and allows me to keep coding.</p>
      <p style="margin-bottom:16px;">If you're short on cash, I completely understand, but please keep using it for free! But if you can lend me a hand today (either financially or by donating quota), I'd be incredibly grateful:</p>
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;align-items:center;">
        <a href="https://ko-fi.com/tuxevil" target="_blank" style="display:inline-flex;flex-direction:column;align-items:center;background-color:#FF5E5B;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;transition:opacity 0.2s;width:100%;box-sizing:border-box;text-align:center;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">
          <span style="font-weight:bold;font-size:1.1rem;">☕ Buy me a coffee on Ko-fi</span>
          <span style="font-size:0.9rem;margin-top:4px;opacity:0.9;">ko-fi.com/tuxevil</span>
        </a>
        <div style="font-size:0.8rem;color:var(--text-dim);font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0;">— OR —</div>
        <div style="width:100%; padding:14px; border: 1px solid var(--border); border-radius: 8px; background: rgba(255,255,255,0.02); box-sizing: border-box; text-align: left;">
          <p style="margin-bottom:10px;font-weight:bold;color:var(--accent);display:flex;align-items:center;gap:6px;font-size:0.95rem;">🔑 How to Donate Account Quota:</p>
          <ol style="margin-left:18px; margin-bottom:14px; font-size:0.85rem; color:var(--text-dim); line-height:1.5;">
            <li style="margin-bottom:4px;">Use/create a <strong>secondary or throwaway</strong> Google account.</li>
            <li style="margin-bottom:4px;">Run <code style="background:rgba(255,255,255,0.06);padding:2px 4px;border-radius:4px;font-family:monospace;font-size:0.8rem;color:var(--text);">npm run login</code> locally to authorize it.</li>
            <li style="margin-bottom:4px;">Open your local <code style="font-family:monospace;font-size:0.8rem;color:var(--text);">accounts.json</code> and copy the account's JSON block.</li>
            <li style="margin-bottom:0;">Send it to Sebastián via Email (<a href="mailto:tuxevil@dragont.ec" style="color:var(--accent);text-decoration:underline;">tuxevil@dragont.ec</a>) or Discord.</li>
          </ol>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <a href="https://github.com/tuxevil/pi-antigravity-rotator#donate-account-quota" target="_blank" class="btn-update-link" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:0.8rem;text-decoration:none;padding:6px 14px;flex:1;min-width:120px;text-align:center;">📖 Read Full Guide</a>
            <a href="https://discord.gg/GgwVqTaKgK" target="_blank" class="btn-update-link" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:0.8rem;text-decoration:none;padding:6px 14px;border-color:rgba(88,101,242,0.4);color:#5865F2;flex:1;min-width:120px;text-align:center;">💬 Join Discord</a>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <button class="btn-secondary" onclick="hideDonationModalPermanently()">I've supported or prefer not to see this</button>
      </div>
    </div>
  </div>
</div>

<script src="${opts.scriptSrc}"></script>
</body>
</html>`;
}

const DASHBOARD_HTML = renderAppShell({
  title: "Pi Antigravity Rotator",
  activeTab: "accounts",
  scriptSrc: "/static/dashboard.js",
  contentHtml: `
<div class="view-toggle-bar">
  <button class="view-tab active" id="viewTabGrid" onclick="switchView('grid')">⊞ Grid</button>
  <button class="view-tab" id="viewTabList" onclick="switchView('list')">☰ List</button>
</div>

<div class="routing-panel state-stopped" id="routingHealth"></div>

<div class="routing-panel" id="tokenUsagePanel" style="margin-top:12px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <strong style="min-width:max-content">Token Usage</strong>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <div id="tokenTotals" style="font-family:JetBrains Mono,monospace;font-size:0.85rem;color:var(--text-dim);margin-right:12px"></div>
      <button class="btn-secondary btn-sm" onclick="exportData('csv')" title="Export CSV" style="padding:2px 6px">CSV</button>
      <button class="btn-secondary btn-sm" onclick="exportData('json')" title="Export JSON" style="padding:2px 6px;margin-right:8px">JSON</button>
      <div style="width:1px;height:16px;background:var(--border);margin-right:8px"></div>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1h')" id="tbtn-1h">1h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('2h')" id="tbtn-2h">2h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('4h')" id="tbtn-4h">4h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('8h')" id="tbtn-8h">8h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('12h')" id="tbtn-12h">12h</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1d')" id="tbtn-1d">1d</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('7d')" id="tbtn-7d">7d</button>
      <button class="btn-secondary btn-sm" onclick="setTokenView('1m')" id="tbtn-1m">1m</button>
    </div>
  </div>
  <div id="tokenChart" style="width:100%;overflow-x:auto"></div>
  <div id="tokenLegend" style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:0.8rem"></div>
</div>

<div class="routing-panel" id="latencyPanel" style="margin-top:12px;display:none">
  <strong>Latency (last 200 requests)</strong>
  <div id="latencyGrid" style="margin-top:8px"></div>
</div>

<div class="routing-panel" id="forecastPanel" style="margin-top:12px;display:none">
  <strong>Quota Forecast</strong>
  <div id="forecastGrid" style="margin-top:8px"></div>
</div>

<div class="accounts-grid" id="accounts"></div>

<div class="list-panel" id="listPanel" style="display:none">
  <div class="list-toolbar">
    <span class="list-toolbar-label">Installations</span>
    <input class="list-search" id="listSearch" placeholder="Search…" oninput="renderListView()" />
    <button class="list-sort-btn" id="lsort-requests" onclick="setListSort('requests')">Requests ↕</button>
    <button class="list-sort-btn" id="lsort-quota" onclick="setListSort('quota')">Quota ↕</button>
    <button class="list-sort-btn" id="lsort-tokens" onclick="setListSort('tokens')">Tokens ↕</button>
    <button class="list-sort-btn" id="lsort-status" onclick="setListSort('status')">Status ↕</button>
  </div>
  <div id="listTableWrap"></div>
</div>

<div class="routing-panel" id="heatmapPanel" style="margin-top:12px;display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <strong>Activity Heatmap (last 60d)</strong>
    <span style="color:var(--text-dim);font-size:0.75rem">rows: hour · cols: day</span>
  </div>
  <div id="heatmapGrid"></div>
</div>

<div class="routing-panel" id="requestLogPanel" style="margin-top:12px;display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <strong>Request Log</strong>
    <div style="display:flex;gap:6px">
      <input id="logFilterModel" placeholder="model" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:100px" />
      <input id="logFilterAccount" placeholder="account" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:100px" />
      <input id="logFilterStatus" placeholder="status" style="background:var(--card-bg);border:1px solid var(--border);color:var(--text);padding:2px 6px;border-radius:4px;font-size:0.75rem;width:60px" />
    </div>
  </div>
  <div id="requestLogGrid" style="max-height:320px;overflow-y:auto"></div>
</div>

<div class="events-panel" id="recentEventsPanel" style="display:none"></div>

<div class="modal" id="configEditorModal" onclick="closeModal(event, 'configEditorModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 960px; width: min(960px, 92vw);">
    <div class="modal-header">
      <strong>Config Editor</strong>
      <button class="modal-close" onclick="closeModal(null, 'configEditorModal')" aria-label="Close config editor modal">×</button>
    </div>
    <div style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div id="configEditorStatus" style="font-size:12px;color:var(--text-dim)"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-secondary" onclick="loadConfigEditor()">Reload</button>
          <button class="btn-secondary" onclick="saveConfigEditor()">Save</button>
          <button class="btn-secondary" onclick="exportConfig()">Export</button>
          <button class="btn-secondary" onclick="importConfigPrompt()">Import</button>
          <button class="btn-secondary" onclick="window.location.href='/login' + (ADMIN_TOKEN ? ('?token=' + encodeURIComponent(ADMIN_TOKEN)) : '')">Hosted Login</button>
        </div>
      </div>
      <textarea id="configEditor" spellcheck="false" style="width:100%;min-height:420px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px;font-family:'JetBrains Mono', monospace;font-size:12px;line-height:1.5"></textarea>
    </div>
  </div>
</div>

<div class="modal" id="routingInspectorModal" onclick="closeModal(event, 'routingInspectorModal')">
  <div class="modal-card" onclick="event.stopPropagation()" style="max-width: 1100px; width: min(1100px, 94vw);">
    <div class="modal-header">
      <strong>Routing Inspector</strong>
      <button class="modal-close" onclick="closeModal(null, 'routingInspectorModal')" aria-label="Close routing inspector modal">×</button>
    </div>
    <div id="routingInspectorPanel" style="padding:16px;"></div>
  </div>
</div>
`,
});

const DASHBOARD_KEYS_HTML = renderAppShell({
  title: "Virtual Keys",
  activeTab: "keys",
  scriptSrc: "/static/dashboard-keys.js",
  contentHtml: `
<div class="page-header-bar">
  <div class="page-title-group">
    <h2>Virtual Keys &amp; Access Control</h2>
    <p>Manage API credentials, agent assignments, and per-model authorization rules</p>
  </div>
  <button class="btn-modal-submit" onclick="showGenerateModal()" style="display:inline-flex;align-items:center;gap:8px">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    Generate Virtual Key
  </button>
</div>

<div class="stats-summary-grid">
  <div class="summary-card">
    <div class="summary-card-header">
      <span>Total Credentials</span>
      <div class="summary-card-icon">
        <svg viewBox="0 0 24 24"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statTotalKeys">0</div>
    <div class="summary-card-sub">Registered virtual keys</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Active Keys</span>
      <div class="summary-card-icon" style="background:rgba(52,211,153,0.1);color:var(--green)">
        <svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statActiveKeys" style="color:var(--green)">0</div>
    <div class="summary-card-sub">Authorized for requests</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Blocked Keys</span>
      <div class="summary-card-icon" style="background:rgba(248,113,113,0.1);color:var(--red)">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statBlockedKeys" style="color:var(--red)">0</div>
    <div class="summary-card-sub">Revoked access</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Supported Models</span>
      <div class="summary-card-icon" style="background:rgba(96,165,250,0.1);color:var(--blue)">
        <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statAvailableModels">12</div>
    <div class="summary-card-sub">Gemini, Claude, GPT-OSS</div>
  </div>
</div>

<div class="list-panel">
  <div class="list-toolbar">
    <span class="list-toolbar-label">Virtual Keys</span>
    <div class="filter-input-group" style="width:260px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <input id="keySearchInput" placeholder="Search alias, key name, user..." oninput="renderKeys()">
    </div>
    <div class="filter-input-group" style="width:140px">
      <select id="keyStatusFilter" onchange="renderKeys()">
        <option value="all">All Statuses</option>
        <option value="active">Active Only</option>
        <option value="blocked">Blocked Only</option>
      </select>
    </div>
  </div>

  <div style="overflow-x:auto">
    <table class="compact-table">
      <thead>
        <tr>
          <th>Key Alias &amp; Name</th>
          <th>User ID</th>
          <th>Allowed Models</th>
          <th>Status</th>
          <th>Last Active</th>
          <th style="width:110px;text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="keysTbody"></tbody>
    </table>
  </div>
</div>

<div id="keyModal" class="modal-backdrop">
  <div class="modal-card">
    <div class="modal-header">
      <div class="modal-title-group">
        <div class="modal-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
        </div>
        <div>
          <h3 id="modalTitle" class="modal-title">Generate Virtual Key</h3>
          <p id="modalSubtitle" class="modal-subtitle">Configure key access and model restrictions</p>
        </div>
      </div>
      <button class="modal-close-btn" onclick="hideModal()" type="button" aria-label="Close">&times;</button>
    </div>

    <div class="modal-body">
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="keyFormAlias">Key Alias <span class="req">*</span></label>
          <input id="keyFormAlias" class="form-input" placeholder="e.g. cursor-agent" autofocus>
        </div>
        <div class="form-group">
          <label class="form-label" for="keyFormUserId">User ID <span class="opt">(optional)</span></label>
          <input id="keyFormUserId" class="form-input" placeholder="e.g. seba">
        </div>
      </div>

      <div id="modelCheckboxes" class="models-section">
        <div class="models-header">
          <div>
            <span class="form-label">Allowed Models</span>
            <span class="models-badge" id="modelsCountBadge">All models allowed</span>
          </div>
          <div class="models-actions">
            <button class="pill-btn" onclick="selectAllModels()" type="button">Select All</button>
            <button class="pill-btn" onclick="selectNoModels()" type="button">Clear All</button>
          </div>
        </div>

        <div class="model-grid">
          <div class="model-category">
            <div class="cat-title">Gemini 3.1 Pro</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.1-pro-low" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.1-pro-low</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.1-pro-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.1-pro-high</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Gemini 3.5 Flash</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.5-flash-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.5-flash-medium</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.5-flash-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.5-flash-high</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3-flash" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3-flash</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Gemini 3.6 Flash</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-low" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-low</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-medium</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-high" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-high</span></label>
              <label class="model-card"><input type="checkbox" value="gemini-3.6-flash-tiered" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gemini-3.6-flash-tiered</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">Claude</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="claude-sonnet-4-6" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">claude-sonnet-4-6</span></label>
              <label class="model-card"><input type="checkbox" value="claude-opus-4-6-thinking" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">claude-opus-4-6-thinking</span></label>
            </div>
          </div>
          <div class="model-category">
            <div class="cat-title">GPT-OSS</div>
            <div class="cat-grid">
              <label class="model-card"><input type="checkbox" value="gpt-oss-120b-medium" class="modelCb" onchange="updateModelsCountBadge()"><span class="model-name">gpt-oss-120b-medium</span></label>
            </div>
          </div>
        </div>
      </div>

      <div id="keyFormError" class="modal-error"></div>

      <div id="generatedKeyResult" class="generated-key-box" style="display:none">
        <div class="key-warn-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          Save this key now — it won't be shown again!
        </div>
        <div class="raw" id="generatedRawKey"></div>
        <button id="copyKeyBtn" class="btn-secondary" onclick="copyRawKey()" style="margin-top:8px" type="button">Copy Key</button>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="hideModal()" type="button">Cancel</button>
      <button class="btn-modal-submit" onclick="submitKeyForm()" id="submitKeyBtn" type="button">Generate Key</button>
    </div>
  </div>
</div>
`,
});

const DASHBOARD_LOGS_HTML = renderAppShell({
  title: "Spend Logs",
  activeTab: "logs",
  scriptSrc: "/static/dashboard-logs.js",
  contentHtml: `
<div class="page-header-bar">
  <div class="page-title-group">
    <h2>Spend Logs &amp; Usage Analytics</h2>
    <p>Real-time audit trail of requests, prompt/completion tokens, latency metrics, and payload inspector</p>
  </div>
</div>

<div class="stats-summary-grid">
  <div class="summary-card">
    <div class="summary-card-header">
      <span>Total Requests</span>
      <div class="summary-card-icon">
        <svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogRequests">0</div>
    <div class="summary-card-sub" id="statLogRequestsSub">Logged requests</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Prompt Tokens</span>
      <div class="summary-card-icon" style="background:rgba(124,92,252,0.1);color:var(--accent)">
        <svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogPromptTokens">0</div>
    <div class="summary-card-sub">Input tokens processed</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Completion Tokens</span>
      <div class="summary-card-icon" style="background:rgba(52,211,153,0.1);color:var(--green)">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogCompletionTokens" style="color:var(--green)">0</div>
    <div class="summary-card-sub">Output tokens generated</div>
  </div>

  <div class="summary-card">
    <div class="summary-card-header">
      <span>Avg Latency</span>
      <div class="summary-card-icon" style="background:rgba(251,191,36,0.1);color:var(--yellow)">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
    </div>
    <div class="summary-card-value" id="statLogAvgLatency" style="color:var(--yellow)">--</div>
    <div class="summary-card-sub">Average round-trip duration</div>
  </div>
</div>

<div id="byKeySummary"></div>

<div class="filter-panel">
  <div class="filter-input-group" style="width:200px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
    <input id="filterKeyHash" placeholder="Key hash or alias...">
  </div>

  <div class="filter-input-group" style="width:180px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    <input id="filterModel" placeholder="Filter model name...">
  </div>

  <div class="filter-input-group" style="width:150px">
    <select id="filterStatus">
      <option value="">All Statuses</option>
      <option value="success">Success (200)</option>
      <option value="failure">Failure / Error</option>
    </select>
  </div>

  <div class="filter-input-group" style="width:150px">
    <input id="filterStartDate" type="date" title="From Date">
  </div>

  <div class="filter-input-group" style="width:150px">
    <input id="filterEndDate" type="date" title="To Date">
  </div>

  <button class="pill-btn" onclick="applyFilters()" style="background:var(--accent);color:#fff;border:none;padding:7px 14px;font-weight:600;cursor:pointer">Apply</button>
  <button class="pill-btn" onclick="resetFilters()" style="padding:7px 12px;cursor:pointer">Reset</button>
</div>

<div class="list-panel">
  <div style="overflow-x:auto">
    <table class="compact-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Key / Agent</th>
          <th>Model</th>
          <th>Call Type</th>
          <th>Status</th>
          <th>Tokens (In / Out)</th>
          <th>Duration</th>
          <th>TTFB</th>
          <th>IP</th>
        </tr>
      </thead>
      <tbody id="logsBody"></tbody>
    </table>
  </div>
</div>

<div id="pagination" style="margin-top:16px;display:flex;justify-content:center;align-items:center;gap:8px;font-size:0.85rem"></div>
`,
});
