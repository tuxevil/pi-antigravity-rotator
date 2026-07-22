var ADMIN_TOKEN =
  new URLSearchParams(window.location.search).get("token") ||
  localStorage.getItem("rotatorAdminToken") ||
  "";
if (ADMIN_TOKEN) localStorage.setItem("rotatorAdminToken", ADMIN_TOKEN);

function authHeaders() {
  return ADMIN_TOKEN ? { "X-Rotator-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json" } : {};
}

function openModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.add("open");
}
function closeModal(e, id) {
  if (e && e.target !== e.currentTarget) return;
  var m = document.getElementById(id);
  if (m) m.classList.remove("open");
}
function hideDonationModalPermanently() {
  localStorage.setItem("hideDonationModal", "true");
  closeModal(null, "donationModal");
}
function toggleMask() {
  var b = document.getElementById("maskBtn");
  if (b) {
    var v = b.textContent.includes("Visible");
    b.textContent = v ? "PII: Masked" : "PII: Visible";
  }
}
function formatDuration(ms) {
  if (ms <= 0) return "--";
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  var d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h " + (m % 60) + "m";
}

function formatCost(usd) {
  if (usd === undefined || usd === null || isNaN(usd) || usd <= 0) return "$0.000000";
  return "$" + Number(usd).toFixed(6);
}
function refreshHeaderStats() {
  fetch("/api/status", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (document.getElementById("uptime")) document.getElementById("uptime").textContent = formatDuration(data.uptime || 0);
      if (document.getElementById("port")) document.getElementById("port").textContent = data.proxyPort || "51200";
      if (document.getElementById("rotation")) document.getElementById("rotation").textContent = data.requestsPerRotation || "--";
      if (document.getElementById("headerVersion")) document.getElementById("headerVersion").textContent = "v" + (data.version || "2.3.6");
      if (document.getElementById("lastRefresh")) document.getElementById("lastRefresh").textContent = new Date().toLocaleTimeString();
      if (document.getElementById("totalRequests")) document.getElementById("totalRequests").textContent = data.totalRequestsAllAccounts || 0;
    })
    .catch(function() {});
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

var currentPage = 0;
var currentTotal = 0;
var currentKeyHash = "";
var currentModel = "";
var currentStatus = "";
var currentStartDate = "";
var currentEndDate = "";

function loadLogs(page) {
  if (page === undefined) page = currentPage;
  currentPage = page;

  var params = new URLSearchParams();
  params.set("limit", "25");
  params.set("offset", String(page * 25));
  if (currentKeyHash) params.set("keyHash", currentKeyHash);
  if (currentModel) params.set("model", currentModel);
  if (currentStatus) params.set("status", currentStatus);

  document.getElementById("logsBody").innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-dim)">Loading spend logs...</td></tr>';

  fetch("/api/spend/logs?" + params.toString(), { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      currentTotal = d.total || 0;
      renderLogs(d.logs || []);
      renderPagination();
      updateSummaryCards(d.logs || [], currentTotal);
      loadByKeySummary(currentStartDate, currentEndDate);
    })
    .catch(function(e) { 
      document.getElementById("logsBody").innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--red);padding:32px">Error loading logs: ' + escapeHtml(e.message) + '</td></tr>'; 
    });
}

function updateSummaryCards(logs, total) {
  var reqEl = document.getElementById("statLogRequests");
  var promptEl = document.getElementById("statLogPromptTokens");
  var compEl = document.getElementById("statLogCompletionTokens");
  var latEl = document.getElementById("statLogAvgLatency");
  var costEl = document.getElementById("statLogCost");

  if (reqEl) reqEl.textContent = total.toLocaleString();

  var totalPrompt = 0;
  var totalComp = 0;
  var totalDur = 0;
  var countDur = 0;
  var totalCost = 0;

  logs.forEach(function(l) {
    totalPrompt += (l.promptTokens || 0);
    totalComp += (l.completionTokens || 0);
    totalCost += (l.cost || 0);
    if (l.durationMs) {
      totalDur += l.durationMs;
      countDur++;
    }
  });

  if (promptEl) promptEl.textContent = totalPrompt.toLocaleString();
  if (compEl) compEl.textContent = totalComp.toLocaleString();
  if (latEl) latEl.textContent = countDur > 0 ? Math.round(totalDur / countDur) + "ms" : "--";
  if (costEl) costEl.textContent = formatCost(totalCost);
}

var ALL_COLS = ["time", "key", "model", "type", "status", "tokens", "cost", "duration", "ttfb", "ip"];
var columnState = {};

function loadColumnState() {
  var saved = localStorage.getItem("rotatorLogColumns");
  if (saved) {
    try {
      columnState = JSON.parse(saved);
    } catch(e) {
      columnState = {};
    }
  }
  ALL_COLS.forEach(function(c) {
    if (columnState[c] === undefined) columnState[c] = true;
  });
  applyColumnState();
}

function saveColumnState() {
  localStorage.setItem("rotatorLogColumns", JSON.stringify(columnState));
}

function applyColumnState() {
  var table = document.getElementById("logsTable");
  if (!table) return;

  ALL_COLS.forEach(function(c) {
    var isVisible = columnState[c] !== false;
    var cls = "hide-col-" + c;
    if (isVisible) {
      table.classList.remove(cls);
    } else {
      table.classList.add(cls);
    }
    var cb = document.querySelector('.col-picker-item input[data-col="' + c + '"]');
    if (cb) cb.checked = isVisible;
  });
}

function toggleColumn(col) {
  columnState[col] = !columnState[col];
  saveColumnState();
  applyColumnState();
}

function resetColumns() {
  ALL_COLS.forEach(function(c) {
    columnState[c] = true;
  });
  saveColumnState();
  applyColumnState();
}

function toggleColumnPicker(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById("colPickerMenu");
  if (m) {
    m.style.display = m.style.display === "none" ? "block" : "none";
  }
}

document.addEventListener("click", function(e) {
  var m = document.getElementById("colPickerMenu");
  if (m && m.style.display !== "none") {
    var btn = e.target.closest(".col-picker-container");
    if (!btn) m.style.display = "none";
  }
});

function formatJsonCode(obj) {
  if (obj === undefined || obj === null) return '<span style="color:var(--text-dim)">null</span>';
  try {
    var str = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    var escaped = escapeHtml(str);
    return escaped
      .replace(/"([^"]+)":/g, '<span style="color:#a78bfa;font-weight:500">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span style="color:#4ade80">"$1"</span>')
      .replace(/: (\d+\.?\d*)/g, ': <span style="color:#f59e0b">$1</span>')
      .replace(/: (true|false)/g, ': <span style="color:#38bdf8">$1</span>')
      .replace(/: (null)/g, ': <span style="color:#94a3b8">$1</span>');
  } catch(e) {
    return escapeHtml(String(obj));
  }
}

function copyText(str) {
  if (!str) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(str);
  }
}

function copyJson(elementId) {
  var el = document.getElementById(elementId);
  if (!el) return;
  copyText(el.textContent);
}

function switchInspectorTab(requestId, tabName) {
  var container = document.getElementById("expand-" + requestId);
  if (!container) return;
  var tabs = container.querySelectorAll(".inspector-tab-btn");
  tabs.forEach(function(tb) { tb.classList.remove("active"); });
  var targetTab = container.querySelector('.inspector-tab-btn[data-tab="' + tabName + '"]');
  if (targetTab) targetTab.classList.add("active");

  var contents = container.querySelectorAll(".tab-content");
  contents.forEach(function(c) { c.style.display = "none"; });
  var targetContent = document.getElementById("tab-" + tabName + "-" + requestId);
  if (targetContent) targetContent.style.display = "block";
}

function renderLogs(logs) {
  var tbody = document.getElementById("logsBody");
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--text-dim);padding:32px">No spend logs found matching criteria.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(function(l) {
    var statusBadge = l.status === "success" || l.status === "200" || (typeof l.status === "number" && l.status >= 200 && l.status < 300)
      ? '<span class="status-badge active" style="font-size:10px">200 OK</span>' 
      : '<span class="status-badge blocked" style="font-size:10px">Error (' + escapeHtml(String(l.status)) + ')</span>';
      
    var ts = l.createdAt ? new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "-";
    var duration = l.durationMs ? (l.durationMs + "ms") : "-";
    var ttfb = l.ttfbMs ? (l.ttfbMs + "ms") : "-";

    var keyDisplay = "unauthenticated";
    if (l.keyAlias) {
      keyDisplay = l.keyAlias;
    } else if (l.keyName) {
      keyDisplay = l.keyName;
    } else if (l.apiKeyHash) {
      keyDisplay = l.apiKeyHash.slice(0, 10) + "...";
    }

    var costDisplay = formatCost(l.cost);

    var typeBadgeClass = "badge-model";
    if (l.callType === "anthropic") typeBadgeClass = "badge-cooldown";
    if (l.callType === "responses") typeBadgeClass = "badge-active";

    var pCost = (l.promptTokens / 1000000) * (l.promptRate || 0);
    var cCost = (l.completionTokens / 1000000) * (l.completionRate || 0);

    return '<tr class="log-row" onclick="toggleExpand(\'' + l.requestId + '\')">' +
      '<td class="col-time" style="font-size:0.8rem;color:var(--text-dim)">' + ts + '</td>' +
      '<td class="col-key"><span class="mono" style="font-size:0.78rem;font-weight:600;color:var(--accent)" title="' + escapeHtml(l.apiKeyHash || "") + '">' + escapeHtml(keyDisplay) + '</span></td>' +
      '<td class="col-model"><span class="model-chip">' + escapeHtml(l.model) + '</span></td>' +
      '<td class="col-type"><span class="badge ' + typeBadgeClass + '" style="font-size:9px">' + escapeHtml(l.callType || "native") + '</span></td>' +
      '<td class="col-status">' + statusBadge + '</td>' +
      '<td class="col-tokens mono" style="font-size:0.82rem">' + l.promptTokens.toLocaleString() + ' <span style="color:var(--text-dim)">/</span> <span style="color:var(--green)">' + l.completionTokens.toLocaleString() + '</span></td>' +
      '<td class="col-cost mono" style="font-size:0.82rem;color:#3b82f6">' + costDisplay + '</td>' +
      '<td class="col-duration mono" style="font-size:0.82rem">' + duration + '</td>' +
      '<td class="col-ttfb mono" style="font-size:0.82rem;color:var(--text-dim)">' + ttfb + '</td>' +
      '<td class="col-ip" style="font-size:0.78rem;color:var(--text-dim)">' + (l.requesterIp || "-") + '</td>' +
    '</tr>' +
    '<tr id="expand-' + l.requestId + '" class="log-detail" style="display:none"><td colspan="100" style="padding:10px 14px;background:var(--bg)">' +
      '<div class="inspector-card">' +
        '<div class="inspector-header">' +
          '<div class="inspector-badge-row">' +
            statusBadge +
            '<span class="badge ' + typeBadgeClass + '">' + escapeHtml(l.callType || "native") + '</span>' +
            '<span class="model-chip">' + escapeHtml(l.model) + '</span>' +
            '<span class="mono-tag">Key: <strong>' + escapeHtml(keyDisplay) + '</strong></span>' +
            '<span class="mono-tag">Account: <strong>' + escapeHtml(l.accountEmail || "unknown") + '</strong></span>' +
            '<span class="mono-tag">IP: <strong>' + escapeHtml(l.requesterIp || "-") + '</strong></span>' +
          '</div>' +
          '<div class="inspector-req-id">' +
            '<span>ID: <code class="mono" style="color:var(--accent)">' + escapeHtml(l.requestId) + '</code></span>' +
            '<button class="pill-btn btn-sm" onclick="copyText(\'' + escapeHtml(l.requestId) + '\')">Copy ID</button>' +
          '</div>' +
        '</div>' +

        '<div class="inspector-metrics-grid">' +
          '<div class="metric-box">' +
            '<div class="metric-label">Prompt Tokens</div>' +
            '<div class="metric-val">' + l.promptTokens.toLocaleString() + '</div>' +
            '<div class="metric-sub">$' + pCost.toFixed(6) + '</div>' +
          '</div>' +
          '<div class="metric-box">' +
            '<div class="metric-label">Completion Tokens</div>' +
            '<div class="metric-val" style="color:var(--green)">' + l.completionTokens.toLocaleString() + '</div>' +
            '<div class="metric-sub">$' + cCost.toFixed(6) + '</div>' +
          '</div>' +
          '<div class="metric-box">' +
            '<div class="metric-label">Latency / TTFB</div>' +
            '<div class="metric-val">' + duration + '</div>' +
            '<div class="metric-sub">TTFB: ' + ttfb + '</div>' +
          '</div>' +
          '<div class="metric-box highlight">' +
            '<div class="metric-label">Rotator Savings</div>' +
            '<div class="metric-val" style="color:#3b82f6">' + costDisplay + '</div>' +
            '<div class="metric-sub" style="color:#22c55e">100% Free via Rotator</div>' +
          '</div>' +
        '</div>' +

        '<div class="inspector-tabs">' +
          '<button class="inspector-tab-btn active" data-tab="req" onclick="switchInspectorTab(\'' + l.requestId + '\', \'req\')">📩 Request Payload</button>' +
          '<button class="inspector-tab-btn" data-tab="res" onclick="switchInspectorTab(\'' + l.requestId + '\', \'res\')">📤 Response Payload</button>' +
          '<button class="inspector-tab-btn" data-tab="meta" onclick="switchInspectorTab(\'' + l.requestId + '\', \'meta\')">⚙️ Parameters &amp; Metadata</button>' +
        '</div>' +

        '<div id="tab-req-' + l.requestId + '" class="tab-content" style="display:block">' +
          '<div class="payload-header">' +
            '<span>Input Messages &amp; Request Body</span>' +
            '<button class="pill-btn btn-sm" onclick="copyJson(\'json-req-' + l.requestId + '\')">Copy JSON</button>' +
          '</div>' +
          '<pre id="json-req-' + l.requestId + '" class="code-viewer">' + formatJsonCode(l.requestMessages) + '</pre>' +
        '</div>' +

        '<div id="tab-res-' + l.requestId + '" class="tab-content" style="display:none">' +
          '<div class="payload-header">' +
            '<span>Output Content &amp; Choices</span>' +
            '<button class="pill-btn btn-sm" onclick="copyJson(\'json-res-' + l.requestId + '\')">Copy JSON</button>' +
          '</div>' +
          '<pre id="json-res-' + l.requestId + '" class="code-viewer">' + formatJsonCode(l.responseContent) + '</pre>' +
        '</div>' +

        '<div id="tab-meta-' + l.requestId + '" class="tab-content" style="display:none">' +
          '<div class="payload-header">' +
            '<span>Metadata &amp; System Context</span>' +
            '<button class="pill-btn btn-sm" onclick="copyJson(\'json-meta-' + l.requestId + '\')">Copy JSON</button>' +
          '</div>' +
          '<pre id="json-meta-' + l.requestId + '" class="code-viewer">' + formatJsonCode(l.metadata) + '</pre>' +
        '</div>' +

      '</div>' +
    '</td></tr>';
  }).join("");
  applyColumnState();
}

function toggleExpand(requestId) {
  var el = document.getElementById("expand-" + requestId);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "" : "none";
}

function renderPagination() {
  var container = document.getElementById("pagination");
  var totalPages = Math.ceil(currentTotal / 25);
  if (totalPages <= 1) { container.innerHTML = ""; return; }

  var html = '<span style="margin-right:12px;color:var(--text-dim)">Page ' + (currentPage + 1) + ' of ' + totalPages + ' (' + currentTotal.toLocaleString() + ' total)</span>';
  if (currentPage > 0) html += '<button class="pill-btn" onclick="loadLogs(' + (currentPage - 1) + ')">← Prev</button> ';
  if (currentPage < totalPages - 1) html += '<button class="pill-btn" onclick="loadLogs(' + (currentPage + 1) + ')">Next →</button>';
  container.innerHTML = html;
}

function applyFilters() {
  currentKeyHash = document.getElementById("filterKeyHash").value.trim();
  currentModel = document.getElementById("filterModel").value.trim();
  currentStatus = document.getElementById("filterStatus").value;
  currentStartDate = document.getElementById("filterStartDate").value;
  currentEndDate = document.getElementById("filterEndDate").value;
  loadLogs(0);
}

function resetFilters() {
  document.getElementById("filterKeyHash").value = "";
  document.getElementById("filterModel").value = "";
  document.getElementById("filterStatus").value = "";
  document.getElementById("filterStartDate").value = "";
  document.getElementById("filterEndDate").value = "";
  currentKeyHash = "";
  currentModel = "";
  currentStatus = "";
  currentStartDate = "";
  currentEndDate = "";
  loadLogs(0);
}

function loadByKeySummary(startDate, endDate) {
  var params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);

  fetch("/api/spend/by-key?" + params.toString(), { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      renderByKeySummary(d.byKey || []);
    })
    .catch(function() {});
}

function renderByKeySummary(byKey) {
  var container = document.getElementById("byKeySummary");
  if (!byKey || byKey.length === 0) { container.innerHTML = ""; return; }
  
  var html = '<div class="list-panel" style="margin-bottom:20px">' +
    '<div class="list-toolbar"><span class="list-toolbar-label">Spend Summary by Virtual Key / Agent</span></div>' +
    '<div style="overflow-x:auto">' +
    '<table class="compact-table"><thead><tr>' +
      '<th>Key / Agent</th><th>Total Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Est. Cost</th><th>Avg Duration</th><th>Last Active</th>' +
    '</tr></thead><tbody>';

  html += byKey.map(function(k) {
    var avgDur = k.avgDurationMs ? Math.round(k.avgDurationMs) + "ms" : "-";
    var lastSeen = k.lastSeen ? new Date(k.lastSeen).toLocaleString() : "-";
    var keyName = k.keyAlias || k.keyName || (k.apiKeyHash ? k.apiKeyHash.slice(0, 14) + "..." : "unauthenticated");
    var costStr = formatCost(k.totalCost);

    return '<tr>' +
      '<td><strong style="color:var(--accent)" title="' + escapeHtml(k.apiKeyHash) + '">' + escapeHtml(keyName) + '</strong></td>' +
      '<td><strong>' + k.totalRequests.toLocaleString() + '</strong></td>' +
      '<td class="mono">' + k.totalPromptTokens.toLocaleString() + '</td>' +
      '<td class="mono" style="color:var(--green)">' + k.totalCompletionTokens.toLocaleString() + '</td>' +
      '<td class="mono" style="color:#3b82f6">' + costStr + '</td>' +
      '<td class="mono">' + avgDur + '</td>' +
      '<td style="font-size:0.8rem;color:var(--text-dim)">' + lastSeen + '</td>' +
    '</tr>';
  }).join("");
  html += '</tbody></table></div></div>';
  container.innerHTML = html;
}

function initLogsPage() {
  loadColumnState();
  loadLogs(0);
  refreshHeaderStats();
  setInterval(refreshHeaderStats, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLogsPage);
} else {
  initLogsPage();
}