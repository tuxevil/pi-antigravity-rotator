var ADMIN_TOKEN =
  new URLSearchParams(window.location.search).get("token") ||
  localStorage.getItem("rotatorAdminToken") ||
  "";
if (ADMIN_TOKEN) localStorage.setItem("rotatorAdminToken", ADMIN_TOKEN);

function authHeaders() {
  return ADMIN_TOKEN ? { "X-Rotator-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json" } : {};
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

  document.getElementById("logsBody").innerHTML = '<tr><td colspan="9" style="text-align:center">Loading...</td></tr>';

  fetch("/api/spend/logs?" + params.toString(), { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      currentTotal = d.total || 0;
      renderLogs(d.logs || []);
      renderPagination();
      loadByKeySummary(currentStartDate, currentEndDate);
    })
    .catch(function(e) { document.getElementById("logsBody").innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--red)">Error: ' + e.message + '</td></tr>'; });
}

function renderLogs(logs) {
  var tbody = document.getElementById("logsBody");
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim)">No spend logs found</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(function(l) {
    var statusColor = l.status === "success" ? "var(--green)" : "var(--red)";
    var ts = l.createdAt ? new Date(l.createdAt).toLocaleString() : "-";
    var duration = l.durationMs ? (l.durationMs + "ms") : "-";
    var ttfb = l.ttfbMs ? (l.ttfbMs + "ms") : "-";
    var keyDisplay = l.apiKeyHash ? l.apiKeyHash.slice(0, 10) + "..." : "anonymous";
    return '<tr class="log-row" onclick="toggleExpand(\'' + l.requestId + '\')">' +
      '<td style="font-size:0.8rem">' + ts + '</td>' +
      '<td>' + escapeHtml(keyDisplay) + '</td>' +
      '<td>' + escapeHtml(l.model) + '</td>' +
      '<td>' + escapeHtml(l.callType) + '</td>' +
      '<td style="color:' + statusColor + '">' + l.status + '</td>' +
      '<td class="mono">' + l.promptTokens + ' / ' + l.completionTokens + '</td>' +
      '<td class="mono">' + duration + '</td>' +
      '<td class="mono">' + ttfb + '</td>' +
      '<td>' + (l.requesterIp || "-") + '</td>' +
    '</tr>' +
    '<tr id="expand-' + l.requestId + '" class="log-detail" style="display:none"><td colspan="9">' +
      '<div class="log-detail-content">' +
        '<div style="margin-bottom:8px"><strong>Request ID:</strong> ' + escapeHtml(l.requestId) + '</div>' +
        '<div style="margin-bottom:8px"><strong>Account:</strong> ' + escapeHtml(l.accountEmail || "unknown") + '</div>' +
        (l.metadata ? '<div style="margin-bottom:8px"><strong>Metadata:</strong> ' + escapeHtml(JSON.stringify(l.metadata)) + '</div>' : '') +
        (l.requestMessages ? '<details style="margin-bottom:8px"><summary><strong>Request Messages</strong></summary><pre class="log-payload">' + escapeHtml(JSON.stringify(l.requestMessages, null, 2)) + '</pre></details>' : '') +
        (l.responseContent ? '<details style="margin-bottom:8px"><summary><strong>Response Content</strong></summary><pre class="log-payload">' + escapeHtml(JSON.stringify(l.responseContent, null, 2)) + '</pre></details>' : '') +
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

  var html = '<span style="margin-right:12px">Page ' + (currentPage + 1) + ' of ' + totalPages + ' (' + currentTotal + ' total)</span>';
  if (currentPage > 0) html += '<button class="btn-secondary btn-sm" onclick="loadLogs(' + (currentPage - 1) + ')">Prev</button> ';
  if (currentPage < totalPages - 1) html += '<button class="btn-secondary btn-sm" onclick="loadLogs(' + (currentPage + 1) + ')">Next</button>';
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
  var html = '<table class="compact-table"><thead><tr>' +
    '<th>Key Hash</th><th>Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Avg Duration</th><th>Last Seen</th>' +
  '</tr></thead><tbody>';
  html += byKey.map(function(k) {
    var avgDur = k.avgDurationMs ? Math.round(k.avgDurationMs) + "ms" : "-";
    var lastSeen = k.lastSeen ? new Date(k.lastSeen).toLocaleString() : "-";
    return '<tr>' +
      '<td class="mono">' + escapeHtml(k.apiKeyHash.slice(0, 12) + "...") + '</td>' +
      '<td>' + k.totalRequests + '</td>' +
      '<td>' + k.totalPromptTokens.toLocaleString() + '</td>' +
      '<td>' + k.totalCompletionTokens.toLocaleString() + '</td>' +
      '<td>' + avgDur + '</td>' +
      '<td style="font-size:0.8rem">' + lastSeen + '</td>' +
    '</tr>';
  }).join("");
  html += '</tbody></table>';
  container.innerHTML = '<h3 style="margin:16px 0 8px">Spend by Key</h3>' + html;
}

document.addEventListener("DOMContentLoaded", function() {
  loadLogs(0);
});
