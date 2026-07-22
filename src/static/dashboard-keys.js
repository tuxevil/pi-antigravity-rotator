var ADMIN_TOKEN =
  new URLSearchParams(window.location.search).get("token") ||
  localStorage.getItem("rotatorAdminToken") ||
  "";
if (ADMIN_TOKEN) localStorage.setItem("rotatorAdminToken", ADMIN_TOKEN);

function authHeaders() {
  return ADMIN_TOKEN ? { "X-Rotator-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json" } : {};
}

var keys = [];
var editingKey = null;

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getCheckedModels() {
  var cbs = document.querySelectorAll(".modelCb:checked");
  return Array.from(cbs).map(function(c) { return c.value; });
}

function updateModelsCountBadge() {
  var allCbs = document.querySelectorAll(".modelCb");
  var checkedCbs = document.querySelectorAll(".modelCb:checked");
  var badge = document.getElementById("modelsCountBadge");
  if (!badge) return;
  if (checkedCbs.length === 0 || checkedCbs.length === allCbs.length) {
    badge.textContent = "All models allowed";
    badge.style.color = "var(--accent)";
    badge.style.borderColor = "rgba(124, 92, 252, 0.25)";
  } else {
    badge.textContent = checkedCbs.length + " of " + allCbs.length + " models selected";
    badge.style.color = "var(--yellow)";
    badge.style.borderColor = "rgba(251, 191, 36, 0.3)";
  }
}

function selectAllModels() {
  document.querySelectorAll(".modelCb").forEach(function(c) { c.checked = true; });
  updateModelsCountBadge();
}

function selectNoModels() {
  document.querySelectorAll(".modelCb").forEach(function(c) { c.checked = false; });
  updateModelsCountBadge();
}

function setCheckedModels(models) {
  var cbs = document.querySelectorAll(".modelCb");
  cbs.forEach(function(c) { c.checked = models.length === 0 || models.indexOf(c.value) >= 0; });
  updateModelsCountBadge();
}

function loadKeys() {
  fetch("/api/keys", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      keys = d.keys || [];
      renderKeys();
    })
    .catch(function(e) { alert("Failed to load keys: " + e.message); });
}

function renderKeys() {
  var tbody = document.getElementById("keysTbody");
  if (!tbody) return;
  if (keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim)">No virtual keys yet. Click "Generate Key" to create one.</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(function(k) {
    var blocked = k.blocked ? '<span style="color:var(--red)">BLOCKED</span>' : '<span style="color:var(--green)">active</span>';
    var models = (k.models && k.models.length > 0) ? escapeHtml(k.models.join(", ")) : '<span style="color:var(--text-dim)">all models</span>';
    var lastActive = k.lastActive ? new Date(k.lastActive).toLocaleString() : "never";
    return '<tr>' +
      '<td><strong>' + escapeHtml(k.keyAlias) + '</strong></td>' +
      '<td class="mono">' + escapeHtml(k.keyName) + '</td>' +
      '<td>' + escapeHtml(k.userId || "-") + '</td>' +
      '<td>' + models + '</td>' +
      '<td>' + blocked + '</td>' +
      '<td style="font-size:0.8rem">' + lastActive + '</td>' +
      '<td>' +
        '<button class="btn-action" onclick="showEditModal(\'' + k.tokenHash + '\')" title="Edit">&#9998;</button>' +
        '<button class="btn-action" onclick="blockKey(\'' + k.tokenHash + '\', ' + !k.blocked + ')" title="' + (k.blocked ? "Unblock" : "Block") + '">' + (k.blocked ? "&#9654;" : "&#9632;") + '</button>' +
        '<button class="btn-action" onclick="deleteKey(\'' + k.tokenHash + '\')" title="Delete">&#10005;</button>' +
      '</td>' +
    '</tr>';
  }).join("");
}

function showGenerateModal() {
  editingKey = null;
  document.getElementById("keyFormAlias").value = "";
  document.getElementById("keyFormAlias").disabled = false;
  document.getElementById("keyFormUserId").value = "";
  document.getElementById("keyFormUserId").disabled = false;
  selectNoModels();
  document.getElementById("keyFormError").textContent = "";
  document.getElementById("generatedKeyResult").style.display = "none";
  document.getElementById("submitKeyBtn").textContent = "Generate Key";
  document.getElementById("modelCheckboxes").style.display = "";
  document.getElementById("modalTitle").textContent = "Generate Virtual Key";
  var sub = document.getElementById("modalSubtitle");
  if (sub) sub.textContent = "Configure key access and model restrictions";
  document.getElementById("keyModal").style.display = "flex";
}

function showEditModal(hash) {
  var k = null;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].tokenHash === hash) { k = keys[i]; break; }
  }
  if (!k) return;

  editingKey = k;
  document.getElementById("keyFormAlias").value = k.keyAlias;
  document.getElementById("keyFormAlias").disabled = true;
  document.getElementById("keyFormUserId").value = k.userId || "";
  document.getElementById("keyFormUserId").disabled = true;
  setCheckedModels(k.models || []);
  document.getElementById("keyFormError").textContent = "";
  document.getElementById("generatedKeyResult").style.display = "none";
  document.getElementById("submitKeyBtn").textContent = "Save Changes";
  document.getElementById("modelCheckboxes").style.display = "";
  document.getElementById("modalTitle").textContent = "Edit Virtual Key";
  var sub = document.getElementById("modalSubtitle");
  if (sub) sub.textContent = "Updating model restrictions for alias: " + k.keyAlias;
  document.getElementById("keyModal").style.display = "flex";
}

function hideModal() {
  document.getElementById("keyModal").style.display = "none";
}

function submitKeyForm() {
  if (editingKey) {
    submitEditKey();
    return;
  }

  var alias = document.getElementById("keyFormAlias").value.trim();
  if (!alias) {
    document.getElementById("keyFormError").textContent = "Alias is required";
    return;
  }
  var userId = document.getElementById("keyFormUserId").value.trim() || null;
  var models = getCheckedModels();

  document.getElementById("keyFormError").textContent = "";

  fetch("/api/keys/generate", { method: "POST", headers: authHeaders(), body: JSON.stringify({ alias: alias, userId: userId, models: models }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { document.getElementById("keyFormError").textContent = d.error; return; }
      document.getElementById("generatedRawKey").textContent = d.rawKey;
      document.getElementById("generatedKeyResult").style.display = "block";
      document.getElementById("modelCheckboxes").style.display = "none";
      loadKeys();
    })
    .catch(function(e) { document.getElementById("keyFormError").textContent = e.message; });
}

function submitEditKey() {
  if (!editingKey) return;
  var models = getCheckedModels();

  document.getElementById("keyFormError").textContent = "";

  fetch("/api/keys/" + editingKey.tokenHash, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ models: models })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { document.getElementById("keyFormError").textContent = d.error; return; }
      hideModal();
      loadKeys();
    })
    .catch(function(e) { document.getElementById("keyFormError").textContent = e.message; });
}

function copyRawKey() {
  var txt = document.getElementById("generatedRawKey").textContent;
  navigator.clipboard.writeText(txt).then(function() {
    var btn = document.getElementById("copyKeyBtn");
    btn.textContent = "Copied!";
    setTimeout(function() { btn.textContent = "Copy"; }, 2000);
  });
}

function blockKey(hash, blocked) {
  if (!confirm(blocked ? "Block this key? Requests using it will be rejected." : "Unblock this key?")) return;
  fetch("/api/keys/" + hash, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ blocked: blocked }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { alert("Failed: " + d.error); return; }
      loadKeys();
    });
}

function deleteKey(hash) {
  if (!confirm("Delete this virtual key? This CANNOT be undone. Spend logs are retained.")) return;
  fetch("/api/keys/" + hash, { method: "DELETE", headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { alert("Failed: " + d.error); return; }
      loadKeys();
    });
}

document.addEventListener("DOMContentLoaded", function() {
  loadKeys();
  var modal = document.getElementById("keyModal");
  if (modal) {
    modal.addEventListener("click", function(e) {
      if (e.target === modal) hideModal();
    });
  }
});
