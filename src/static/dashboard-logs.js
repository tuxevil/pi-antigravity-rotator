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
var MASK_MODE = new URLSearchParams(window.location.search).has("mask");
var maskCounter = 0;
var maskMap = {};

function maskText(text) {
  if (!text) return "";
  if (!MASK_MODE) return text;
  if (!maskMap[text]) {
    maskCounter++;
    maskMap[text] = "User " + maskCounter;
  }
  return maskMap[text];
}

function maskKeyDisplay(keyDisplay) {
  if (!keyDisplay || keyDisplay === "unauthenticated") return keyDisplay;
  if (!MASK_MODE) return keyDisplay;
  if (keyDisplay.startsWith("rk-")) {
    return "rk-***...***";
  }
  if (!maskMap["key_" + keyDisplay]) {
    maskCounter++;
    maskMap["key_" + keyDisplay] = "Agent " + maskCounter;
  }
  return maskMap["key_" + keyDisplay];
}

function maskEmail(email) {
  if (!email || email === "unknown") return email;
  if (!MASK_MODE) return email;
  var parts = email.split("@");
  if (parts.length < 2) return "***";
  if (!maskMap["email_" + email]) {
    maskCounter++;
    maskMap["email_" + email] = "account-" + maskCounter + "@***.com";
  }
  return maskMap["email_" + email];
}

function maskIp(ip) {
  if (!ip || ip === "-") return ip;
  if (!MASK_MODE) return ip;
  var parts = ip.split(".");
  if (parts.length === 4) {
    return parts[0] + "." + parts[1] + ".x.x";
  }
  return "xxx.xxx.xxx.xxx";
}

function toggleMask() {
  var url = new URL(window.location);
  if (MASK_MODE) {
    url.searchParams.delete("mask");
  } else {
    url.searchParams.set("mask", "1");
  }
  window.location.href = url.toString();
}

function updateMaskButton() {
  var b = document.getElementById("maskBtn");
  if (b) {
    b.textContent = MASK_MODE ? "PII: Hidden" : "PII: Visible";
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
      if (document.getElementById("headerVersion")) document.getElementById("headerVersion").textContent = "v" + (data.version || "2.4.0");
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
var autoRefreshTimer = null;

function changeAutoRefresh(val) {
  var sec = parseInt(val, 10) || 0;
  localStorage.setItem("rotatorAutoRefreshSec", String(sec));

  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  if (sec > 0) {
    autoRefreshTimer = setInterval(function() {
      loadLogs(currentPage, true);
    }, sec * 1000);
  }
}

function loadLogs(page, isSilent) {
  if (page === undefined) page = currentPage;
  currentPage = page;

  var params = new URLSearchParams();
  params.set("limit", "25");
  params.set("offset", String(page * 25));
  if (currentKeyHash) params.set("keyHash", currentKeyHash);
  if (currentModel) params.set("model", currentModel);
  if (currentStatus) params.set("status", currentStatus);
  if (currentStartDate) params.set("startDate", currentStartDate);
  if (currentEndDate) params.set("endDate", currentEndDate);

  if (!isSilent) {
    document.getElementById("logsBody").innerHTML = '<tr><td colspan="100" style="text-align:center;padding:32px;color:var(--text-dim)">Loading spend logs...</td></tr>';
  }

  fetch("/api/spend/logs?" + params.toString(), { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      currentTotal = d.total || 0;
      renderLogs(d.logs || [], isSilent);
      renderPagination();
      updateSummaryCards(d.summary, currentTotal);
      loadByKeySummary(params);
    })
    .catch(function(e) { 
      if (!isSilent) {
        document.getElementById("logsBody").innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--red);padding:32px">Error loading logs: ' + escapeHtml(e.message) + '</td></tr>'; 
      }
    });
}

function updateSummaryCards(summary, total) {
  var reqEl = document.getElementById("statLogRequests");
  var promptEl = document.getElementById("statLogPromptTokens");
  var compEl = document.getElementById("statLogCompletionTokens");
  var latEl = document.getElementById("statLogAvgLatency");
  var costEl = document.getElementById("statLogCost");

  var reqs = (summary && summary.totalRequests !== undefined) ? summary.totalRequests : total;
  var prompt = summary ? (summary.promptTokens || 0) : 0;
  var comp = summary ? (summary.completionTokens || 0) : 0;
  var lat = summary ? (summary.avgLatencyMs ? summary.avgLatencyMs + "ms" : "--") : "--";
  var cost = summary ? (summary.totalCost || 0) : 0;

  if (reqEl) reqEl.textContent = reqs.toLocaleString();
  if (promptEl) promptEl.textContent = prompt.toLocaleString();
  if (compEl) compEl.textContent = comp.toLocaleString();
  if (latEl) latEl.textContent = lat;
  if (costEl) costEl.textContent = formatCost(cost);
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

var availableKeys = [];
var selectedKeyValues = [];
var availableModels = [
  { value: "gemini-3.6-flash", label: "gemini-3.6-flash" },
  { value: "gemini-3.5-flash", label: "gemini-3.5-flash" },
  { value: "gemini-3.1-pro", label: "gemini-3.1-pro" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-opus-4-6-thinking", label: "claude-opus-4-6-thinking" },
  { value: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium" }
];
var selectedModelValues = [];

function getTodayDateString() {
  var now = new Date();
  var year = now.getFullYear();
  var month = String(now.getMonth() + 1).padStart(2, "0");
  var day = String(now.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function toggleMultiselect(e, type) {
  if (e) e.stopPropagation();
  var menu = document.getElementById(type + "MultiselectMenu");
  var trigger = document.getElementById(type + "MultiselectTrigger");
  if (!menu || !trigger) return;

  var isOpening = menu.style.display === "none";
  ["key", "model"].forEach(function(t) {
    var m = document.getElementById(t + "MultiselectMenu");
    var tr = document.getElementById(t + "MultiselectTrigger");
    if (m) m.style.display = "none";
    if (tr) tr.classList.remove("open");
  });

  if (isOpening) {
    menu.style.display = "flex";
    trigger.classList.add("open");
    var searchInput = document.getElementById(type + "SearchInput");
    if (searchInput) searchInput.focus();
  }
}

document.addEventListener("click", function(e) {
  var m = document.getElementById("colPickerMenu");
  if (m && m.style.display !== "none") {
    var btn = e.target.closest(".col-picker-container");
    if (!btn) m.style.display = "none";
  }

  ["key", "model"].forEach(function(type) {
    var container = document.getElementById(type + "MultiselectContainer");
    var menu = document.getElementById(type + "MultiselectMenu");
    var trigger = document.getElementById(type + "MultiselectTrigger");
    if (menu && menu.style.display !== "none" && container && !container.contains(e.target)) {
      menu.style.display = "none";
      if (trigger) trigger.classList.remove("open");
    }
  });
});

function updateMultiselectTriggerLabel(type) {
  var labelEl = document.getElementById(type + "MultiselectLabel");
  if (!labelEl) return;

  var selected = type === "key" ? selectedKeyValues : selectedModelValues;
  var available = type === "key" ? availableKeys : availableModels;

  if (selected.length === 0) {
    labelEl.textContent = type === "key" ? "All Keys" : "All Models";
  } else if (selected.length === 1) {
    var match = available.find(function(o) { return o.value === selected[0]; });
    labelEl.textContent = match ? match.label : selected[0];
  } else {
    labelEl.textContent = selected.length + (type === "key" ? " Keys Selected" : " Models Selected");
  }
}

function renderMultiselectOptions(type) {
  var optionsContainer = document.getElementById(type + "MultiselectOptions");
  if (!optionsContainer) return;

  var options = type === "key" ? availableKeys : availableModels;
  var selected = type === "key" ? selectedKeyValues : selectedModelValues;
  var searchInput = document.getElementById(type + "SearchInput");
  var query = searchInput ? searchInput.value.toLowerCase().trim() : "";

  var filtered = options.filter(function(o) {
    if (!query) return true;
    return o.label.toLowerCase().indexOf(query) !== -1 || o.value.toLowerCase().indexOf(query) !== -1;
  });

  if (filtered.length === 0) {
    optionsContainer.innerHTML = '<div style="padding:10px;color:var(--text-dim);font-size:12px;text-align:center">No ' + type + 's match search</div>';
    return;
  }

  optionsContainer.innerHTML = filtered.map(function(o) {
    var isChecked = selected.indexOf(o.value) !== -1;
    return '<label class="multiselect-option" onclick="event.stopPropagation()">' +
      '<input type="checkbox" ' + (isChecked ? 'checked' : '') + ' onchange="onMultiselectOptionToggle(\'' + type + '\', \'' + escapeHtml(o.value) + '\')">' +
      '<span class="multiselect-option-text">' + escapeHtml(o.label) + '</span>' +
    '</label>';
  }).join("");
}

function onMultiselectOptionToggle(type, val) {
  var selected = type === "key" ? selectedKeyValues : selectedModelValues;
  var idx = selected.indexOf(val);
  if (idx !== -1) {
    selected.splice(idx, 1);
  } else {
    selected.push(val);
  }
  updateMultiselectTriggerLabel(type);
  renderMultiselectOptions(type);
}

function filterMultiselectOptions(type) {
  renderMultiselectOptions(type);
}

function selectAllMultiselect(type) {
  var options = type === "key" ? availableKeys : availableModels;
  var selected = type === "key" ? selectedKeyValues : selectedModelValues;
  selected.length = 0;
  options.forEach(function(o) { selected.push(o.value); });
  updateMultiselectTriggerLabel(type);
  renderMultiselectOptions(type);
}

function clearMultiselect(type) {
  var selected = type === "key" ? selectedKeyValues : selectedModelValues;
  selected.length = 0;
  var searchInput = document.getElementById(type + "SearchInput");
  if (searchInput) searchInput.value = "";
  updateMultiselectTriggerLabel(type);
  renderMultiselectOptions(type);
}

function fetchFilterOptions() {
  fetch("/api/keys", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var keysList = d.keys || [];
      var keysMap = {};

      keysMap["unauthenticated"] = { value: "unauthenticated", label: "unauthenticated" };

      keysList.forEach(function(k) {
        var keyVal = k.keyAlias || k.keyName || k.tokenHash;
        var displayLabel = maskKeyDisplay(k.keyAlias || k.keyName || (k.tokenHash ? k.tokenHash.slice(0, 10) + "..." : ""));
        keysMap[keyVal] = { value: keyVal, label: displayLabel };
      });

      fetch("/api/spend/by-key", { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(bkData) {
          (bkData.byKey || []).forEach(function(item) {
            var val = item.keyAlias || item.keyName || item.apiKeyHash || "unauthenticated";
            var label = maskKeyDisplay(item.keyAlias || item.keyName || (item.apiKeyHash ? item.apiKeyHash.slice(0, 14) + "..." : "unauthenticated"));
            if (!keysMap[val]) {
              keysMap[val] = { value: val, label: label };
            }
          });
          availableKeys = Object.values(keysMap);
          renderMultiselectOptions("key");
        })
        .catch(function() {
          availableKeys = Object.values(keysMap);
          renderMultiselectOptions("key");
        });
    })
    .catch(function() {
      availableKeys = [{ value: "unauthenticated", label: "unauthenticated" }];
      renderMultiselectOptions("key");
    });

  fetch("/api/models", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var modelsMap = {};
      availableModels.forEach(function(m) { modelsMap[m.value] = m; });
      (d.data || []).forEach(function(m) {
        if (m.id && !modelsMap[m.id]) {
          modelsMap[m.id] = { value: m.id, label: m.id };
        }
      });
      availableModels = Object.values(modelsMap);
      renderMultiselectOptions("model");
    })
    .catch(function() {
      renderMultiselectOptions("model");
    });
}

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

function renderLogs(logs, isSilent) {
  var tbody = document.getElementById("logsBody");
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--text-dim);padding:32px">No spend logs found matching criteria.</td></tr>';
    return;
  }

  var openExpandedIds = {};
  var activeTabs = {};
  if (isSilent) {
    var expandedRows = tbody.querySelectorAll('.log-detail');
    expandedRows.forEach(function(el) {
      if (el.style.display !== "none") {
        var reqId = el.id.replace("expand-", "");
        openExpandedIds[reqId] = true;
        var activeTabBtn = el.querySelector(".inspector-tab-btn.active");
        if (activeTabBtn) {
          activeTabs[reqId] = activeTabBtn.getAttribute("data-tab");
        }
      }
    });
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
    keyDisplay = maskKeyDisplay(keyDisplay);

    var displayAccount = maskEmail(l.accountEmail);
    var displayIp = maskIp(l.requesterIp);

    var costDisplay = formatCost(l.cost);

    var typeBadgeClass = "badge-model";
    if (l.callType === "anthropic") typeBadgeClass = "badge-cooldown";
    if (l.callType === "responses") typeBadgeClass = "badge-active";

    var pCost = (l.promptTokens / 1000000) * (l.promptRate || 0);
    var cCost = (l.completionTokens / 1000000) * (l.completionRate || 0);

    return '<tr class="log-row" onclick="toggleExpand(\'' + l.requestId + '\')">' +
      '<td class="col-time" style="font-size:0.8rem;color:var(--text-dim)">' + ts + '</td>' +
      '<td class="col-key"><span class="mono" style="font-size:0.78rem;font-weight:600;color:var(--accent)" title="' + escapeHtml(MASK_MODE ? "***" : (l.apiKeyHash || "")) + '">' + escapeHtml(keyDisplay) + '</span></td>' +
      '<td class="col-model"><span class="model-chip">' + escapeHtml(l.model) + '</span></td>' +
      '<td class="col-type"><span class="badge ' + typeBadgeClass + '" style="font-size:9px">' + escapeHtml(l.callType || "native") + '</span></td>' +
      '<td class="col-status">' + statusBadge + '</td>' +
      '<td class="col-tokens mono" style="font-size:0.82rem">' + l.promptTokens.toLocaleString() + ' <span style="color:var(--text-dim)">/</span> <span style="color:var(--green)">' + l.completionTokens.toLocaleString() + '</span></td>' +
      '<td class="col-cost mono" style="font-size:0.82rem;color:#3b82f6">' + costDisplay + '</td>' +
      '<td class="col-duration mono" style="font-size:0.82rem">' + duration + '</td>' +
      '<td class="col-ttfb mono" style="font-size:0.82rem;color:var(--text-dim)">' + ttfb + '</td>' +
      '<td class="col-ip" style="font-size:0.78rem;color:var(--text-dim)">' + escapeHtml(displayIp || "-") + '</td>' +
    '</tr>' +
    '<tr id="expand-' + l.requestId + '" class="log-detail" style="display:none"><td colspan="100" style="padding:10px 14px;background:var(--bg)">' +
      '<div class="inspector-card">' +
        '<div class="inspector-header">' +
          '<div class="inspector-badge-row">' +
            statusBadge +
            '<span class="badge ' + typeBadgeClass + '">' + escapeHtml(l.callType || "native") + '</span>' +
            '<span class="model-chip">' + escapeHtml(l.model) + '</span>' +
            '<span class="mono-tag">Key: <strong>' + escapeHtml(keyDisplay) + '</strong></span>' +
            '<span class="mono-tag">Account: <strong>' + escapeHtml(displayAccount || "unknown") + '</strong></span>' +
            '<span class="mono-tag">IP: <strong>' + escapeHtml(displayIp || "-") + '</strong></span>' +
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

  if (isSilent) {
    Object.keys(openExpandedIds).forEach(function(reqId) {
      var el = document.getElementById("expand-" + reqId);
      if (el) {
        el.style.display = "";
        if (activeTabs[reqId]) {
          switchInspectorTab(reqId, activeTabs[reqId]);
        }
      }
    });
  }
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
  currentKeyHash = selectedKeyValues.join(",");
  currentModel = selectedModelValues.join(",");
  currentStatus = document.getElementById("filterStatus").value;
  currentStartDate = document.getElementById("filterStartDate").value;
  currentEndDate = document.getElementById("filterEndDate").value;
  loadLogs(0);
}

function resetFilters() {
  var todayStr = getTodayDateString();
  var startEl = document.getElementById("filterStartDate");
  var endEl = document.getElementById("filterEndDate");
  if (startEl) startEl.value = todayStr;
  if (endEl) endEl.value = todayStr;
  document.getElementById("filterStatus").value = "";

  selectedKeyValues = [];
  selectedModelValues = [];
  ["key", "model"].forEach(function(t) {
    var searchInput = document.getElementById(t + "SearchInput");
    if (searchInput) searchInput.value = "";
    updateMultiselectTriggerLabel(t);
    renderMultiselectOptions(t);
  });

  currentKeyHash = "";
  currentModel = "";
  currentStatus = "";
  currentStartDate = todayStr;
  currentEndDate = todayStr;
  loadLogs(0);
}

function loadByKeySummary(filterParams) {
  var params = new URLSearchParams();
  if (filterParams) {
    ["apiKeyHash", "model", "status", "startDate", "endDate"].forEach(function(k) {
      var v = filterParams.get(k);
      if (v) params.set(k, v);
    });
  }

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

  var rowsHtml = byKey.map(function(k) {
    var avgDur = k.avgDurationMs ? Math.round(k.avgDurationMs) + "ms" : "-";
    var lastSeen = k.lastSeen ? new Date(k.lastSeen).toLocaleString() : "-";
    var keyName = k.keyAlias || k.keyName || (k.apiKeyHash ? k.apiKeyHash.slice(0, 14) + "..." : "unauthenticated");
    keyName = maskKeyDisplay(keyName);
    var costStr = formatCost(k.totalCost);

    return '<tr>' +
      '<td><strong style="color:var(--accent)" title="' + escapeHtml(MASK_MODE ? "***" : (k.apiKeyHash || "")) + '">' + escapeHtml(keyName) + '</strong></td>' +
      '<td><strong>' + k.totalRequests.toLocaleString() + '</strong></td>' +
      '<td class="mono">' + k.totalPromptTokens.toLocaleString() + '</td>' +
      '<td class="mono" style="color:var(--green)">' + k.totalCompletionTokens.toLocaleString() + '</td>' +
      '<td class="mono" style="color:#3b82f6">' + costStr + '</td>' +
      '<td class="mono">' + avgDur + '</td>' +
      '<td style="font-size:0.8rem;color:var(--text-dim)">' + lastSeen + '</td>' +
    '</tr>';
  }).join("");

  var html = '<div class="list-panel" style="margin-bottom:20px">' +
    '<div class="list-toolbar"><span class="list-toolbar-label">Spend Summary by Virtual Key / Agent</span></div>' +
    '<div style="overflow-x:auto">' +
    '<table class="compact-table"><thead><tr>' +
      '<th>Key / Agent</th><th>Total Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Est. Cost</th><th>Avg Duration</th><th>Last Active</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody>' +
    '</table></div></div>';

  container.innerHTML = html;
}

function initLogsPage() {
  updateMaskButton();
  loadColumnState();

  var todayStr = getTodayDateString();
  var startEl = document.getElementById("filterStartDate");
  var endEl = document.getElementById("filterEndDate");
  if (startEl) startEl.value = todayStr;
  if (endEl) endEl.value = todayStr;
  currentStartDate = todayStr;
  currentEndDate = todayStr;

  fetchFilterOptions();

  var savedSec = localStorage.getItem("rotatorAutoRefreshSec");
  var secVal = savedSec !== null ? savedSec : "10";
  var refreshSelect = document.getElementById("autoRefreshSelect");
  if (refreshSelect) {
    refreshSelect.value = secVal;
  }

  loadLogs(0);
  changeAutoRefresh(secVal);
  refreshHeaderStats();
  setInterval(refreshHeaderStats, 10000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLogsPage);
} else {
  initLogsPage();
}