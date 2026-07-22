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

  if (reqEl) reqEl.textContent = total.toLocaleString();

  var totalPrompt = 0;
  var totalComp = 0;
  var totalDur = 0;
  var countDur = 0;

  logs.forEach(function(l) {
    totalPrompt += (l.promptTokens || 0);
    totalComp += (l.completionTokens || 0);
    if (l.durationMs) {
      totalDur += l.durationMs;
      countDur++;
    }
  });

  if (promptEl) promptEl.textContent = totalPrompt.toLocaleString();
  if (compEl) compEl.textContent = totalComp.toLocaleString();
  if (latEl) latEl.textContent = countDur > 0 ? Math.round(totalDur / countDur) + "ms" : "--";
}

function renderLogs(logs) {
  var tbody = document.getElementById("logsBody");
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:32px">No spend logs found matching criteria.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(function(l) {
    var statusBadge = l.status === "success" 
      ? '<span class="status-badge active" style="font-size:10px">200 OK</span>' 
      : '<span class="status-badge blocked" style="font-size:10px">Error</span>';
      
    var ts = l.createdAt ? new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "-";
    var duration = l.durationMs ? (l.durationMs + "ms") : "-";
    var ttfb = l.ttfbMs ? (l.ttfbMs + "ms") : "-";
    var keyDisplay = l.apiKeyHash ? l.apiKeyHash.slice(0, 10) + "..." : "unauthenticated";

    var typeBadgeClass = "badge-model";
    if (l.callType === "anthropic") typeBadgeClass = "badge-cooldown";
    if (l.callType === "responses") typeBadgeClass = "badge-active";

    return '<tr class="log-row" onclick="toggleExpand(\'' + l.requestId + '\')">' +
      '<td style="font-size:0.8rem;color:var(--text-dim)">' + ts + '</td>' +
      '<td><span class="mono" style="font-size:0.78rem">' + escapeHtml(keyDisplay) + '</span></td>' +
      '<td><span class="model-chip">' + escapeHtml(l.model) + '</span></td>' +
      '<td><span class="badge ' + typeBadgeClass + '" style="font-size:9px">' + escapeHtml(l.callType || "native") + '</span></td>' +
      '<td>' + statusBadge + '</td>' +
      '<td class="mono" style="font-size:0.82rem">' + l.promptTokens + ' <span style="color:var(--text-dim)">/</span> <span style="color:var(--green)">' + l.completionTokens + '</span></td>' +
      '<td class="mono" style="font-size:0.82rem">' + duration + '</td>' +
      '<td class="mono" style="font-size:0.82rem;color:var(--text-dim)">' + ttfb + '</td>' +
      '<td style="font-size:0.78rem;color:var(--text-dim)">' + (l.requesterIp || "-") + '</td>' +
    '</tr>' +
    '<tr id="expand-' + l.requestId + '" class="log-detail" style="display:none"><td colspan="9">' +
      '<div class="log-detail-content" style="background:rgba(0,0,0,0.25);border-left:3px solid var(--accent);padding:14px;margin:6px 0;border-radius:0 8px 8px 0">' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:0.82rem">' +
          '<div><strong>Request ID:</strong> <span class="mono">' + escapeHtml(l.requestId) + '</span></div>' +
          '<div><strong>Account Email:</strong> <span class="mono">' + escapeHtml(l.accountEmail || "unknown") + '</span></div>' +
        '</div>' +
        (l.metadata && Object.keys(l.metadata).length > 0 ? '<div style="margin-bottom:8px;font-size:0.82rem"><strong>Metadata:</strong> <span class="mono">' + escapeHtml(JSON.stringify(l.metadata)) + '</span></div>' : '') +
        (l.requestMessages ? '<details style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:600;color:var(--accent);margin-bottom:6px">📩 Request Payload (Messages)</summary><pre class="log-payload">' + escapeHtml(JSON.stringify(l.requestMessages, null, 2)) + '</pre></details>' : '') +
        (l.responseContent ? '<details><summary style="cursor:pointer;font-weight:600;color:var(--green);margin-bottom:6px">📤 Response Payload (Content)</summary><pre class="log-payload">' + escapeHtml(JSON.stringify(l.responseContent, null, 2)) + '</pre></details>' : '') +
      '</div>' +
    '</td></tr>';
  }).join("");
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
    '<div class="list-toolbar"><span class="list-toolbar-label">Spend Summary by Virtual Key</span></div>' +
    '<div style="overflow-x:auto">' +
    '<table class="compact-table"><thead><tr>' +
      '<th>Key Hash</th><th>Total Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Avg Duration</th><th>Last Active</th>' +
    '</tr></thead><tbody>';

  html += byKey.map(function(k) {
    var avgDur = k.avgDurationMs ? Math.round(k.avgDurationMs) + "ms" : "-";
    var lastSeen = k.lastSeen ? new Date(k.lastSeen).toLocaleString() : "-";
    return '<tr>' +
      '<td><span class="mono" style="color:var(--accent)">' + escapeHtml(k.apiKeyHash.slice(0, 14) + "...") + '</span></td>' +
      '<td><strong>' + k.totalRequests.toLocaleString() + '</strong></td>' +
      '<td class="mono">' + k.totalPromptTokens.toLocaleString() + '</td>' +
      '<td class="mono" style="color:var(--green)">' + k.totalCompletionTokens.toLocaleString() + '</td>' +
      '<td class="mono">' + avgDur + '</td>' +
      '<td style="font-size:0.8rem;color:var(--text-dim)">' + lastSeen + '</td>' +
    '</tr>';
  }).join("");
  html += '</tbody></table></div></div>';
  container.innerHTML = html;
}

function initLogsPage() {
  loadLogs(0);
  refreshHeaderStats();
  setInterval(refreshHeaderStats, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLogsPage);
} else {
  initLogsPage();
}