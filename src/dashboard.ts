// Web dashboard for monitoring account rotation status

import type { ServerResponse } from "node:http";
import type { AccountRotator } from "./rotator.js";

export function serveDashboard(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(DASHBOARD_HTML);
}

export function serveStatusApi(res: ServerResponse, rotator: AccountRotator): void {
	res.writeHead(200, {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
	});
	res.end(JSON.stringify(rotator.getStatus()));
}

export function serveEnableApi(res: ServerResponse, rotator: AccountRotator, email: string): void {
	const ok = rotator.enableAccount(email);
	res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok, email }));
}

export function serveFreshWindowStartsApi(res: ServerResponse, rotator: AccountRotator, enabled: boolean): void {
	const changed = rotator.setAllowFreshWindowStarts(enabled);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true, changed, allowFreshWindowStarts: enabled }));
}

export function serveAccountFreshWindowStartsApi(
	res: ServerResponse,
	rotator: AccountRotator,
	email: string,
	enabled: boolean,
): void {
	const ok = rotator.setAccountAllowFreshWindowStartsOverride(email, enabled);
	res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok, email, allowFreshWindowStartsOverride: enabled }));
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Antigravity Rotator</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a25;
    --border: #1e1e2e;
    --text: #e0e0e8;
    --text-dim: #6e6e82;
    --accent: #7c5cfc;
    --accent-glow: rgba(124, 92, 252, 0.15);
    --green: #34d399;
    --yellow: #fbbf24;
    --red: #f87171;
    --blue: #60a5fa;
    --orange: #fb923c;
    --radius: 12px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    min-height: 100vh;
    padding: 24px;
  }

  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }

  .header-main {
    min-width: 0;
    flex: 1;
  }

  .header h1 {
    font-size: 22px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }

  .header-stats {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--text-dim);
  }

  .header-stats span {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text);
    font-weight: 500;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .header-icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.03);
    color: var(--text-dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    position: relative;
    transition: border-color 0.2s, background 0.2s, color 0.2s, transform 0.2s;
  }

  .header-icon-btn:hover {
    border-color: #35354b;
    background: rgba(255,255,255,0.06);
    color: var(--text);
    transform: translateY(-1px);
  }

  .header-icon-btn svg {
    width: 18px;
    height: 18px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.8;
  }

  .header-icon-btn.attention.has-items {
    color: var(--yellow);
    border-color: rgba(251, 191, 36, 0.4);
  }

  .header-icon-btn.advisor.has-items {
    color: var(--accent);
    border-color: rgba(124, 92, 252, 0.42);
  }

  .header-icon-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 18px;
    height: 18px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    color: #fff;
    background: var(--red);
    border: 2px solid var(--bg);
  }

  .header-icon-badge.attention { background: var(--yellow); color: #17120a; }
  .header-icon-badge.advisor { background: var(--accent); }

  .header-route-list {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    max-width: 100%;
  }

  .header-route-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 220px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.03);
    font-size: 11px;
  }

  .header-route-pill .model-name {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
  }

  .header-route-pill .route-arrow {
    color: var(--text-dim);
  }

  .header-route-pill .account-name {
    color: var(--accent);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }

  .header-route-empty {
    font-size: 11px;
    color: var(--text-dim);
  }

  .accounts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 14px;
  }

  .account-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    transition: border-color 0.2s, box-shadow 0.2s;
    position: relative;
    overflow: hidden;
  }

  .account-card:hover { border-color: #2a2a3e; }
  .account-card.active { border-color: var(--accent); box-shadow: 0 0 20px var(--accent-glow); }
  .account-card.cooldown { border-color: rgba(251, 191, 36, 0.3); }
  .account-card.disabled { opacity: 0.5; }
  .account-card.flagged { opacity: 0.6; border-color: rgba(255, 68, 68, 0.4); }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .card-label {
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
  }

  .card-badges { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  .badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 6px;
    white-space: nowrap;
  }

  .badge-active { background: rgba(52, 211, 153, 0.15); color: var(--green); }
  .badge-ready { background: rgba(110, 110, 130, 0.1); color: var(--text-dim); }
  .badge-cooldown { background: rgba(251, 191, 36, 0.15); color: var(--yellow); }
  .badge-exhausted { background: rgba(248, 113, 113, 0.15); color: var(--red); }
  .badge-disabled { background: rgba(248, 113, 113, 0.1); color: #888; }
  .badge-error { background: rgba(251, 146, 60, 0.15); color: var(--orange); }
  .badge-flagged { background: rgba(248, 113, 113, 0.25); color: #ff4444; font-weight: 700; }
  .badge-model { background: rgba(124, 92, 252, 0.1); color: var(--accent); }

  .card-email {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 12px;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .card-stat { font-size: 12px; }
  .card-stat .stat-label { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-stat .stat-value { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 13px; margin-top: 2px; }

  .card-error {
    margin-top: 10px;
    padding: 8px 10px;
    background: rgba(248, 113, 113, 0.08);
    border-radius: 8px;
    font-size: 11px;
    color: var(--red);
    font-family: 'JetBrains Mono', monospace;
    word-break: break-all;
  }

  .card-hint {
    margin-top: 6px;
    padding: 8px 10px;
    background: rgba(250, 204, 21, 0.08);
    border-radius: 8px;
    border-left: 3px solid var(--yellow);
    font-size: 11px;
    color: var(--yellow);
    line-height: 1.4;
  }

  .card-actions { margin-top: 10px; display: flex; gap: 8px; }

  .btn-enable {
    font-size: 11px;
    padding: 4px 12px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--font);
    font-weight: 500;
    transition: background 0.2s;
  }
  .btn-enable:hover { background: var(--accent-glow); }

  .cooldown-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--yellow), var(--orange));
    transition: width 1s linear;
    border-radius: 0 3px 0 0;
  }

  .quota-section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }

  .quota-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }

  .quota-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }

  .quota-model {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-dim);
    width: 52px;
    flex-shrink: 0;
  }

  .quota-timer {
    font-size: 9px;
    font-family: 'JetBrains Mono', monospace;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .timer-fresh { background: rgba(52, 211, 153, 0.1); color: var(--green); }
  .timer-7d { background: rgba(96, 165, 250, 0.1); color: var(--blue); }
  .timer-5h { background: rgba(251, 191, 36, 0.1); color: var(--yellow); }

  .quota-bar-bg {
    flex: 1;
    height: 8px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    overflow: hidden;
  }

  .quota-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
  }

  .quota-pct {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    width: 36px;
    text-align: right;
    flex-shrink: 0;
  }

  .quota-reset {
    font-size: 9px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-dim);
    width: 55px;
    text-align: right;
    flex-shrink: 0;
  }

  .pulse { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .badge-pro { background: rgba(52, 211, 153, 0.15); color: var(--green); }
  .badge-free { background: rgba(110, 110, 130, 0.08); color: var(--text-dim); }
  .badge-fmgr { background: rgba(124, 92, 252, 0.15); color: var(--accent); font-size: 9px; }

  .advisor-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 24px;
  }

  .advisor-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .advisor-slots {
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text);
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }

  .advisor-action {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    margin-bottom: 6px;
    border-radius: 8px;
    font-size: 12px;
  }

  .advisor-action.add-pro {
    background: rgba(52, 211, 153, 0.06);
    border-left: 3px solid var(--green);
  }

  .advisor-action.remove-pro {
    background: rgba(251, 191, 36, 0.06);
    border-left: 3px solid var(--yellow);
  }

  .advisor-action-type {
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .advisor-action.add-pro .advisor-action-type {
    background: rgba(52, 211, 153, 0.15);
    color: var(--green);
  }

  .advisor-action.remove-pro .advisor-action-type {
    background: rgba(251, 191, 36, 0.15);
    color: var(--yellow);
  }

  .advisor-action-label { font-weight: 500; }
  .advisor-action-reason { color: var(--text-dim); font-size: 11px; margin-left: auto; }
  .advisor-empty { color: var(--text-dim); font-size: 12px; font-style: italic; }
  .routing-panel {
    border-radius: var(--radius);
    padding: 12px 14px;
    margin-bottom: 24px;
  }
  .routing-panel strong { display: inline-block; margin-right: 10px; }
  .routing-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 8px;
  }
  .routing-summary div {
    font-size: 12px;
    color: var(--text);
  }
  .routing-inline-note {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-dim);
    font-size: 11px;
  }
  .routing-panel.state-healthy {
    background: rgba(52, 211, 153, 0.08);
    border: 1px solid rgba(52, 211, 153, 0.24);
    border-left: 4px solid var(--green);
  }
  .routing-panel.state-healthy strong { color: var(--green); }
  .routing-panel.state-cooldown_wait {
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.24);
    border-left: 4px solid var(--yellow);
  }
  .routing-panel.state-cooldown_wait strong { color: var(--yellow); }
  .routing-panel.state-busy {
    background: rgba(96, 165, 250, 0.08);
    border: 1px solid rgba(96, 165, 250, 0.24);
    border-left: 4px solid var(--blue);
  }
  .routing-panel.state-busy strong { color: var(--blue); }
  .routing-panel.state-paused,
  .routing-panel.state-stopped {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-left: 4px solid var(--red);
  }
  .routing-panel.state-paused strong,
  .routing-panel.state-stopped strong { color: var(--red); }
  .ops-buttons { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .ops-warning { margin-top:8px; font-size:10px; color: var(--text-dim); line-height:1.35; }
  .btn-secondary {
    font-size: 11px;
    padding: 4px 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--font);
    font-weight: 500;
  }
  .health-grid {
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
    gap: 6px;
    margin-top: 8px;
  }
  .health-pill {
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }
  .health-pill .label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .health-pill .value {
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    margin-top: 3px;
  }
  .operator-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 24px;
  }
  .operator-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    margin-bottom: 10px;
  }
  .operator-list {
    display: grid;
    gap: 8px;
  }
  .operator-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
  }
  .operator-item strong {
    display: block;
    font-size: 12px;
    margin-bottom: 2px;
  }
  .operator-item span {
    display: block;
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.45;
  }
  .operator-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .events-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 24px;
  }
  .events-list {
    display: grid;
    gap: 8px;
  }
  .events-toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .event-filter {
    font-size: 11px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    border-radius: 999px;
    cursor: pointer;
    font-family: var(--font);
    font-weight: 600;
  }
  .event-filter.active {
    background: rgba(124, 92, 252, 0.14);
    border-color: rgba(124, 92, 252, 0.28);
    color: var(--text);
  }
  .event-item {
    display: grid;
    grid-template-columns: 90px 56px 1fr;
    gap: 10px;
    align-items: start;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
  }
  .event-item.level-warn {
    border-color: rgba(251, 191, 36, 0.22);
  }
  .event-item.level-error {
    border-color: rgba(248, 113, 113, 0.22);
  }
  .event-time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .event-source {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 999px;
    text-align: center;
  }
  .event-source.rotator {
    background: rgba(124, 92, 252, 0.14);
    color: var(--accent);
  }
  .event-source.proxy {
    background: rgba(96, 165, 250, 0.14);
    color: var(--blue);
  }
  .event-message {
    font-size: 12px;
    line-height: 1.45;
    color: var(--text);
    word-break: break-word;
  }
  .events-empty {
    font-size: 12px;
    color: var(--text-dim);
    padding: 10px 2px 2px;
  }
  .modal {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(5, 5, 10, 0.72);
    backdrop-filter: blur(10px);
    z-index: 50;
  }
  .modal.open { display: flex; }
  .modal-card {
    width: min(820px, 100%);
    max-height: min(78vh, 920px);
    overflow: auto;
    background: linear-gradient(180deg, rgba(20,20,31,0.98), rgba(14,14,22,0.98));
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;
    box-shadow: 0 28px 120px rgba(0,0,0,0.45);
    padding: 18px;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .modal-header strong {
    font-size: 14px;
    letter-spacing: 0.02em;
  }
  .modal-close {
    width: 34px;
    height: 34px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }
  .modal-close:hover {
    color: var(--text);
    border-color: #35354b;
  }
  .modal-empty {
    font-size: 12px;
    color: var(--text-dim);
    padding: 8px 2px 2px;
  }
  @media (max-width: 820px) {
    body { padding: 18px; }
    .header { flex-direction: column; align-items: stretch; }
    .header-actions { justify-content: flex-start; }
    .header-route-list { width: 100%; }
    .header-route-pill { max-width: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-main">
    <h1>Pi Antigravity Rotator</h1>
    <div class="header-stats">
      Uptime: <span id="uptime">--</span> |
      Port: <span id="port">--</span> |
      Rotation: <span id="rotation">--</span> reqs |
      Updated: <span id="lastRefresh">--</span> |
      Requests: <span id="totalRequests">0</span> |
      Routing: <span id="modelRoutingSummary" class="header-route-list"><span class="header-route-empty">No model assignments yet.</span></span> |
      <button id="maskBtn" onclick="toggleMask()" style="background:none;border:1px solid var(--border);color:var(--text-dim);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit;">PII: Visible</button>
    </div>
  </div>
  <div class="header-actions">
    <button class="header-icon-btn attention" id="attentionBtn" onclick="openModal('attentionModal')" title="Attention Needed" aria-label="Open attention needed">
      <svg viewBox="0 0 24 24"><path d="M12 8v5"/><path d="M12 17.5h.01"/><path d="M10.3 3.8 2.9 17a2 2 0 0 0 1.75 3h14.7A2 2 0 0 0 21.1 17L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
      <span class="header-icon-badge attention" id="attentionBadge" style="display:none">0</span>
    </button>
    <button class="header-icon-btn advisor" id="advisorBtn" onclick="openModal('advisorModal')" title="Pro Family Advisor" aria-label="Open Pro Family Advisor">
      <svg viewBox="0 0 24 24"><path d="m5 15 2-9 5 5 5-5 2 9"/><path d="M4 19h16"/></svg>
      <span class="header-icon-badge advisor" id="advisorBadge" style="display:none">0</span>
    </button>
  </div>
</div>

<div class="routing-panel state-stopped" id="routingHealth"></div>

<div class="accounts-grid" id="accounts"></div>

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

<div class="modal" id="advisorModal" onclick="closeModal(event, 'advisorModal')">
  <div class="modal-card" onclick="event.stopPropagation()">
    <div class="modal-header">
      <strong>Pro Family Advisor</strong>
      <button class="modal-close" onclick="closeModal(null, 'advisorModal')" aria-label="Close advisor modal">×</button>
    </div>
    <div id="proAdvisor"></div>
  </div>
</div>

<script>
function formatDuration(ms) {
  if (ms <= 0) return '--';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  var d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

function formatTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleTimeString();
}

function quotaBarColor(pct) {
  if (pct >= 60) return 'var(--green)';
  if (pct >= 30) return 'var(--yellow)';
  return 'var(--red)';
}

function timerDisplayLabel(timerType) {
  return timerType === 'fresh' ? 'idle' : timerType;
}

function renderQuotaBars(quota) {
  if (!quota || quota.length === 0) return '';
  var rows = quota.map(function(q) {
    var color = quotaBarColor(q.percentRemaining);
    var timerClass = 'timer-' + q.timerType;
    var resetLabel = '';
    if (q.resetTime && q.timerType !== 'fresh') {
      var remaining = new Date(q.resetTime).getTime() - Date.now();
      if (remaining > 0) resetLabel = formatDuration(remaining);
    }
    return '<div class="quota-row">' +
      '<span class="quota-model">' + q.displayName + '</span>' +
      '<span class="quota-timer ' + timerClass + '">' + timerDisplayLabel(q.timerType) + '</span>' +
      '<div class="quota-bar-bg"><div class="quota-bar-fill" style="width:' + q.percentRemaining + '%;background:' + color + '"></div></div>' +
      '<span class="quota-pct" style="color:' + color + '">' + q.percentRemaining + '%</span>' +
      '<span class="quota-reset">' + (resetLabel || '--') + '</span>' +
    '</div>';
  }).join('');
  return '<div class="quota-section"><div class="quota-section-title">Quota (per model)</div>' + rows + '</div>';
}

function renderModelRouting(activeAccounts) {
  var container = document.getElementById('modelRoutingSummary');
  var entries = Object.entries(activeAccounts || {});
  if (entries.length === 0) {
    container.innerHTML = '<span class="header-route-empty">No model assignments yet.</span>';
    return;
  }
  function compactModelName(name) {
    if (name.indexOf('gemini-3.1-pro') >= 0 || name.indexOf('gemini-3-pro') >= 0) return 'G3Pro';
    if (name.indexOf('gemini-3-flash') >= 0) return 'G3Flash';
    if (name.indexOf('claude') >= 0) return 'Claude';
    return name;
  }
  var rows = entries.map(function(e) {
    return '<span class="header-route-pill">' +
      '<span class="model-name">' + compactModelName(e[0]) + '</span>' +
      '<span class="route-arrow">-></span>' +
      '<span class="account-name">' + maskText(e[1]) + '</span>' +
    '</span>';
  }).join('');
  container.innerHTML = rows;
}

function renderAccounts(data) {
  var now = Date.now();
  document.getElementById('uptime').textContent = formatDuration(data.uptime);
  document.getElementById('port').textContent = data.proxyPort;
  document.getElementById('rotation').textContent = data.requestsPerRotation;
  document.getElementById('lastRefresh').textContent = new Date(now).toLocaleTimeString();
  document.getElementById('totalRequests').textContent = data.totalRequestsAllAccounts;

  var routingHealth = document.getElementById('routingHealth');
  var health = data.routingHealth || {};
  var controls = data.operatorControls || {};
  var state = health.state || 'stopped';
  var stateColor = {
    healthy: 'var(--green)',
    paused: 'var(--red)',
    cooldown_wait: 'var(--yellow)',
    busy: 'var(--blue)',
    stopped: 'var(--red)'
  }[state];
  routingHealth.className = 'routing-panel state-' + state;
  var nextRetry = health.nextRetryIn > 0 ? '<div style="margin-top:6px;">Next retry window: <span style="font-family:JetBrains Mono, monospace;">' + formatDuration(health.nextRetryIn) + '</span></div>' : '';
  var pauseWindow = data.protectivePauseRemaining > 0
    ? '<div style="margin-top:6px;">Protective pause: <span style="font-family:JetBrains Mono, monospace;">' + formatDuration(data.protectivePauseRemaining) + '</span> remaining</div>'
    : '';
  var freshPolicy = controls.allowFreshWindowStarts
    ? '<div style="margin-top:6px;">Fresh windows: <span style="font-family:JetBrains Mono, monospace;color:var(--green)">allowed</span></div>'
    : '<div style="margin-top:6px;">Fresh windows: <span style="font-family:JetBrains Mono, monospace;color:var(--yellow)">blocked</span></div>';
  var freshPolicyHint = controls.allowFreshWindowStarts
    ? 'The rotator may start fresh windows when they are the best available option.'
    : 'Fresh windows are being held back. Timed 5h buckets still win first, timed 7d buckets still run, but the rotator will not open fresh windows until you re-enable them.';
  var healthGrid =
    '<div class="health-grid">' +
      renderHealthPill('Available', health.availableCount || 0) +
      renderHealthPill('Active', health.activeCount || 0) +
      renderHealthPill('Ready', health.readyCount || 0) +
      renderHealthPill('Cooldown', health.cooldownCount || 0) +
      renderHealthPill('Busy', health.busyCount || 0) +
      renderHealthPill('Flagged', health.flaggedCount || 0) +
      renderHealthPill('Disabled', health.disabledCount || 0) +
      renderHealthPill('Error', health.errorCount || 0) +
    '</div>';
  routingHealth.innerHTML =
    '<div class="routing-summary">' +
      '<strong style="color:' + stateColor + '">Routing: ' + String(health.state || 'unknown').replace(/_/g, ' ') + '</strong>' +
      '<div>' + (health.reason || 'No routing health information available') + '</div>' +
      (nextRetry ? '<div>' + nextRetry.replace('<div style="margin-top:6px;">', '').replace('</div>', '') + '</div>' : '') +
      (pauseWindow ? '<div>' + pauseWindow.replace('<div style="margin-top:6px;">', '').replace('</div>', '') + '</div>' : '') +
      '<div class="routing-inline-note">' + freshPolicy.replace('<div style="margin-top:6px;">', '').replace('</div>', '') + '</div>' +
    '</div>' +
    (data.protectivePauseReason && data.protectivePauseRemaining > 0 ? '<div style="margin-top:6px;color:var(--text-dim);font-family:JetBrains Mono, monospace;">' + data.protectivePauseReason.slice(0, 220) + '</div>' : '') +
    healthGrid +
    '<div class="ops-buttons">' +
      '<button class="btn-secondary" onclick="refresh()">Refresh</button>' +
      '<button class="btn-secondary" onclick="setFreshWindowStarts(' + (!controls.allowFreshWindowStarts) + ')">' +
        (controls.allowFreshWindowStarts ? 'Block Fresh Windows' : 'Allow Fresh Windows') +
      '</button>' +
    '</div>' +
    '<div class="ops-warning">' + freshPolicyHint + '</div>';

  renderModelRouting(data.activeAccounts);
  renderAttentionPanel(data);
  renderRecentEvents(data.recentEvents);

  var container = document.getElementById('accounts');
  var sorted = data.accounts.slice().sort(function(a, b) {
    var aFlagged = a.status === 'flagged' || a.status === 'disabled' ? 1 : 0;
    var bFlagged = b.status === 'flagged' || b.status === 'disabled' ? 1 : 0;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    var aQuota = (a.quota || []).reduce(function(s, q) { return s + q.percentRemaining; }, 0);
    var bQuota = (b.quota || []).reduce(function(s, q) { return s + q.percentRemaining; }, 0);
    return bQuota - aQuota;
  });
  container.innerHTML = sorted.map(function(a) {
    var isActive = a.status === 'active';
    var isCooldown = a.status === 'cooldown' || a.status === 'exhausted';
    var cooldownPercent = 0;
    if (isCooldown && a.cooldownRemaining > 0) {
      var totalCooldown = a.cooldownUntil - (a.lastUsed || now);
      cooldownPercent = Math.max(0, Math.min(100, (a.cooldownRemaining / Math.max(totalCooldown, 1)) * 100));
    }

    var modelBadges = (a.activeForModels || []).map(function(m) {
      return '<span class="badge badge-model">' + m.split('-').slice(0, 2).join('-') + '</span>';
    }).join('');

    return '<div class="account-card ' + a.status + '">' +
      '<div class="card-header">' +
        '<div class="card-label">' + maskText(a.label) + '</div>' +
        '<div class="card-badges">' +
          (a.proDetected ? '<span class="badge badge-pro">PRO</span>' : '<span class="badge badge-free">FREE</span>') +
          (a.familyManager ? '<span class="badge badge-fmgr">FAMILY MGR</span>' : '') +
          '<span class="badge badge-' + a.status + (isActive ? ' pulse' : '') + '">' + a.status + '</span>' +
          modelBadges +
        '</div>' +
      '</div>' +
      '<div class="card-email">' + maskEmail(a.email) + '</div>' +
      (a.quota && a.quota.length > 0 ? renderQuotaBars(a.quota) : '') +
      '<div class="card-stats">' +
        '<div class="card-stat"><div class="stat-label">Requests</div><div class="stat-value">' +
          a.requestsSinceRotation + ' / ' + a.totalRequests + ' total</div></div>' +
        '<div class="card-stat"><div class="stat-label">Last Used</div><div class="stat-value">' +
          (a.lastUsed ? formatTime(a.lastUsed) : '--') + '</div></div>' +
        (isCooldown ? '<div class="card-stat"><div class="stat-label">Cooldown</div><div class="stat-value" style="color:var(--yellow)">' +
          formatDuration(a.cooldownRemaining) + '</div></div>' : '') +
        (a.inFlightRequests > 0 ? '<div class="card-stat"><div class="stat-label">In Flight</div><div class="stat-value" style="color:var(--blue)">' +
          a.inFlightRequests + '</div></div>' : '') +
        '<div class="card-stat"><div class="stat-label">Token</div><div class="stat-value" style="color:' +
          (a.hasValidToken ? 'var(--green)' : 'var(--text-dim)') + '">' +
          (a.hasValidToken ? 'Valid' : 'Expired') + '</div></div>' +
        '<div class="card-stat"><div class="stat-label">Fresh Policy</div><div class="stat-value" style="color:' +
          (a.effectiveFreshWindowStartsAllowed ? 'var(--green)' : 'var(--yellow)') + '">' +
          (a.allowFreshWindowStartsOverride ? 'Override ON' : (a.effectiveFreshWindowStartsAllowed ? 'Global ON' : 'Blocked')) + '</div></div>' +
      '</div>' +
      (a.lastError ? '<div class="card-error">' + a.lastError.slice(0, 150) + '</div>' +
        (a.lastError.toLowerCase().includes('verif') ?
          '<div class="card-hint">Open Antigravity IDE, sign in with this account, and resolve the verification prompt outside the rotator. Keep the account quarantined until that is complete.</div>' :
        a.lastError.toLowerCase().includes('terms of service') ?
          '<div class="card-hint">This account was suspended by Google. Submit an appeal at <a href="https://support.google.com/accounts/troubleshooter/2402620" target="_blank" style="color:var(--blue)">Google Account Recovery</a> and keep it out of rotation unless Google explicitly restores access.</div>' :
          '') : '') +
      (isCooldown ? '<div class="card-hint">Cooling down after a provider rate-limit response. The rotator will wait for the retry window instead of forcing more traffic into this account.</div>' : '') +
      '<div class="card-actions">' +
        (a.status === 'disabled' ? '<button class="btn-enable" onclick="enableAccount(\\'' + a.email + '\\')">Re-enable</button>' : '') +
        '<button class="btn-enable" onclick="setAccountFreshWindowOverride(\\'' + a.email + '\\', ' + (!a.allowFreshWindowStartsOverride) + ')">' +
          (a.allowFreshWindowStartsOverride ? 'Use Global Fresh Policy' : 'Allow Fresh On This Account') +
        '</button>' +
      '</div>' +
      (isCooldown && cooldownPercent > 0 ? '<div class="cooldown-bar" style="width:' + cooldownPercent + '%"></div>' : '') +
    '</div>';
  }).join('');

  renderProAdvisor(data.proAdvisor);
}

function renderHealthPill(label, value) {
  return '<div class="health-pill"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

function renderAttentionPanel(data) {
  var panel = document.getElementById('attentionPanel');
  var button = document.getElementById('attentionBtn');
  var badge = document.getElementById('attentionBadge');
  var accounts = data.accounts || [];
  var flagged = accounts.filter(function(a) { return a.status === 'flagged'; });
  var disabled = accounts.filter(function(a) { return a.status === 'disabled'; });
  var errors = accounts.filter(function(a) { return a.status === 'error'; });
  var cooldown = accounts
    .filter(function(a) { return a.status === 'cooldown'; })
    .sort(function(a, b) { return a.cooldownRemaining - b.cooldownRemaining; })
    .slice(0, 4);
  var items = [];

  if (flagged.length > 0) {
    items.push(renderAttentionItem(
      'Flagged by provider',
      flagged.length + ' account(s) are quarantined after a provider enforcement signal. Keep them out of rotation until the provider explicitly restores access.',
      flagged.map(function(a) { return maskText(a.label); }).join(', ')
    ));
  }
  if (cooldown.length > 0) {
    items.push(renderAttentionItem(
      'Cooling down',
      'These are the next accounts expected to come back. Routing waits for their retry windows instead of forcing traffic into them.',
      cooldown.map(function(a) { return maskText(a.label) + ' ' + formatDuration(a.cooldownRemaining); }).join(' | ')
    ));
  }
  if (disabled.length > 0) {
    items.push(renderAttentionItem(
      'Disabled accounts',
      'These accounts hit repeated operational errors and were taken out of service. Re-enable only after the underlying problem is fixed.',
      disabled.map(function(a) { return maskText(a.label); }).join(', ')
    ));
  }
  if (errors.length > 0) {
    items.push(renderAttentionItem(
      'Recent errors',
      'These accounts are still visible but currently erroring. Review the per-account error details below before they escalate to disabled.',
      errors.map(function(a) { return maskText(a.label); }).join(', ')
    ));
  }

  if (items.length === 0) {
    panel.innerHTML = '<div class="modal-empty">No operator action items right now.</div>';
    badge.style.display = 'none';
    button.classList.remove('has-items');
    return;
  }

  panel.innerHTML = '<div class="operator-title">Attention Needed</div><div class="operator-list">' + items.join('') + '</div>';
  badge.style.display = 'inline-flex';
  badge.textContent = String(items.length);
  button.classList.add('has-items');
}

function renderAttentionItem(title, description, meta) {
  return '<div class="operator-item">' +
    '<div><strong>' + title + '</strong><span>' + description + '</span></div>' +
    '<div class="operator-meta">' + meta + '</div>' +
  '</div>';
}

function renderRecentEvents(events) {
  var panel = document.getElementById('recentEventsPanel');
  var allEvents = events || [];
  if (allEvents.length === 0) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  var list = allEvents.filter(matchesEventFilter).slice(0, 14);
  var toolbar =
    '<div class="events-toolbar">' +
      renderEventFilterButton('all', 'All') +
      renderEventFilterButton('errors', 'Errors Only') +
      renderEventFilterButton('proxy', 'Proxy Only') +
      renderEventFilterButton('rotator', 'Rotator Only') +
    '</div>';
  var rows = list.map(function(event) {
    return '<div class="event-item level-' + (event.level || 'info') + '">' +
      '<div class="event-time">' + formatTime(event.timestamp) + '</div>' +
      '<div class="event-source ' + event.source + '">' + escapeHtml(event.source) + '</div>' +
      '<div class="event-message">' + escapeHtml(event.message) + '</div>' +
    '</div>';
  }).join('');

  panel.style.display = 'block';
  panel.innerHTML =
    '<div class="operator-title">Recent Events</div>' +
    toolbar +
    (rows ? '<div class="events-list">' + rows + '</div>' : '<div class="events-empty">No events match the current filter.</div>');
}

function renderEventFilterButton(filter, label) {
  return '<button class="event-filter' + (EVENT_FILTER === filter ? ' active' : '') + '" onclick="setEventFilter(&quot;' + filter + '&quot;)">' + label + '</button>';
}

function matchesEventFilter(event) {
  if (EVENT_FILTER === 'errors') return event.level === 'error';
  if (EVENT_FILTER === 'proxy') return event.source === 'proxy';
  if (EVENT_FILTER === 'rotator') return event.source === 'rotator';
  return true;
}

var MASK_MODE = new URLSearchParams(window.location.search).has('mask');
var EVENT_FILTER = new URLSearchParams(window.location.search).get('events') || 'all';
var maskCounter = 0;
var maskMap = {};

function maskText(text) {
  if (!MASK_MODE) return text;
  if (!maskMap[text]) {
    maskCounter++;
    maskMap[text] = 'Account ' + maskCounter;
  }
  return maskMap[text];
}

function maskEmail(email) {
  if (!MASK_MODE) return email;
  var masked = maskText(email.split('@')[0]);
  return masked.toLowerCase().replace(/ /g, '-') + '@***.com';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setEventFilter(filter) {
  EVENT_FILTER = filter;
  refresh();
}

async function enableAccount(email) {
  await fetch('/api/enable/' + encodeURIComponent(email), { method: 'POST' });
  refresh();
}

async function setFreshWindowStarts(enabled) {
  await fetch('/api/settings/fresh-window-starts/' + (enabled ? 'on' : 'off'), { method: 'POST' });
  refresh();
}

async function setAccountFreshWindowOverride(email, enabled) {
  await fetch('/api/account-fresh-window-starts/' + encodeURIComponent(email) + '/' + (enabled ? 'on' : 'off'), { method: 'POST' });
  refresh();
}

function renderProAdvisor(advisor) {
  var panel = document.getElementById('proAdvisor');
  var button = document.getElementById('advisorBtn');
  var badge = document.getElementById('advisorBadge');
  if (!advisor) {
    panel.innerHTML = '<div class="modal-empty">No advisor data available.</div>';
    badge.style.display = 'none';
    button.classList.remove('has-items');
    return;
  }
  var title = '<div class="advisor-title">Pro Family Advisor' +
    '<span class="advisor-slots">Slots: ' + advisor.currentProCount + '/' + advisor.maxProSlots + '</span></div>';
  if (advisor.actions.length === 0) {
    panel.innerHTML = title + '<div class="advisor-empty">No actions recommended</div>';
    badge.style.display = 'none';
    button.classList.remove('has-items');
    return;
  }
  var rows = advisor.actions.map(function(a) {
    var cls = a.type === 'add-pro' ? 'add-pro' : 'remove-pro';
    var typeLabel = a.type === 'add-pro' ? 'Add Pro' : 'Remove Pro';
    return '<div class="advisor-action ' + cls + '">' +
      '<span class="advisor-action-type">' + typeLabel + '</span>' +
      '<span class="advisor-action-label">' + maskText(a.label) + '</span>' +
      '<span class="advisor-action-reason">' + a.reason + '</span>' +
    '</div>';
  }).join('');
  panel.innerHTML = title + rows;
  badge.style.display = 'inline-flex';
  badge.textContent = String(advisor.actions.length);
  button.classList.add('has-items');
}

function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}

function closeModal(event, id) {
  if (event) event.stopPropagation();
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}

async function refresh() {
  try {
    var res = await fetch('/api/status');
    var data = await res.json();
    renderAccounts(data);
    var btn = document.getElementById('maskBtn');
    if (btn) btn.textContent = MASK_MODE ? 'PII: Hidden' : 'PII: Visible';
  } catch (err) {
    console.error('Status fetch failed:', err);
  }
}

function toggleMask() {
  var url = new URL(window.location);
  if (MASK_MODE) {
    url.searchParams.delete('mask');
  } else {
    url.searchParams.set('mask', '1');
  }
  window.location.href = url.toString();
}

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    closeModal(null, 'attentionModal');
    closeModal(null, 'advisorModal');
  }
});

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
