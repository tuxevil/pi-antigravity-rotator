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

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Antigravity Rotator</title>
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

<div id="topNav" style="display:flex;gap:8px;margin:8px 0 2px;flex-wrap:wrap">
  <a href="/dashboard" style="padding:5px 14px;background:var(--accent);color:#fff;border-radius:4px;text-decoration:none;font-size:0.85rem;font-weight:500">Dashboard</a>
  <a id="navKeys" href="/dashboard/keys" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;color:var(--text-dim);text-decoration:none;font-size:0.85rem">Virtual Keys</a>
  <a id="navLogs" href="/dashboard/logs" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;color:var(--text-dim);text-decoration:none;font-size:0.85rem">Spend Logs</a>
</div>
<script>
(function(){
  var t = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("rotatorAdminToken");
  if (t) {
    var nk = document.getElementById("navKeys");
    var nl = document.getElementById("navLogs");
    if (nk) nk.href += "?token=" + encodeURIComponent(t);
    if (nl) nl.href += "?token=" + encodeURIComponent(t);
  }
})();
</script>

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

<div class="modal" id="attentionModal" onclick="closeModal(event, 'attentionModal')">
  <div class="modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <strong>Attention Needed</strong>
      <button class="modal-close" onclick="closeModal(null, 'attentionModal')" aria-label="Close attention modal">×</button>
    </div>
    <div id="attentionPanel"></div>
  </div>
</div>

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
          <p style="margin-bottom:10px;font-weight:bold;color:var(--accent);display:flex;align-items:center;gap:6px;font-size:0.95rem;">
            🔑 How to Donate Account Quota:
          </p>
          <ol style="margin-left:18px; margin-bottom:14px; font-size:0.85rem; color:var(--text-dim); line-height:1.5;">
            <li style="margin-bottom:4px;">Use/create a <strong>secondary or throwaway</strong> Google account.</li>
            <li style="margin-bottom:4px;">Run <code style="background:rgba(255,255,255,0.06);padding:2px 4px;border-radius:4px;font-family:monospace;font-size:0.8rem;color:var(--text);">npm run login</code> locally to authorize it.</li>
            <li style="margin-bottom:4px;">Open your local <code style="font-family:monospace;font-size:0.8rem;color:var(--text);">accounts.json</code> and copy the account's JSON block.</li>
            <li style="margin-bottom:0;">Send it to Sebastián via Email (<a href="mailto:tuxevil@dragont.ec" style="color:var(--accent);text-decoration:underline;">tuxevil@dragont.ec</a>) or Discord.</li>
          </ol>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <a href="https://github.com/tuxevil/pi-antigravity-rotator#donate-account-quota" target="_blank" class="btn-update-link" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:0.8rem;text-decoration:none;padding:6px 14px;flex:1;min-width:120px;text-align:center;">
              📖 Read Full Guide
            </a>
            <a href="https://discord.gg/GgwVqTaKgK" target="_blank" class="btn-update-link" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:0.8rem;text-decoration:none;padding:6px 14px;border-color:rgba(88,101,242,0.4);color:#5865F2;flex:1;min-width:120px;text-align:center;" onmouseover="this.style.background='rgba(88,101,242,0.08)'" onmouseout="this.style.background='transparent'">
              💬 Join Discord
            </a>
          </div>
        </div>
      </div>
      <div style="text-align: center;">
        <button class="btn-secondary" onclick="hideDonationModalPermanently()">I've supported or prefer not to see this</button>
      </div>
    </div>
  </div>
</div>

<script src="/static/dashboard.js"></script>
</body>
</html>`;

const DASHBOARD_KEYS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Virtual Keys — Pi Antigravity Rotator</title>
<link rel="stylesheet" href="/static/dashboard.css">
<style>
.mono { font-family: JetBrains Mono, monospace; font-size: 0.83rem; }
.btn-action { padding: 5px 9px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--text); font-size: 0.82rem; transition: all 0.15s ease; }
.btn-action:hover { background: var(--accent); border-color: var(--accent); color: #fff; }

/* Modal Backdrop & Card */
.modal-backdrop {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  width: 100%; height: 100%;
  background: rgba(5, 5, 12, 0.75);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  z-index: 1000;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}

.modal-card {
  background: var(--surface, #12121a);
  border: 1px solid rgba(124, 92, 252, 0.25);
  border-radius: 16px;
  width: 100%;
  max-width: 640px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7), 0 0 40px rgba(124, 92, 252, 0.12);
  animation: modalSlideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}

@keyframes modalSlideUp {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* Modal Header */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border, #1e1e2e);
  background: rgba(255, 255, 255, 0.015);
}

.modal-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.modal-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: rgba(124, 92, 252, 0.15);
  border: 1px solid rgba(124, 92, 252, 0.3);
  color: var(--accent, #7c5cfc);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.modal-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text, #e0e0e8);
  margin: 0;
}

.modal-subtitle {
  font-size: 0.78rem;
  color: var(--text-dim, #6e6e82);
  margin-top: 2px;
}

.modal-close-btn {
  background: none;
  border: none;
  color: var(--text-dim, #6e6e82);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 8px;
  transition: all 0.15s ease;
}

.modal-close-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text, #e0e0e8);
}

/* Modal Body */
.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
}

/* Form Grid */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text, #e0e0e8);
}

.form-label .req { color: var(--accent, #7c5cfc); }
.form-label .opt { font-weight: normal; color: var(--text-dim, #6e6e82); font-size: 0.75rem; }

.form-input {
  width: 100%;
  padding: 9px 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border, #1e1e2e);
  border-radius: 8px;
  color: var(--text, #e0e0e8);
  font-size: 0.88rem;
  font-family: inherit;
  transition: all 0.15s ease;
  box-sizing: border-box;
}

.form-input:focus {
  outline: none;
  border-color: var(--accent, #7c5cfc);
  box-shadow: 0 0 0 3px rgba(124, 92, 252, 0.2);
  background: rgba(0, 0, 0, 0.35);
}

.form-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Models Section */
.models-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.models-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.models-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 12px;
  background: rgba(124, 92, 252, 0.12);
  border: 1px solid rgba(124, 92, 252, 0.25);
  color: var(--accent, #7c5cfc);
  font-size: 0.72rem;
  font-weight: 500;
}

.models-actions {
  display: flex;
  gap: 6px;
}

.pill-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border, #1e1e2e);
  border-radius: 6px;
  color: var(--text-dim, #6e6e82);
  padding: 4px 10px;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.pill-btn:hover {
  background: rgba(124, 92, 252, 0.15);
  border-color: rgba(124, 92, 252, 0.4);
  color: var(--text, #e0e0e8);
}

/* Model Categories & Cards Grid */
.model-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.model-category {
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 10px;
  padding: 10px 12px;
}

.cat-title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-dim, #6e6e82);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cat-title::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #7c5cfc);
}

.cat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

/* Model Card Label */
.model-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}

.model-card:hover {
  background: rgba(124, 92, 252, 0.06);
  border-color: rgba(124, 92, 252, 0.3);
}

.model-card:has(:checked) {
  background: rgba(124, 92, 252, 0.12);
  border-color: rgba(124, 92, 252, 0.5);
}

.model-card input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--text-dim, #6e6e82);
  border-radius: 4px;
  background: transparent;
  outline: none;
  cursor: pointer;
  display: grid;
  place-content: center;
  transition: all 0.15s ease;
  margin: 0;
  flex-shrink: 0;
}

.model-card input[type="checkbox"]:checked {
  background: var(--accent, #7c5cfc);
  border-color: var(--accent, #7c5cfc);
}

.model-card input[type="checkbox"]:checked::before {
  content: "✓";
  color: #fff;
  font-size: 10px;
  font-weight: bold;
}

.model-card .model-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--text, #e0e0e8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.modal-error {
  color: var(--red, #f87171);
  margin-top: 10px;
  font-size: 0.82rem;
  font-weight: 500;
}

.generated-key-box {
  background: rgba(124, 92, 252, 0.08);
  border: 1px solid rgba(124, 92, 252, 0.3);
  border-radius: 10px;
  padding: 16px;
  margin-top: 16px;
  text-align: center;
}

.key-warn-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fbbf24;
  font-weight: 600;
  font-size: 0.85rem;
}

.generated-key-box .raw {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.05rem;
  color: var(--accent, #7c5cfc);
  word-break: break-all;
  margin: 12px 0;
  background: rgba(0, 0, 0, 0.3);
  padding: 10px;
  border-radius: 6px;
  border: 1px dashed rgba(124, 92, 252, 0.4);
}

/* Modal Footer */
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 24px;
  border-top: 1px solid var(--border, #1e1e2e);
  background: rgba(0, 0, 0, 0.2);
}

.btn-modal-cancel {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border, #1e1e2e);
  border-radius: 8px;
  color: var(--text, #e0e0e8);
  padding: 8px 16px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-modal-cancel:hover {
  background: rgba(255, 255, 255, 0.1);
}

.btn-modal-submit {
  background: linear-gradient(135deg, var(--accent, #7c5cfc), #6366f1);
  border: none;
  border-radius: 8px;
  color: #fff;
  padding: 8px 20px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(124, 92, 252, 0.3);
  transition: all 0.15s ease;
}

.btn-modal-submit:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(124, 92, 252, 0.45);
}

table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; }
td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 0.88rem; }
.nav-bar { display: flex; gap: 12px; margin-bottom: 24px; padding: 12px 16px; background: var(--bg-card); border-radius: 8px; align-items: center; flex-wrap: wrap; }
.nav-bar a { color: var(--text-dim); text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 0.9rem; }
.nav-bar a.active { background: var(--accent); color: #fff; }
.nav-bar a:hover:not(.active) { color: var(--text); }
</style>
</head>
<body>
<div class="nav-bar">
  <a id="navDashBack" href="/dashboard">&#8592; Dashboard</a>
  <a href="/dashboard/keys" class="active">Virtual Keys</a>
  <a id="navLogsSub" href="/dashboard/logs">Spend Logs</a>
</div>
<script>
(function(){
  var t = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("rotatorAdminToken");
  if (t) {
    var nd = document.getElementById("navDashBack");
    var nl = document.getElementById("navLogsSub");
    var nk = document.querySelector(".nav-bar a.active");
    if (nd) nd.href += "?token=" + encodeURIComponent(t);
    if (nl) nl.href += "?token=" + encodeURIComponent(t);
    if (nk) nk.href += "?token=" + encodeURIComponent(t);
  }
})();
</script>

<h2>Virtual Keys</h2>
<div style="display:flex; justify-content:space-between; align-items:center; margin:16px 0; flex-wrap:wrap; gap:12px">
  <span style="color:var(--text-dim); font-size:0.85rem">Manage API keys for tracking individual agent usage</span>
  <button class="btn-secondary" onclick="showGenerateModal()">+ Generate Key</button>
</div>

<table>
  <thead>
    <tr>
      <th>Alias</th><th>Key</th><th>User</th><th>Models</th><th>Status</th><th>Last Active</th><th style="width:80px">Actions</th>
    </tr>
  </thead>
  <tbody id="keysTbody"></tbody>
</table>

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

<script src="/static/dashboard-keys.js"></script>
</body>
</html>`;

const DASHBOARD_LOGS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spend Logs — Pi Antigravity Rotator</title>
<link rel="stylesheet" href="/static/dashboard.css">
<style>
.mono { font-family: JetBrains Mono, monospace; font-size: 0.8rem; }
.log-row { cursor: pointer; }
.log-row:hover { background: rgba(255,255,255,0.03); }
.log-detail td { padding: 0; }
.log-detail-content { padding: 12px 16px; background: var(--bg-card); border-left: 2px solid var(--accent); font-size: 0.85rem; }
.log-payload { max-height: 400px; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 4px; font-size: 0.78rem; white-space: pre-wrap; }
.compact-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.compact-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; }
.compact-table td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; }
td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
.filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
.filters input, .filters select { padding: 6px 10px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 0.85rem; }
.filters input { width: 150px; }
.nav-bar { display: flex; gap: 12px; margin-bottom: 24px; padding: 12px 16px; background: var(--bg-card); border-radius: 8px; align-items: center; flex-wrap: wrap; }
.nav-bar a { color: var(--text-dim); text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 0.9rem; }
.nav-bar a.active { background: var(--accent); color: #fff; }
.nav-bar a:hover:not(.active) { color: var(--text); }
</style>
</head>
<body>
<div class="nav-bar">
  <a id="navDashBack2" href="/dashboard">&#8592; Dashboard</a>
  <a id="navKeysSub" href="/dashboard/keys">Virtual Keys</a>
  <a href="/dashboard/logs" class="active">Spend Logs</a>
</div>
<script>
(function(){
  var t = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("rotatorAdminToken");
  if (t) {
    var nd = document.getElementById("navDashBack2");
    var nk = document.getElementById("navKeysSub");
    var nl = document.querySelector(".nav-bar a.active");
    if (nd) nd.href += "?token=" + encodeURIComponent(t);
    if (nk) nk.href += "?token=" + encodeURIComponent(t);
    if (nl) nl.href += "?token=" + encodeURIComponent(t);
  }
})();
</script>

<h2>Spend Logs &amp; Usage</h2>

<div id="byKeySummary"></div>

<div class="filters">
  <input id="filterKeyHash" placeholder="Key hash (10+ chars)">
  <input id="filterModel" placeholder="Model name">
  <select id="filterStatus">
    <option value="">All statuses</option>
    <option value="success">Success</option>
    <option value="failure">Failure</option>
  </select>
  <input id="filterStartDate" type="date" placeholder="From">
  <input id="filterEndDate" type="date" placeholder="To">
  <button class="btn-secondary btn-sm" onclick="applyFilters()">Apply</button>
  <button class="btn-secondary btn-sm" onclick="resetFilters()">Reset</button>
</div>

<table>
  <thead>
    <tr>
      <th>Time</th><th>Key</th><th>Model</th><th>Type</th><th>Status</th><th>Tokens (in / out)</th><th>Duration</th><th>TTFB</th><th>IP</th>
    </tr>
  </thead>
  <tbody id="logsBody"></tbody>
</table>

<div id="pagination" style="margin-top:16px;display:flex;justify-content:center;align-items:center;gap:8px;font-size:0.85rem"></div>

<script src="/static/dashboard-logs.js"></script>
</body>
</html>`;
