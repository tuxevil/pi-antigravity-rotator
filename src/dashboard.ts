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
	res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok, email }));
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Antigravity Rotator</title>
<style>
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

  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

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
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
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
    gap: 24px;
    font-size: 13px;
    color: var(--text-dim);
  }

  .header-stats span {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text);
    font-weight: 500;
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
  }

  .stat-card .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }

  .stat-card .value {
    font-size: 24px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }

  .accounts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
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

  .account-card:hover {
    border-color: #2a2a3e;
  }

  .account-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 20px var(--accent-glow);
  }

  .account-card.cooldown {
    border-color: rgba(251, 191, 36, 0.3);
  }

  .account-card.disabled {
    opacity: 0.5;
  }

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

  .card-badges {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 6px;
  }

  .badge-pro { background: rgba(124, 92, 252, 0.15); color: var(--accent); }
  .badge-free { background: rgba(96, 165, 250, 0.15); color: var(--blue); }
  .badge-active { background: rgba(52, 211, 153, 0.15); color: var(--green); }
  .badge-ready { background: rgba(110, 110, 130, 0.1); color: var(--text-dim); }
  .badge-cooldown { background: rgba(251, 191, 36, 0.15); color: var(--yellow); }
  .badge-exhausted { background: rgba(248, 113, 113, 0.15); color: var(--red); }
  .badge-disabled { background: rgba(248, 113, 113, 0.1); color: #888; }
  .badge-error { background: rgba(251, 146, 60, 0.15); color: var(--orange); }
  .badge-fresh { background: rgba(52, 211, 153, 0.1); color: var(--green); }
  .badge-7d { background: rgba(96, 165, 250, 0.1); color: var(--blue); }
  .badge-5h { background: rgba(251, 191, 36, 0.1); color: var(--yellow); }

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

  .card-stat {
    font-size: 12px;
  }

  .card-stat .stat-label {
    color: var(--text-dim);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .card-stat .stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 500;
    font-size: 13px;
    margin-top: 2px;
  }

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

  .card-actions {
    margin-top: 10px;
    display: flex;
    gap: 8px;
  }

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

  .btn-enable:hover {
    background: var(--accent-glow);
  }

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

  .pulse {
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>Antigravity Rotator</h1>
  <div class="header-stats">
    Uptime: <span id="uptime">--</span> |
    Port: <span id="port">--</span> |
    Rotation: <span id="rotation">--</span> reqs
  </div>
</div>

<div class="stats-row">
  <div class="stat-card">
    <div class="label">Total Requests</div>
    <div class="value" id="totalRequests">0</div>
  </div>
  <div class="stat-card">
    <div class="label">Active Account</div>
    <div class="value" id="activeAccount" style="font-size:14px;margin-top:4px;">--</div>
  </div>
  <div class="stat-card">
    <div class="label">Accounts</div>
    <div class="value" id="accountCounts">0</div>
  </div>
  <div class="stat-card">
    <div class="label">Healthy</div>
    <div class="value" id="healthyCount" style="color:var(--green)">0</div>
  </div>
</div>

<div class="accounts-grid" id="accounts"></div>

<script>
function formatDuration(ms) {
  if (ms <= 0) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

function formatTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function renderAccounts(data) {
  const now = Date.now();
  document.getElementById('uptime').textContent = formatDuration(data.uptime);
  document.getElementById('port').textContent = data.proxyPort;
  document.getElementById('rotation').textContent = data.requestsPerRotation;
  document.getElementById('totalRequests').textContent = data.totalRequestsAllAccounts;
  document.getElementById('activeAccount').textContent = data.activeAccount || '--';
  document.getElementById('accountCounts').textContent = data.accounts.length;
  document.getElementById('healthyCount').textContent =
    data.accounts.filter(a => a.status === 'active' || a.status === 'ready').length;

  const container = document.getElementById('accounts');
  container.innerHTML = data.accounts.map(a => {
    const isActive = a.status === 'active';
    const isCooldown = a.status === 'cooldown' || a.status === 'exhausted';
    const isDisabled = a.status === 'disabled';

    let cooldownPercent = 0;
    if (isCooldown && a.cooldownRemaining > 0) {
      const totalCooldown = a.cooldownUntil - (a.lastUsed || now);
      cooldownPercent = Math.max(0, Math.min(100, (a.cooldownRemaining / Math.max(totalCooldown, 1)) * 100));
    }

    var poolLabel = a.timerPriority === 1 ? 'fresh' : a.timerPriority === 2 ? '7d' : '5h';
    var poolClass = a.timerPriority === 1 ? 'fresh' : a.timerPriority === 2 ? '7d' : '5h';

    return '<div class="account-card ' + a.status + '">' +
      '<div class="card-header">' +
        '<div class="card-label">' + a.label + '</div>' +
        '<div class="card-badges">' +
          '<span class="badge badge-' + a.type + '">' + a.type + '</span>' +
          '<span class="badge badge-' + poolClass + '">' + poolLabel + '</span>' +
          '<span class="badge badge-' + a.status + (isActive ? ' pulse' : '') + '">' + a.status + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-email">' + a.email + '</div>' +
      (a.quota && a.quota.length > 0 ? renderQuotaBars(a.quota) : '') +
      '<div class="card-stats">' +
        '<div class="card-stat"><div class="stat-label">Requests</div><div class="stat-value">' +
          a.requestsSinceRotation + ' / ' + a.totalRequests + ' total</div></div>' +
        '<div class="card-stat"><div class="stat-label">Last Used</div><div class="stat-value">' +
          (a.lastUsed ? formatTime(a.lastUsed) : '--') + '</div></div>' +
        (isCooldown ? '<div class="card-stat"><div class="stat-label">Cooldown</div><div class="stat-value" style="color:var(--yellow)">' +
          formatDuration(a.cooldownRemaining) + '</div></div>' : '') +
        (a.shortTimerResetAt > now ? '<div class="card-stat"><div class="stat-label">5h Timer</div><div class="stat-value" style="color:var(--orange)">' +
          formatDuration(a.shortTimerResetAt - now) + '</div></div>' : '') +
        (a.longTimerResetAt > now ? '<div class="card-stat"><div class="stat-label">7d Timer</div><div class="stat-value" style="color:var(--red)">' +
          formatDuration(a.longTimerResetAt - now) + '</div></div>' : '') +
        '<div class="card-stat"><div class="stat-label">Token</div><div class="stat-value" style="color:' +
          (a.hasValidToken ? 'var(--green)' : 'var(--text-dim)') + '">' +
          (a.hasValidToken ? 'Valid' : 'Expired') + '</div></div>' +
      '</div>' +
      (a.lastError ? '<div class="card-error">' + a.lastError.slice(0, 150) + '</div>' : '') +
      (isDisabled ? '<div class="card-actions"><button class="btn-enable" onclick="enableAccount(\\'' +
        a.email + '\\')">Re-enable</button></div>' : '') +
      (isCooldown && cooldownPercent > 0 ? '<div class="cooldown-bar" style="width:' + cooldownPercent + '%"></div>' : '') +
    '</div>';
  }).join('');
}

async function enableAccount(email) {
  await fetch('/api/enable/' + encodeURIComponent(email), { method: 'POST' });
  refresh();
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    renderAccounts(data);
  } catch (err) {
    console.error('Status fetch failed:', err);
  }
}

function quotaBarColor(pct) {
  if (pct >= 60) return 'var(--green)';
  if (pct >= 30) return 'var(--yellow)';
  return 'var(--red)';
}

function renderQuotaBars(quota) {
  if (!quota || quota.length === 0) return '';
  var rows = quota.map(function(q) {
    var color = quotaBarColor(q.percentRemaining);
    return '<div class="quota-row">' +
      '<span class="quota-model">' + q.displayName + '</span>' +
      '<div class="quota-bar-bg"><div class="quota-bar-fill" style="width:' + q.percentRemaining + '%;background:' + color + '"></div></div>' +
      '<span class="quota-pct" style="color:' + color + '">' + q.percentRemaining + '%</span>' +
    '</div>';
  }).join('');
  return '<div class="quota-section"><div class="quota-section-title">Quota</div>' + rows + '</div>';
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
