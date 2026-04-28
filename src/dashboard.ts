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

export function serveClearInFlightApi(res: ServerResponse, rotator: AccountRotator, email: string, modelKey?: string): void {
	const ok = rotator.clearInFlightRequests(email, modelKey);
	res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok, email, modelKey }));
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

  .header-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;
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

  .mask-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    line-height: 1;
    transition: border-color 0.2s, color 0.2s, background 0.2s;
  }

  .mask-btn:hover {
    border-color: #35354b;
    color: var(--text);
    background: rgba(255,255,255,0.04);
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

  .accounts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 14px;
    margin-bottom: 24px;
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

  .quota-action {
    width: 54px;
    flex-shrink: 0;
  }

  .btn-clear-flight {
    width: 54px;
    border: 1px solid rgba(96, 165, 250, 0.28);
    background: rgba(96, 165, 250, 0.08);
    color: var(--blue);
    border-radius: 4px;
    font-size: 9px;
    font-family: var(--font);
    font-weight: 700;
    padding: 2px 4px;
    cursor: pointer;
  }

  .btn-clear-flight:hover { background: rgba(96, 165, 250, 0.16); }
  .btn-clear-flight:disabled {
    border-color: var(--border);
    background: rgba(255,255,255,0.03);
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.55;
  }

  .pulse { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .badge-pro { background: rgba(52, 211, 153, 0.15); color: var(--green); }
  .badge-free { background: rgba(110, 110, 130, 0.08); color: var(--text-dim); }
  .badge-fmgr { background: rgba(124, 92, 252, 0.15); color: var(--accent); font-size: 9px; }

  .dw-section {
    margin-top: 6px;
    padding: 8px 10px;
    background: rgba(124, 92, 252, 0.04);
    border: 1px solid rgba(124, 92, 252, 0.12);
    border-radius: 6px;
  }
  .dw-title {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .dw-model {
    margin-bottom: 6px;
  }
  .dw-model-name {
    font-size: 10px;
    color: var(--text-dim);
    font-weight: 600;
    margin-bottom: 2px;
  }
  .dw-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    line-height: 1.6;
  }
  .dw-badge {
    display: inline-block;
    width: 32px;
    text-align: center;
    font-weight: 700;
    font-size: 9px;
    border-radius: 3px;
    padding: 1px 4px;
    flex-shrink: 0;
  }
  .dw-badge-pro {
    background: rgba(52, 211, 153, 0.15);
    color: var(--green);
  }
  .dw-badge-free {
    background: rgba(250, 204, 21, 0.12);
    color: var(--yellow);
  }
  .dw-quota {
    font-weight: 700;
    min-width: 28px;
  }
  .dw-reset {
    color: var(--text-dim);
  }
  .dw-empty {
    color: var(--text-dim);
    font-style: italic;
    opacity: 0.5;
  }

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
  .btn-sm { padding: 2px 8px; font-size: 10px; }
  .btn-sm.active { background: var(--accent); color: #000; border-color: var(--accent); }
  .health-grid {
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }
  .health-pill {
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .health-pill .label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.35px;
    color: var(--text-dim);
    line-height: 1;
  }
  .health-pill .value {
    font-size: 18px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    line-height: 1;
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
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-main">
    <div class="header-title-row">
      <h1>Pi Antigravity Rotator</h1>
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
    <button class="header-icon-btn advisor" id="advisorBtn" onclick="openModal('advisorModal')" title="Pro Family Advisor" aria-label="Open Pro Family Advisor">
      <svg viewBox="0 0 24 24"><path d="m5 15 2-9 5 5 5-5 2 9"/><path d="M4 19h16"/></svg>
      <span class="header-icon-badge advisor" id="advisorBadge" style="display:none">0</span>
    </button>
  </div>
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
  return d + 'd ' + (h % 24) + 'h ' + (m % 60) + 'm';
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

function renderQuotaBars(account) {
  var quota = account.quota;
  if (!quota || quota.length === 0) return '';
  var rows = quota.map(function(q) {
    var inFlightForModel = (account.inFlightByModel || {})[q.modelKey] || 0;
    var clearButton = inFlightForModel > 0
      ? '<button class="btn-clear-flight" title="Clear in-flight counter for ' + q.displayName + '" onclick="clearInFlight(\\'' + account.email + '\\', \\'' + q.modelKey + '\\')">Clear</button>'
      : '<button class="btn-clear-flight" title="No in-flight requests for ' + q.displayName + '" disabled>Clear</button>';
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
      '<span class="quota-action">' + clearButton + '</span>' +
    '</div>';
  }).join('');
  return '<div class="quota-section"><div class="quota-section-title">Quota (per model)</div>' + rows + '</div>';
}

function renderDualWindows(account) {
  var qw = account.quotaWindows;
  if (!qw) return '';
  var models = Object.keys(qw);
  if (models.length === 0) return '';
  var now = Date.now();
  var rows = models.map(function(modelKey) {
    var t = qw[modelKey];
    var shortName = modelKey.split('-').slice(0, 2).join('-');
    var proLine = '';
    var freeLine = '';

    // PRO line
    if (t.pro && t.pro.lastSeen > 0) {
      var pQuota = t.pro.lastQuota;
      var pReset = '';
      if (t.pro.resetTimeMs > 0) {
        var pRemain = t.pro.resetTimeMs - now;
        if (pRemain > 0) {
          pReset = 'resets in ' + formatDuration(pRemain);
        } else {
          // Reset has passed
          var was5h = (t.pro.resetTimeMs - t.pro.lastSeen) < (24 * 3600 * 1000);
          if (was5h) {
            pQuota = Math.min(100, pQuota + 40);
            pReset = '<span style="color:var(--green)">+40% ready</span>';
          } else {
            pQuota = 100;
            pReset = '<span style="color:var(--green)">100% ready</span>';
          }
        }
      }
      var pqColor = pQuota > 50 ? 'var(--green)' : pQuota > 20 ? 'var(--yellow)' : 'var(--red)';
      proLine = '<div class="dw-row">' +
        '<span class="dw-badge dw-badge-pro">PRO</span>' +
        '<span class="dw-quota" style="color:' + pqColor + '">' + pQuota + '%</span>' +
        '<span class="dw-reset">' + (pReset || '--') + '</span>' +
      '</div>';
    } else {
      proLine = '<div class="dw-row"><span class="dw-badge dw-badge-pro">PRO</span><span class="dw-empty">no data</span></div>';
    }

    // FREE line
    if (t.free && t.free.lastSeen > 0) {
      var fQuota = t.free.lastQuota;
      var fReset = '';
      if (t.free.resetTimeMs > 0) {
        var fRemain = t.free.resetTimeMs - now;
        if (fRemain > 0) {
          fReset = 'resets in ' + formatDuration(fRemain);
        } else {
          // Reset has passed
          var fWas5h = (t.free.resetTimeMs - t.free.lastSeen) < (24 * 3600 * 1000);
          if (fWas5h) {
            fQuota = Math.min(100, fQuota + 40);
            fReset = '<span style="color:var(--green)">+40% ready</span>';
          } else {
            fQuota = 100;
            fReset = '<span style="color:var(--green)">100% ready</span>';
          }
        }
      }
      var fqColor = fQuota > 50 ? 'var(--green)' : fQuota > 20 ? 'var(--yellow)' : 'var(--red)';
      freeLine = '<div class="dw-row">' +
        '<span class="dw-badge dw-badge-free">FREE</span>' +
        '<span class="dw-quota" style="color:' + fqColor + '">' + fQuota + '%</span>' +
        '<span class="dw-reset">' + (fReset || '--') + '</span>' +
      '</div>';
    } else {
      freeLine = '<div class="dw-row"><span class="dw-badge dw-badge-free">FREE</span><span class="dw-empty">no data</span></div>';
    }
    
    var swapBtn = '<button class="btn-clear-flight" style="margin-left:auto" onclick="swapWindows(\\'' + account.email + '\\', \\'' + modelKey + '\\')">Swap</button>';

    return '<div class="dw-model">' +
      '<div class="dw-model-name" style="display:flex;align-items:center">' + shortName + swapBtn + '</div>' +
      proLine + freeLine +
    '</div>';
  }).join('');
  return '<div class="dw-section"><div class="dw-title">Quota Windows (Pro / Free)</div>' + rows + '</div>';
}

function renderAccounts(data) {
  window.__lastData = data;
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
      '<button class="btn-secondary" onclick="toggleFlagged()">' +
        (window.__hideFlagged ? 'Show Flagged' : 'Hide Flagged') +
      '</button>' +
      '<button class="btn-secondary" onclick="setFreshWindowStarts(' + (!controls.allowFreshWindowStarts) + ')">' +
        (controls.allowFreshWindowStarts ? 'Block Fresh Windows' : 'Allow Fresh Windows') +
      '</button>' +
    '</div>' +
    '<div class="ops-warning">' + freshPolicyHint + '</div>';

  renderAttentionPanel(data);
  renderTokenChart(data.tokenUsage);
  renderHeatmap(data.tokenUsage);
  renderLatencyPanel(data.latencyStats);
  renderForecastPanel(data);
  renderRequestLog(data.requestLog);
  renderRecentEvents(data.recentEvents);

  var container = document.getElementById('accounts');
  var hideFlagged = window.__hideFlagged || false;
  var sorted = data.accounts.slice()
    .filter(function(a) { return !hideFlagged || (a.status !== 'flagged' && a.status !== 'disabled'); })
    .sort(function(a, b) {
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
    var now = Date.now();
    var cooldowns = Object.values(a.cooldownsByModel || {});
    var maxCooldownUntil = cooldowns.length > 0 ? Math.max.apply(null, cooldowns) : 0;
    var cooldownRemaining = Math.max(0, maxCooldownUntil - now);
    var cooldownPercent = 0;
    if (isCooldown && cooldownRemaining > 0) {
      var totalCooldown = maxCooldownUntil - (a.lastUsed || now);
      cooldownPercent = Math.max(0, Math.min(100, (cooldownRemaining / Math.max(totalCooldown, 1)) * 100));
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
      (a.quota && a.quota.length > 0 ? renderQuotaBars(a) : '') +
      renderDualWindows(a) +
      '<div class="card-stats">' +
        '<div class="card-stat"><div class="stat-label">Requests</div><div class="stat-value">' +
          a.requestsSinceRotation + ' / ' + a.totalRequests + ' total</div></div>' +
        '<div class="card-stat"><div class="stat-label">Last Used</div><div class="stat-value">' +
          (a.lastUsed ? formatTime(a.lastUsed) : '--') + '</div></div>' +
        (isCooldown ? '<div class="card-stat"><div class="stat-label">Cooldown</div><div class="stat-value" style="color:var(--yellow)">' +
          formatDuration(cooldownRemaining) + '</div></div>' : '') +
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
  return '<div class="health-pill"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>';
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
    .map(function(a) {
      var ts = Object.values(a.cooldownsByModel || {});
      var max = ts.length > 0 ? Math.max.apply(null, ts) : 0;
      return { account: a, remaining: Math.max(0, max - Date.now()) };
    })
    .sort(function(a, b) { return a.remaining - b.remaining; })
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
      cooldown.map(function(c) { return maskText(c.account.label) + ' ' + formatDuration(c.remaining); }).join(' | ')
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

var TOKEN_MODEL_COLORS = {
  'gemini-3.1-pro': '#8b5cf6',
  'claude-opus-4-6-thinking': '#f59e0b',
  'claude-sonnet-4-6': '#3b82f6',
  'gemini-2.5-pro': '#10b981',
  'gemini-2.5-flash': '#06b6d4',
  'gemini-2.0-flash': '#ec4899',
  '__other__': '#6b7280'
};

function getModelColor(model) {
  return TOKEN_MODEL_COLORS[model] || TOKEN_MODEL_COLORS['__other__'];
}

function formatTokenCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

window.__tokenView = '1h';

function exportData(format) {
  if (!window.__lastData || !window.__lastData.tokenUsage) return;
  var usage = window.__lastData.tokenUsage;
  
  if (format === 'json') {
    var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(usage, null, 2));
    var a = document.createElement('a');
    a.href = dataStr;
    a.download = "rotator-token-usage.json";
    a.click();
  } else if (format === 'csv') {
    var csv = "Tier,Period,Model,InputTokens,OutputTokens,Requests\\n";
    ['months', 'days', 'hours', 'minutes'].forEach(function(tier) {
      (usage[tier] || []).forEach(function(b) {
        if (!b.byModel) return;
        Object.keys(b.byModel).forEach(function(m) {
          var d = b.byModel[m];
          csv += tier + "," + b.period + "," + m + "," + d.inputTokens + "," + d.outputTokens + "," + d.requests + "\\n";
        });
      });
    });
    var dataStrCSV = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    var a2 = document.createElement('a');
    a2.href = dataStrCSV;
    a2.download = "rotator-token-usage.csv";
    a2.click();
  }
}

function setTokenView(view) {
  window.__tokenView = view;
  refresh();
}

function formatBucketLabel(period, view) {
  try {
    if (view.endsWith('h') && view !== '1d') {
      var d;
      if (period.length === 16) d = new Date(period + ':00Z');
      else d = new Date(period);
      if (!isNaN(d.getTime())) {
        if (view === '1h') return ':' + String(d.getMinutes()).padStart(2, '0');
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
    if (view === '1d') return period.slice(11, 13) + 'h';
    if (view === '7d' || view === '1m') return period.slice(5, 10);
  } catch(e) {}
  return period;
}

function renderTokenChart(tokenUsage) {
  var panel = document.getElementById('tokenUsagePanel');
  var chart = document.getElementById('tokenChart');
  var legend = document.getElementById('tokenLegend');
  var totals = document.getElementById('tokenTotals');
  var view = window.__tokenView || '1h';

  // Highlight active button
  ['1h', '2h', '4h', '8h', '12h', '1d', '7d', '1m'].forEach(function(v) {
    var btn = document.getElementById('tbtn-' + v);
    if (btn) btn.className = 'btn-secondary btn-sm' + (v === view ? ' active' : '');
  });

  if (!tokenUsage) {
    panel.style.display = 'none';
    return;
  }

  // Helper: merge buckets into a map by a grouping key
  function mergeBucketsBy(sources, keyFn, limit) {
    var map = {};
    sources.forEach(function(b) {
      var key = keyFn(b.period);
      if (!key) return;
      if (!map[key]) map[key] = { period: key, inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
      map[key].inputTokens += b.inputTokens;
      map[key].outputTokens += b.outputTokens;
      map[key].requests += b.requests;
      Object.keys(b.byModel || {}).forEach(function(m) {
        if (!map[key].byModel[m]) map[key].byModel[m] = { inputTokens: 0, outputTokens: 0, requests: 0 };
        map[key].byModel[m].inputTokens += (b.byModel[m] || {}).inputTokens || 0;
        map[key].byModel[m].outputTokens += (b.byModel[m] || {}).outputTokens || 0;
        map[key].byModel[m].requests += (b.byModel[m] || {}).requests || 0;
      });
    });
    return Object.keys(map).sort().map(function(k) { return map[k]; }).slice(-limit);
  }

  function getLocalKey(periodStr, type) {
    try {
      var d;
      if (periodStr.length === 10) d = new Date(periodStr + 'T00:00:00Z');
      else if (periodStr.length === 13) d = new Date(periodStr + ':00:00Z');
      else if (periodStr.length === 16) d = new Date(periodStr + ':00Z');
      else d = new Date(periodStr);
      if (isNaN(d.getTime())) return periodStr;
      
      var y = d.getFullYear();
      var mo = String(d.getMonth() + 1).padStart(2, '0');
      var da = String(d.getDate()).padStart(2, '0');
      var h = String(d.getHours()).padStart(2, '0');
      var mi = d.getMinutes();
      
      if (type === 'day') return y + '-' + mo + '-' + da;
      if (type === 'hour') return y + '-' + mo + '-' + da + 'T' + h;
      if (type === '5min') return y + '-' + mo + '-' + da + 'T' + h + ':' + String(Math.floor(mi/5)*5).padStart(2, '0');
      if (type === '4min') return y + '-' + mo + '-' + da + 'T' + h + ':' + String(Math.floor(mi/4)*4).padStart(2, '0');
      if (type === '2min') return y + '-' + mo + '-' + da + 'T' + h + ':' + String(Math.floor(mi/2)*2).padStart(2, '0');
    } catch(e) {}
    return periodStr;
  }

  var allTiers = (tokenUsage.months || []).concat(tokenUsage.days || []).concat(tokenUsage.hours || []).concat(tokenUsage.minutes || []);

  // Pick tier based on view
  var buckets;
  if (view === '1h') {
    buckets = (tokenUsage.minutes || []).slice(-60);
  } else if (view === '2h') {
    buckets = (tokenUsage.minutes || []).slice(-120);
  } else if (view === '4h') {
    buckets = mergeBucketsBy((tokenUsage.minutes || []), function(p) { return getLocalKey(p, '2min'); }, 120);
  } else if (view === '8h') {
    buckets = mergeBucketsBy((tokenUsage.minutes || []), function(p) { return getLocalKey(p, '4min'); }, 120);
  } else if (view === '12h') {
    buckets = mergeBucketsBy((tokenUsage.minutes || []), function(p) { return getLocalKey(p, '5min'); }, 144);
  } else if (view === '1d') {
    buckets = mergeBucketsBy((tokenUsage.hours || []).concat(tokenUsage.minutes || []), function(p) { return getLocalKey(p, 'hour'); }, 24);
  } else if (view === '7d') {
    buckets = mergeBucketsBy(allTiers, function(p) { return getLocalKey(p, 'day'); }, 7);
  } else {
    buckets = mergeBucketsBy(allTiers, function(p) { return getLocalKey(p, 'day'); }, 30);
  }

  if (!buckets || buckets.length === 0) {
    chart.innerHTML = '<div style="color:var(--text-dim);padding:20px;text-align:center">No data for this range yet</div>';
    totals.innerHTML = '';
    legend.innerHTML = '';
    return;
  }
  panel.style.display = '';

  // Collect all models
  var allModels = {};
  buckets.forEach(function(b) {
    Object.keys(b.byModel || {}).forEach(function(m) { allModels[m] = true; });
  });
  var models = Object.keys(allModels).sort();

  // Max tokens for Y scale
  var maxTokens = 0;
  buckets.forEach(function(b) {
    var total = b.inputTokens + b.outputTokens;
    if (total > maxTokens) maxTokens = total;
  });
  if (maxTokens === 0) maxTokens = 1;

  var chartWidth = chart.clientWidth || 800;
  var minSvgWidth = buckets.length * 16 + 40; 
  var svgWidth = Math.max(chartWidth, minSvgWidth);
  var availableWidth = svgWidth - 50;
  var step = availableWidth / Math.max(1, buckets.length);
  var barWidth = Math.min(36, step * 0.8);
  var chartHeight = 140;

  var bars = '';
  buckets.forEach(function(b, i) {
    var x = 40 + i * step + (step - barWidth) / 2;

    // Stack by model
    var yOffset = chartHeight;
    models.forEach(function(model) {
      var md = (b.byModel || {})[model];
      if (!md) return;
      var modelTokens = md.inputTokens + md.outputTokens;
      var segHeight = Math.max(0, (modelTokens / maxTokens) * (chartHeight - 20));
      yOffset -= segHeight;
      bars += '<rect x="' + x + '" y="' + yOffset + '" width="' + barWidth +
        '" height="' + segHeight + '" fill="' + getModelColor(model) +
        '" rx="2" opacity="0.85"><title>' + model + ': ' + formatTokenCount(modelTokens) + ' tokens (' + (md.requests || 0) + ' reqs)</title></rect>';
    });

    // X-axis label
    var lbl = formatBucketLabel(b.period, view);
    bars += '<text x="' + (x + barWidth / 2) + '" y="' + (chartHeight + 14) +
      '" text-anchor="middle" fill="#888" font-size="9" font-family="JetBrains Mono,monospace">' + lbl + '</text>';
  });

  // Y-axis
  var yLabels = '';
  for (var yi = 0; yi <= 3; yi++) {
    var yVal = (maxTokens / 3) * yi;
    var yPos = chartHeight - ((chartHeight - 20) / 3) * yi;
    yLabels += '<text x="36" y="' + (yPos + 3) + '" text-anchor="end" fill="#666" font-size="9" font-family="JetBrains Mono,monospace">' + formatTokenCount(Math.round(yVal)) + '</text>';
    yLabels += '<line x1="38" y1="' + yPos + '" x2="' + svgWidth + '" y2="' + yPos + '" stroke="#333" stroke-dasharray="2,4"/>';
  }

  chart.innerHTML = '<svg width="' + svgWidth + '" height="' + (chartHeight + 20) + '" style="min-width:100%">' +
    yLabels + bars + '</svg>';

  var savings = tokenUsage.savings || { totalUsd: 0, byModel: {} };
  var savingsText = savings.totalUsd > 0
    ? ' · <span style="color:var(--green);font-weight:700">Savings: $' + savings.totalUsd.toFixed(2) + '</span>'
    : '';

  totals.innerHTML = 'In: ' + formatTokenCount(tokenUsage.totalInputTokens) +
    ' · Out: ' + formatTokenCount(tokenUsage.totalOutputTokens) +
    ' · Reqs: ' + tokenUsage.totalRequests +
    savingsText;

  legend.innerHTML = models.map(function(m) {
    var modelSavings = (savings.byModel || {})[m];
    var savingsLabel = modelSavings && modelSavings.totalUsd > 0.01
      ? ' <span style="color:var(--green)">$' + modelSavings.totalUsd.toFixed(2) + '</span>'
      : '';
    return '<div style="display:flex;align-items:center;gap:4px">' +
      '<div style="width:10px;height:10px;border-radius:2px;background:' + getModelColor(m) + '"></div>' +
      '<span style="color:var(--text-dim)">' + m + savingsLabel + '</span></div>';
  }).join('');
}

function formatMs(ms) {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

function renderHeatmap(tokenUsage) {
  var panel = document.getElementById('heatmapPanel');
  var grid = document.getElementById('heatmapGrid');
  if (!tokenUsage) {
    panel.style.display = 'none';
    return;
  }

  var hours = tokenUsage.hours || [];
  var minutes = tokenUsage.minutes || [];
  var now = new Date();
  var daysCount = 60;
  var days = [];
  for (var i = daysCount - 1; i >= 0; i--) {
    var d = new Date(now);
    d.setDate(now.getDate() - i);
    var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    // show label only for every 7th day to avoid crowding
    days.push({ key: key, label: (i % 7 === 0) ? key.slice(5) : '' });
  }

  var cellMap = {}; // day|hour -> requests
  function addBucket(dayKey, hour, reqs) {
    var k = dayKey + '|' + hour;
    if (!cellMap[k]) cellMap[k] = 0;
    cellMap[k] += reqs || 0;
  }

  function parseLocal(periodStr) {
    var d;
    if (periodStr.length === 10) d = new Date(periodStr + 'T00:00:00Z');
    else if (periodStr.length === 13) d = new Date(periodStr + ':00:00Z');
    else if (periodStr.length === 16) d = new Date(periodStr + ':00Z');
    else d = new Date(periodStr);
    
    if (isNaN(d.getTime())) return null;
    return {
      dayKey: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      hour: d.getHours()
    };
  }

  hours.forEach(function(b) {
    if (!b.period) return;
    var loc = parseLocal(b.period);
    if (loc) addBucket(loc.dayKey, loc.hour, b.requests);
  });

  minutes.forEach(function(b) {
    if (!b.period) return;
    var loc = parseLocal(b.period);
    if (loc) addBucket(loc.dayKey, loc.hour, b.requests);
  });

  var max = 0;
  for (var h = 0; h < 24; h++) {
    for (var c = 0; c < days.length; c++) {
      var v = cellMap[days[c].key + '|' + h] || 0;
      if (v > max) max = v;
    }
  }

  function colorFor(v) {
    if (v <= 0 || max <= 0) return 'rgba(255,255,255,0.05)';
    var t = v / max;
    if (t < 0.2) return 'rgba(56,189,248,0.25)';
    if (t < 0.4) return 'rgba(56,189,248,0.40)';
    if (t < 0.6) return 'rgba(56,189,248,0.55)';
    if (t < 0.8) return 'rgba(56,189,248,0.72)';
    return 'rgba(56,189,248,0.92)';
  }

  var html = '<div style="overflow-x:auto"><table style="width:100%;min-width:800px;border-collapse:separate;border-spacing:2px;table-layout:fixed;font-family:JetBrains Mono,monospace;font-size:0.6rem">';
  html += '<tr><th style="color:var(--text-dim);padding-right:6px;width:20px">h</th>';
  days.forEach(function(d) { html += '<th style="color:var(--text-dim);font-weight:500;text-align:left;white-space:nowrap;overflow:visible">' + d.label + '</th>'; });
  html += '</tr>';

  for (var hour = 0; hour < 24; hour++) {
    html += '<tr><td style="color:var(--text-dim);padding-right:6px;text-align:right">' + String(hour).padStart(2, '0') + '</td>';
    for (var j = 0; j < days.length; j++) {
      var day = days[j].key;
      var val = cellMap[day + '|' + hour] || 0;
      html += '<td title="' + day + ' ' + String(hour).padStart(2, '0') + ':00 · ' + val + ' req" style="height:14px;border-radius:2px;background:' + colorFor(val) + ';border:1px solid rgba(255,255,255,0.05)"></td>';
    }
    html += '</tr>';
  }

  html += '</table></div>';
  grid.innerHTML = html;
  panel.style.display = '';
}

function renderForecastPanel(data) {
  var panel = document.getElementById('forecastPanel');
  var grid = document.getElementById('forecastGrid');
  var accounts = data.accounts || [];
  var tokenUsage = data.tokenUsage || {};

  // Aggregate quota per model across all healthy accounts
  var modelQuota = {}; // { modelKey: { totalPercent, accountCount, quotaEntries[] } }
  accounts.forEach(function(a) {
    if (a.status === 'flagged' || a.status === 'disabled') return;
    (a.quota || []).forEach(function(q) {
      if (!modelQuota[q.modelKey]) modelQuota[q.modelKey] = { totalPercent: 0, accountCount: 0, entries: [] };
      modelQuota[q.modelKey].totalPercent += q.percentRemaining;
      modelQuota[q.modelKey].accountCount += 1;
      modelQuota[q.modelKey].entries.push(q);
    });
  });

  // Calculate burn rate per model from last hour of token usage
  var minutes = tokenUsage.minutes || [];
  var now = Date.now();
  var oneHourAgo = now - 3600000;
  var recentMinutes = minutes.filter(function(b) {
    try { return new Date(b.period).getTime() > oneHourAgo; } catch(e) { return false; }
  });
  var burnByModel = {}; // requests per hour
  recentMinutes.forEach(function(b) {
    Object.keys(b.byModel || {}).forEach(function(m) {
      if (!burnByModel[m]) burnByModel[m] = 0;
      burnByModel[m] += (b.byModel[m] || {}).requests || 0;
    });
  });
  // Scale to per-hour if we have less than 60 min of data
  var minuteSpan = recentMinutes.length || 1;
  Object.keys(burnByModel).forEach(function(m) {
    burnByModel[m] = (burnByModel[m] / minuteSpan) * 60; // reqs/hour
  });

  // Collapse display model burn rates into quota pool keys for forecast
  // e.g. gemini-3.1-pro-low + gemini-3.1-pro-high → gemini-3.1-pro
  // e.g. claude-sonnet-4-6 + claude-opus-4-6-thinking → claude-opus-4-6-thinking (quota pool)
  var burnByPool = {};
  Object.keys(burnByModel).forEach(function(displayKey) {
    var poolKey = displayKey;
    if (displayKey.startsWith('gemini-3.1-pro')) poolKey = 'gemini-3.1-pro';
    if (displayKey === 'claude-sonnet-4-6') poolKey = 'claude-opus-4-6-thinking';
    if (!burnByPool[poolKey]) burnByPool[poolKey] = 0;
    burnByPool[poolKey] += burnByModel[displayKey];
  });

  var models = Object.keys(modelQuota).sort();
  if (models.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  var html = '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.8rem">' +
    '<tr style="color:var(--text-dim);text-align:left">' +
      '<th style="padding:4px 8px">Model</th>' +
      '<th style="padding:4px 8px">Pool Quota</th>' +
      '<th style="padding:4px 8px">Accounts</th>' +
      '<th style="padding:4px 8px">Burn Rate</th>' +
      '<th style="padding:4px 8px">Estimate</th>' +
    '</tr>';

  models.forEach(function(m) {
    var q = modelQuota[m];
    var avgQuota = q.accountCount > 0 ? Math.round(q.totalPercent / q.accountCount) : 0;
    var color = getModelColor(m);
    var rate = burnByPool[m] || 0;
    var rateLabel = rate > 0 ? rate.toFixed(1) + ' req/h' : 'idle';

    // Estimate: assume ~100 requests per full 100% quota window (empirical)
    // Total remaining "request capacity" ≈ sum of (percent/100 * 100) per account
    var totalCapacity = q.totalPercent; // each 1% ≈ 1 request remaining
    var hoursLeft;
    var estimateLabel;
    var estimateColor = 'var(--text)';
    if (rate <= 0) {
      estimateLabel = '\u221e';
      estimateColor = 'var(--green)';
    } else {
      hoursLeft = totalCapacity / rate;
      if (hoursLeft > 24) {
        estimateLabel = (hoursLeft / 24).toFixed(1) + 'd';
        estimateColor = 'var(--green)';
      } else if (hoursLeft > 1) {
        estimateLabel = hoursLeft.toFixed(1) + 'h';
        estimateColor = hoursLeft < 3 ? 'var(--yellow)' : 'var(--text)';
      } else {
        estimateLabel = Math.round(hoursLeft * 60) + 'min';
        estimateColor = 'var(--red)';
      }
    }

    // Quota bar
    var barColor = avgQuota > 50 ? 'var(--green)' : avgQuota > 20 ? 'var(--yellow)' : 'var(--red)';
    var bar = '<div style="display:flex;align-items:center;gap:6px">' +
      '<div style="flex:1;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">' +
        '<div style="width:' + avgQuota + '%;height:100%;background:' + barColor + ';border-radius:3px"></div>' +
      '</div>' +
      '<span>' + avgQuota + '%</span></div>';

    html += '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';margin-right:6px"></span>' + m + '</td>' +
      '<td style="padding:4px 8px;min-width:120px">' + bar + '</td>' +
      '<td style="padding:4px 8px;text-align:center">' + q.accountCount + '</td>' +
      '<td style="padding:4px 8px">' + rateLabel + '</td>' +
      '<td style="padding:4px 8px;color:' + estimateColor + ';font-weight:700">' + estimateLabel + '</td>' +
    '</tr>';
  });

  html += '</table>';
  grid.innerHTML = html;
}

function renderLatencyPanel(latencyStats) {
  var panel = document.getElementById('latencyPanel');
  var grid = document.getElementById('latencyGrid');
  if (!latencyStats || Object.keys(latencyStats).length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  var models = Object.keys(latencyStats).sort();
  var html = '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.8rem">' +
    '<tr style="color:var(--text-dim);text-align:left">' +
      '<th style="padding:4px 8px">Model</th>' +
      '<th style="padding:4px 8px">TTFB p50</th>' +
      '<th style="padding:4px 8px">TTFB p95</th>' +
      '<th style="padding:4px 8px">Total p50</th>' +
      '<th style="padding:4px 8px">Total p95</th>' +
      '<th style="padding:4px 8px">Samples</th>' +
    '</tr>';

  models.forEach(function(m) {
    var s = latencyStats[m];
    var color = getModelColor(m);
    html += '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';margin-right:6px"></span>' + m + '</td>' +
      '<td style="padding:4px 8px">' + formatMs(s.ttfb.p50) + '</td>' +
      '<td style="padding:4px 8px;color:' + (s.ttfb.p95 > 10000 ? 'var(--yellow)' : 'var(--text)') + '">' + formatMs(s.ttfb.p95) + '</td>' +
      '<td style="padding:4px 8px">' + formatMs(s.total.p50) + '</td>' +
      '<td style="padding:4px 8px;color:' + (s.total.p95 > 30000 ? 'var(--yellow)' : 'var(--text)') + '">' + formatMs(s.total.p95) + '</td>' +
      '<td style="padding:4px 8px;color:var(--text-dim)">' + s.count + '</td>' +
    '</tr>';
  });

  html += '</table>';
  grid.innerHTML = html;
}

function renderRequestLog(log) {
  var panel = document.getElementById('requestLogPanel');
  var grid = document.getElementById('requestLogGrid');
  if (!log || log.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  var fModel = (document.getElementById('logFilterModel').value || '').toLowerCase();
  var fAccount = (document.getElementById('logFilterAccount').value || '').toLowerCase();
  var fStatus = (document.getElementById('logFilterStatus').value || '').trim();

  var filtered = log.filter(function(r) {
    if (fModel && r.model.toLowerCase().indexOf(fModel) === -1) return false;
    if (fAccount && r.account.toLowerCase().indexOf(fAccount) === -1) return false;
    if (fStatus && String(r.statusCode).indexOf(fStatus) === -1) return false;
    return true;
  });

  var html = '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.75rem">' +
    '<tr style="color:var(--text-dim);text-align:left;position:sticky;top:0;background:var(--card-bg)">' +
      '<th style="padding:3px 6px">Time</th>' +
      '<th style="padding:3px 6px">Model</th>' +
      '<th style="padding:3px 6px">Account</th>' +
      '<th style="padding:3px 6px">Status</th>' +
      '<th style="padding:3px 6px">TTFB</th>' +
      '<th style="padding:3px 6px">Total</th>' +
      '<th style="padding:3px 6px">Tokens</th>' +
    '</tr>';

  filtered.forEach(function(r) {
    var t = new Date(r.timestamp);
    var time = ('0'+t.getHours()).slice(-2) + ':' + ('0'+t.getMinutes()).slice(-2) + ':' + ('0'+t.getSeconds()).slice(-2);
    var statusColor = r.statusCode === 200 ? 'var(--green)' : r.statusCode === 429 ? 'var(--yellow)' : 'var(--red)';
    var color = getModelColor(r.model);
    var tokens = r.inputTokens || r.outputTokens
      ? formatTokenCount(r.inputTokens) + '/' + formatTokenCount(r.outputTokens)
      : '-';
    html += '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:3px 6px;color:var(--text-dim)">' + time + '</td>' +
      '<td style="padding:3px 6px"><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:' + color + ';margin-right:4px"></span>' + r.model + '</td>' +
      '<td style="padding:3px 6px">' + (MASK_MODE ? '***' : r.account) + '</td>' +
      '<td style="padding:3px 6px;color:' + statusColor + ';font-weight:700">' + r.statusCode + '</td>' +
      '<td style="padding:3px 6px">' + formatMs(r.ttfbMs) + '</td>' +
      '<td style="padding:3px 6px">' + formatMs(r.totalMs) + '</td>' +
      '<td style="padding:3px 6px">' + tokens + '</td>' +
    '</tr>';
  });

  html += '</table>';
  if (filtered.length === 0) html = '<div style="color:var(--text-dim);text-align:center;padding:12px">No matching requests</div>';
  grid.innerHTML = html;
}

// Wire up filter inputs to re-render
(function() {
  ['logFilterModel','logFilterAccount','logFilterStatus'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function() { if (window.__lastData) renderRequestLog(window.__lastData.requestLog); });
  });
})();

function maskEventMessage(msg) {
  if (!MASK_MODE) return escapeHtml(msg);
  var out = msg;
  if (window.__lastData && window.__lastData.accounts) {
    window.__lastData.accounts.forEach(function(a) {
      if (a.label && out.indexOf(a.label) !== -1) {
        out = out.split(a.label).join('***');
      }
      if (a.email && out.indexOf(a.email) !== -1) {
        out = out.split(a.email).join('***');
      }
    });
  }
  return escapeHtml(out);
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
      '<div class="event-message">' + maskEventMessage(event.message) + '</div>' +
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

function toggleFlagged() {
  window.__hideFlagged = !window.__hideFlagged;
  refresh();
}

async function setAccountFreshWindowOverride(email, enabled) {
  await fetch('/api/account-fresh-window-starts/' + encodeURIComponent(email) + '/' + (enabled ? 'on' : 'off'), { method: 'POST' });
  refresh();
}

async function clearInFlight(email, modelKey) {
  if (!confirm('Clear in-flight counter for this account/model? Use only when you are sure the request is stuck.')) return;
  await fetch('/api/clear-inflight/' + encodeURIComponent(email) + '/' + encodeURIComponent(modelKey), { method: 'POST' });
  refresh();
}

async function swapWindows(email, modelKey) {
  if (!confirm('Manually swap Pro and Free data for ' + modelKey + '? Use this only if you know the algorithm classified the timers backward.')) return;
  await fetch('/api/account/swap-windows/' + encodeURIComponent(email) + '/' + encodeURIComponent(modelKey), { method: 'POST' });
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

// Live updates via SSE
var evtSource = null;
function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      renderAccounts(data);
    } catch(err) { console.error('SSE parse error:', err); }
  };
  evtSource.onerror = function() {
    // reconnect after 5s on error
    evtSource.close();
    evtSource = null;
    setTimeout(connectSSE, 5000);
  };
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
connectSSE();
setInterval(refresh, 15000); // fallback poll every 15s in case SSE drops
</script>
</body>
</html>`;
