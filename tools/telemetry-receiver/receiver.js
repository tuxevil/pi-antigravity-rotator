#!/usr/bin/env node

// ── Pi Antigravity Rotator — Telemetry Receiver ──────────────────────
//
// Minimal HTTP server that receives anonymous telemetry events
// and stores them as JSONL (one file per day).
//
// Zero dependencies — runs on Node.js 18+ with native http/fs.
//
// Usage:
//   PORT=3800 DATA_DIR=./data node receiver.js
//
// Endpoints:
//   POST /v1/events         — Receive a telemetry payload
//   GET  /v1/stats          — Aggregate stats (protected by STATS_TOKEN)
//   GET  /v1/health         — Health check
//
// Environment:
//   PORT         — Listen port (default: 3800)
//   DATA_DIR     — JSONL storage directory (default: ./data)
//   STATS_TOKEN  — Bearer token to access /v1/stats (required for stats)

import { createServer } from "node:http";
import {
	appendFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.PORT || "3800", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";
const STATS_TOKEN = process.env.STATS_TOKEN || "";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Validation ───────────────────────────────────────────────────────
const ALLOWED_EVENTS = new Set(["boot", "heartbeat", "shutdown", "flag"]);
const MAX_BODY_BYTES = 4096;
const MAX_MODELS = 20;
const MAX_STRING_LEN = 128;

function isValidPayload(data) {
	if (typeof data !== "object" || data === null) return false;
	if (!ALLOWED_EVENTS.has(data.event)) return false;
	if (typeof data.installId !== "string" || data.installId.length > 64) return false;
	if (typeof data.version !== "string" || data.version.length > MAX_STRING_LEN) return false;
	if (typeof data.nodeVersion !== "string" || data.nodeVersion.length > MAX_STRING_LEN) return false;
	if (typeof data.os !== "string" || data.os.length > MAX_STRING_LEN) return false;
	if (typeof data.arch !== "string" || data.arch.length > MAX_STRING_LEN) return false;
	if (typeof data.ts !== "string" || data.ts.length > 30) return false;
	if (typeof data.accountCount !== "number" || data.accountCount < 0 || data.accountCount > 1000) return false;
	if (!Array.isArray(data.modelsUsed) || data.modelsUsed.length > MAX_MODELS) return false;
	if (typeof data.totalRequests !== "number" || data.totalRequests < 0) return false;
	if (typeof data.uptimeSeconds !== "number" || data.uptimeSeconds < 0) return false;
	if (typeof data.routingHealthState !== "string" || data.routingHealthState.length > 30) return false;

	// Reject if any email-like string is detected anywhere
	const serialized = JSON.stringify(data);
	if (serialized.includes("@") && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]/.test(serialized)) {
		return false;
	}

	return true;
}

// ── Storage ──────────────────────────────────────────────────────────
function getDailyFile() {
	const date = new Date().toISOString().slice(0, 10);
	return join(DATA_DIR, `${date}.jsonl`);
}

function storeEvent(payload) {
	// Sanitize: keep only known fields
	const clean = {
		event: payload.event,
		installId: payload.installId,
		version: payload.version,
		nodeVersion: payload.nodeVersion,
		os: payload.os,
		arch: payload.arch,
		ts: payload.ts,
		receivedAt: new Date().toISOString(),
		accountCount: payload.accountCount,
		modelsUsed: payload.modelsUsed,
		totalRequests: payload.totalRequests,
		uptimeSeconds: payload.uptimeSeconds,
		routingHealthState: payload.routingHealthState,
		flaggedCount: payload.flaggedCount ?? 0,
		disabledCount: payload.disabledCount ?? 0,
		proCount: payload.proCount ?? 0,
		freeCount: payload.freeCount ?? 0,
		tokensByModel: sanitizeTokensByModel(payload.tokensByModel),
		featuresUsed: payload.featuresUsed ?? {},
	};

	appendFileSync(getDailyFile(), JSON.stringify(clean) + "\n", "utf-8");

	// Flag events also go to a dedicated file for easy analysis
	if (payload.event === "flag" && payload.flag) {
		const flagClean = {
			installId: payload.installId,
			version: payload.version,
			ts: payload.ts,
			receivedAt: new Date().toISOString(),
			...sanitizeFlagData(payload.flag),
		};
		const flagFile = getDailyFile().replace(".jsonl", "-flags.jsonl");
		appendFileSync(flagFile, JSON.stringify(flagClean) + "\n", "utf-8");
	}
}

function sanitizeFlagData(flag) {
	const ALLOWED_PATTERNS = new Set([
		"infring", "suspend", "abus", "terminat",
		"violat", "banned", "policy", "forbidden", "verif",
		"blocked_401",
	]);
	return {
		flagHttpStatus: typeof flag.flagHttpStatus === "number" ? flag.flagHttpStatus : 0,
		flagPatternsMatched: Array.isArray(flag.flagPatternsMatched)
			? flag.flagPatternsMatched.filter((p) => ALLOWED_PATTERNS.has(p))
			: [],
		model: typeof flag.model === "string" ? flag.model.slice(0, 64) : "unknown",
		timerType: typeof flag.timerType === "string" ? flag.timerType.slice(0, 10) : "unknown",
		accountQuotaPercent: typeof flag.accountQuotaPercent === "number" ? flag.accountQuotaPercent : -1,
		wasProAccount: !!flag.wasProAccount,
		accountTotalRequests: typeof flag.accountTotalRequests === "number" ? flag.accountTotalRequests : 0,
		accountRequestsLastHour: typeof flag.accountRequestsLastHour === "number" ? flag.accountRequestsLastHour : 0,
		accountConcurrentAtFlag: typeof flag.accountConcurrentAtFlag === "number" ? flag.accountConcurrentAtFlag : 0,
		poolSize: typeof flag.poolSize === "number" ? flag.poolSize : 0,
		poolHealthyCount: typeof flag.poolHealthyCount === "number" ? flag.poolHealthyCount : 0,
		protectivePauseTriggered: !!flag.protectivePauseTriggered,
		uptimeSeconds: typeof flag.uptimeSeconds === "number" ? flag.uptimeSeconds : 0,
		timeSinceLastFlagSeconds: typeof flag.timeSinceLastFlagSeconds === "number" ? flag.timeSinceLastFlagSeconds : -1,
	};
}

function sanitizeTokensByModel(raw) {
	if (typeof raw !== "object" || raw === null) return {};
	const MAX_MODELS = 20;
	const clean = {};
	let count = 0;
	for (const [model, data] of Object.entries(raw)) {
		if (count >= MAX_MODELS) break;
		if (typeof model !== "string" || model.length > 64) continue;
		if (typeof data !== "object" || data === null) continue;
		clean[model] = {
			input: typeof data.input === "number" && data.input >= 0 ? data.input : 0,
			output: typeof data.output === "number" && data.output >= 0 ? data.output : 0,
			requests: typeof data.requests === "number" && data.requests >= 0 ? data.requests : 0,
		};
		count++;
	}
	return clean;
}

// Pricing per 1M tokens (USD) — mirrors MODEL_PRICING in the rotator
const MODEL_PRICING = {
	"claude-opus-4-6-thinking": { inputPer1M: 5.00,  outputPer1M: 25.00 },
	"claude-sonnet-4-6":        { inputPer1M: 3.00,  outputPer1M: 15.00 },
	"gemini-3.1-pro":           { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-low":       { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-high":      { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3-flash":           { inputPer1M: 0.50,  outputPer1M: 3.00 },
};

function calculateSavings(tokensByModel) {
	let totalUsd = 0;
	const byModel = {};
	for (const [model, data] of Object.entries(tokensByModel)) {
		const pricing = MODEL_PRICING[model];
		if (!pricing) continue;
		const inputUsd = (data.input / 1_000_000) * pricing.inputPer1M;
		const outputUsd = (data.output / 1_000_000) * pricing.outputPer1M;
		byModel[model] = { inputUsd: Math.round(inputUsd * 100) / 100, outputUsd: Math.round(outputUsd * 100) / 100, totalUsd: Math.round((inputUsd + outputUsd) * 100) / 100 };
		totalUsd += inputUsd + outputUsd;
	}
	return { totalUsd: Math.round(totalUsd * 100) / 100, byModel };
}

// ── Stats ────────────────────────────────────────────────────────────
// ── Stats filtering ───────────────────────────────────────────────────
function parseQueryString(url) {
	const idx = url.indexOf("?");
	if (idx === -1) return {};
	const params = {};
	for (const part of url.slice(idx + 1).split("&")) {
		const [k, v] = part.split("=").map(decodeURIComponent);
		if (k) params[k] = v ?? "";
	}
	return params;
}

// Collect all raw events + flag events from JSONL files
function loadAllEvents() {
	const allFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith("-flags.jsonl")).sort();
	const flagFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith("-flags.jsonl")).sort();
	const events = [];
	const flagEvents = [];
	for (const file of allFiles) {
		const lines = readFileSync(join(DATA_DIR, file), "utf-8").split("\n").filter(Boolean);
		for (const line of lines) {
			try { events.push({ file, ev: JSON.parse(line) }); } catch { /* skip */ }
		}
	}
	for (const file of flagFiles) {
		const lines = readFileSync(join(DATA_DIR, file), "utf-8").split("\n").filter(Boolean);
		for (const line of lines) {
			try { flagEvents.push({ file, fl: JSON.parse(line) }); } catch { /* skip */ }
		}
	}
	return { events, flagEvents, allFiles, flagFiles };
}

// Extract filter options from all events (unfiltered, for populating dropdowns)
function buildFilterOptions(events, flagEvents) {
	const installIds = new Set();
	const versions = new Set();
	const osList = new Set();
	const models = new Set();
	const dates = new Set();
	for (const { ev, file } of events) {
		if (ev.installId) installIds.add(ev.installId);
		if (ev.version) versions.add(ev.version);
		if (ev.os) osList.add(ev.os);
		for (const m of ev.modelsUsed || []) models.add(m);
		const date = file.replace(".jsonl", "");
		if (date) dates.add(date);
	}
	return {
		installIds: [...installIds].sort(),
		versions: [...versions].sort(),
		os: [...osList].sort(),
		models: [...models].sort(),
		dateRange: { from: [...dates].sort()[0] ?? null, to: [...dates].sort().at(-1) ?? null },
	};
}

function computeStats(filters = {}) {
	const { events: allEvents, flagEvents: allFlagEvents, allFiles } = loadAllEvents();

	// Apply filters to main events
	const events = allEvents.filter(({ ev, file }) => {
		if (filters.installId && ev.installId !== filters.installId) return false;
		if (filters.version && ev.version !== filters.version) return false;
		if (filters.os && ev.os !== filters.os) return false;
		if (filters.model && !(ev.modelsUsed || []).includes(filters.model)) return false;
		const date = file.replace(".jsonl", "");
		if (filters.from && date < filters.from) return false;
		if (filters.to && date > filters.to) return false;
		return true;
	});

	// Apply filters to flag events (by installId, date)
	const flagEvents = allFlagEvents.filter(({ fl, file }) => {
		if (filters.installId && fl.installId !== filters.installId) return false;
		if (filters.model && fl.model !== filters.model) return false;
		const date = file.replace("-flags.jsonl", "");
		if (filters.from && date < filters.from) return false;
		if (filters.to && date > filters.to) return false;
		return true;
	});

	const uniqueInstalls = new Set();
	let totalEvents = 0;
	let totalBoots = 0;
	let totalFlags = 0;
	const versionCounts = {};
	const osCounts = {};
	const archCounts = {};
	const modelCounts = {};
	const healthCounts = {};
	let totalAccounts = 0;
	let totalRequests = 0;
	let featuresCount = { dashboard: 0, proAdvisor: 0, freshWindowToggle: 0, hostedLogin: 0 };

	// tokensByModel is CUMULATIVE per install (each heartbeat sends total-since-boot).
	// To avoid multi-counting, track the LATEST snapshot per installId and sum those.
	const latestTokenSnapshotByInstall = {}; // installId → { ts, tokensByModel }

	for (const { ev } of events) {
		totalEvents++;
		uniqueInstalls.add(ev.installId);
		if (ev.event === "boot") totalBoots++;
		if (ev.event === "flag") totalFlags++;
		versionCounts[ev.version] = (versionCounts[ev.version] || 0) + 1;
		osCounts[ev.os] = (osCounts[ev.os] || 0) + 1;
		archCounts[ev.arch] = (archCounts[ev.arch] || 0) + 1;
		healthCounts[ev.routingHealthState] = (healthCounts[ev.routingHealthState] || 0) + 1;
		totalAccounts += ev.accountCount || 0;
		totalRequests += ev.totalRequests || 0;
		// Keep only the most recent token snapshot per install
		if (ev.tokensByModel && typeof ev.tokensByModel === "object") {
			const prev = latestTokenSnapshotByInstall[ev.installId];
			if (!prev || ev.ts >= prev.ts) {
				latestTokenSnapshotByInstall[ev.installId] = { ts: ev.ts, tokensByModel: ev.tokensByModel };
			}
		}
		for (const m of ev.modelsUsed || []) modelCounts[m] = (modelCounts[m] || 0) + 1;
		if (ev.featuresUsed) {
			for (const [k, v] of Object.entries(ev.featuresUsed)) {
				if (v && k in featuresCount) featuresCount[k]++;
			}
		}
	}

	// Aggregate latest token snapshot per install into global totals
	const globalTokensByModel = {};
	for (const { tokensByModel } of Object.values(latestTokenSnapshotByInstall)) {
		for (const [model, data] of Object.entries(tokensByModel)) {
			if (!globalTokensByModel[model]) globalTokensByModel[model] = { input: 0, output: 0, requests: 0 };
			globalTokensByModel[model].input += data.input || 0;
			globalTokensByModel[model].output += data.output || 0;
			globalTokensByModel[model].requests += data.requests || 0;
		}
	}

	// Flag aggregates
	const flagsByStatus = {};
	const flagsByPattern = {};
	const flagsByModel = {};
	const flagsByTimerType = {};
	let flagsOnProAccounts = 0;
	let flagsOnFreeAccounts = 0;
	let flagRequestsTotal = 0;
	let flagCount = 0;

	for (const { fl } of flagEvents) {
		flagCount++;
		flagsByStatus[fl.flagHttpStatus] = (flagsByStatus[fl.flagHttpStatus] || 0) + 1;
		for (const p of fl.flagPatternsMatched || []) flagsByPattern[p] = (flagsByPattern[p] || 0) + 1;
		if (fl.model) flagsByModel[fl.model] = (flagsByModel[fl.model] || 0) + 1;
		if (fl.timerType) flagsByTimerType[fl.timerType] = (flagsByTimerType[fl.timerType] || 0) + 1;
		if (fl.wasProAccount) flagsOnProAccounts++;
		else flagsOnFreeAccounts++;
		flagRequestsTotal += fl.accountTotalRequests || 0;
	}

	const avgRequestsBeforeFlag = flagCount > 0 ? Math.round(flagRequestsTotal / flagCount) : 0;

	// Build filter options from ALL events (unfiltered) for dropdown population
	const filterOptions = buildFilterOptions(allEvents, allFlagEvents);

	return {
		filters: { ...filters },
		filterOptions,
		period: {
			from: allFiles[0]?.replace(".jsonl", "") ?? null,
			to: allFiles[allFiles.length - 1]?.replace(".jsonl", "") ?? null,
		},
		uniqueInstalls: uniqueInstalls.size,
		totalEvents,
		totalBoots,
		avgAccountsPerEvent: totalEvents > 0 ? Math.round(totalAccounts / totalEvents * 10) / 10 : 0,
		totalRequestsAcrossAll: totalRequests,
		tokensByModel: globalTokensByModel,
		savings: calculateSavings(globalTokensByModel),
		versions: versionCounts,
		os: osCounts,
		arch: archCounts,
		modelsUsed: modelCounts,
		routingHealth: healthCounts,
		featuresUsed: featuresCount,
		flags: {
			totalFlags: totalFlags + flagCount,
			byHttpStatus: flagsByStatus,
			byPattern: flagsByPattern,
			byModel: flagsByModel,
			byTimerType: flagsByTimerType,
			onProAccounts: flagsOnProAccounts,
			onFreeAccounts: flagsOnFreeAccounts,
			avgRequestsBeforeFlag,
		},
	};
}

// ── Rate limiting (simple in-memory per-IP) ──────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12; // 12 requests per minute per IP

function isRateLimited(ip) {
	const now = Date.now();
	let entry = rateLimitMap.get(ip);
	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		entry = { windowStart: now, count: 0 };
		rateLimitMap.set(ip, entry);
	}
	entry.count++;
	return entry.count > RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of rateLimitMap) {
		if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
			rateLimitMap.delete(ip);
		}
	}
}, 5 * 60_000).unref();

// ── Dashboard HTML ───────────────────────────────────────────────────
function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Pi Rotator Telemetry</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
.header{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:14px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700;color:#fff}
.header .ts{font-size:11px;color:#718096;background:#2d3748;padding:2px 8px;border-radius:10px;margin-left:auto}
.token-bar{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;gap:8px;align-items:center}
.token-bar input[type=password]{flex:1;background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:7px 12px;color:#e2e8f0;font-size:13px;font-family:monospace}
.token-bar input[type=password]:focus{outline:none;border-color:#4299e1}
.token-bar button{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap}
.token-bar button:hover{background:#3182ce}
.filter-bar{background:#141820;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.filter-group{display:flex;flex-direction:column;gap:3px;min-width:140px}
.filter-group label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.06em}
select,input[type=date]{background:#1a1f2e;border:1px solid #2d3748;border-radius:6px;padding:6px 10px;color:#e2e8f0;font-size:12px;cursor:pointer}
select:focus,input[type=date]:focus{outline:none;border-color:#4299e1}
.filter-actions{display:flex;gap:6px;margin-top:14px}
.btn-apply{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600}
.btn-clear{background:#2d3748;color:#a0aec0;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px}
.filter-active{background:#1c4532;border:1px solid #276749;border-radius:6px;padding:4px 10px;font-size:11px;color:#68d391;display:none;align-items:center;gap:6px}
.filter-active.show{display:flex}
.main{padding:20px 24px;max-width:1400px;margin:0 auto}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:18px}
.kpi{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:14px}
.kpi .label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.kpi .value{font-size:24px;font-weight:700;color:#fff}
.kpi .sub{font-size:10px;color:#718096;margin-top:3px}
.kpi.green .value{color:#68d391}.kpi.blue .value{color:#63b3ed}
.kpi.yellow .value{color:#f6e05e}.kpi.red .value{color:#fc8181}
.section{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px;margin-bottom:14px}
.section h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px}
.chart-box{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px}
.chart-box h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.chart-box canvas{max-height:190px}
.flag-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.flag-kpi{background:#2d1f1f;border:1px solid #742a2a;border-radius:8px;padding:12px}
.flag-kpi .label{font-size:10px;color:#fc8181;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.flag-kpi .value{font-size:20px;font-weight:700;color:#feb2b2}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 12px;color:#718096;border-bottom:1px solid #2d3748;font-weight:500;white-space:nowrap}
td{padding:7px 12px;border-bottom:1px solid #1f2535;color:#e2e8f0}
tr:last-child td{border-bottom:none}
.mono{font-family:monospace;color:#68d391}
.savings-big{font-size:36px;font-weight:800;color:#68d391;margin-bottom:3px}
.savings-sub{font-size:12px;color:#718096;margin-bottom:14px}
.error{background:#2d1515;border:1px solid #742a2a;border-radius:8px;padding:12px;color:#fc8181;margin-bottom:14px}
.empty{color:#4a5568;font-size:12px;padding:20px;text-align:center}
</style>
</head>
<body>
<div class="header">
  <h1>📡 Pi Rotator Telemetry</h1>
  <span class="ts" id="ts"></span>
</div>
<div class="token-bar">
  <input type="password" id="tok" placeholder="Paste STATS_TOKEN here…" />
  <button onclick="load()">Load Stats</button>
</div>

<div class="filter-bar" id="filterBar" style="display:none">
  <div class="filter-group">
    <label>Install ID</label>
    <select id="fInstall"><option value="">All installs</option></select>
  </div>
  <div class="filter-group">
    <label>Version</label>
    <select id="fVersion"><option value="">All versions</option></select>
  </div>
  <div class="filter-group">
    <label>OS</label>
    <select id="fOS"><option value="">All OS</option></select>
  </div>
  <div class="filter-group">
    <label>Model</label>
    <select id="fModel"><option value="">All models</option></select>
  </div>
  <div class="filter-group">
    <label>From</label>
    <input type="date" id="fFrom" />
  </div>
  <div class="filter-group">
    <label>To</label>
    <input type="date" id="fTo" />
  </div>
  <div class="filter-actions">
    <button class="btn-apply" onclick="applyFilters()">Apply</button>
    <button class="btn-clear" onclick="clearFilters()">Clear</button>
  </div>
  <div class="filter-active" id="filterActive">
    🔍 Filtered view
  </div>
</div>

<div class="main">
  <div class="error" id="err" style="display:none"></div>
  <div id="app" style="display:none">
    <div class="kpi-grid" id="kpis"></div>
    <div class="section">
      <h2>💰 Estimated Savings (USD vs paid API)</h2>
      <div class="savings-big" id="savTotal">$0.00</div>
      <div class="savings-sub">Total saved across filtered installs</div>
      <div id="savTable"></div>
    </div>
    <div class="section">
      <h2>🚨 Flag Analysis</h2>
      <div class="flag-kpis" id="flagKpis"></div>
      <div class="charts">
        <div class="chart-box"><h2>By Pattern</h2><canvas id="cPatterns"></canvas></div>
        <div class="chart-box"><h2>By Model</h2><canvas id="cFlagModels"></canvas></div>
        <div class="chart-box"><h2>By Timer Type</h2><canvas id="cTimerType"></canvas></div>
      </div>
    </div>
    <div class="section">
      <h2>📊 Token Usage by Model</h2>
      <div id="tokTable"></div>
    </div>
    <div class="charts">
      <div class="chart-box"><h2>Versions</h2><canvas id="cVersions"></canvas></div>
      <div class="chart-box"><h2>OS</h2><canvas id="cOS"></canvas></div>
      <div class="chart-box"><h2>Models Active</h2><canvas id="cModels"></canvas></div>
      <div class="chart-box"><h2>Routing Health</h2><canvas id="cHealth"></canvas></div>
      <div class="chart-box"><h2>Features Used</h2><canvas id="cFeatures"></canvas></div>
    </div>
  </div>
</div>

<script>
const C=['#63b3ed','#68d391','#f6e05e','#b794f4','#fc8181','#fbd38d','#76e4f7','#a3bffa'];
const R=['#fc8181','#f6ad55','#faf089','#b794f4','#feb2b2'];
const charts={};
let _token='';
let _filterOptions={};

function $(i){return document.getElementById(i)}
function fmt(n){return n==null?'—':Number(n).toLocaleString()}
function usd(n){return '$'+Number(n||0).toFixed(2)}

function mkChart(id,type,labels,datasets){
  if(charts[id])charts[id].destroy();
  const ctx=$(id)?.getContext('2d');if(!ctx)return;
  charts[id]=new Chart(ctx,{type,data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:true,
    plugins:{legend:{labels:{color:'#a0aec0',font:{size:11}}}},
    scales:type==='bar'?{x:{ticks:{color:'#718096'},grid:{color:'#2d3748'}},y:{ticks:{color:'#718096'},grid:{color:'#2d3748'}}}:undefined
  }});
}

async function load(){
  const t=$('tok').value.trim();
  if(!t)return;
  _token=t;
  localStorage.setItem('st',t);
  await go({});
}

function buildParams(f){
  const p=new URLSearchParams();
  if(f.installId)p.set('installId',f.installId);
  if(f.version)p.set('version',f.version);
  if(f.os)p.set('os',f.os);
  if(f.model)p.set('model',f.model);
  if(f.from)p.set('from',f.from);
  if(f.to)p.set('to',f.to);
  return p.toString();
}

async function go(filters){
  const qs=buildParams(filters);
  const url='/v1/stats'+(qs?'?'+qs:'');
  try{
    const r=await fetch(url,{headers:{'Authorization':'Bearer '+_token}});
    if(r.status===401){showErr('Invalid token');return}
    if(!r.ok){showErr('Server error '+r.status);return}
    const d=await r.json();
    $('err').style.display='none';
    $('app').style.display='block';
    $('filterBar').style.display='flex';
    $('ts').textContent='Updated '+new Date().toLocaleTimeString();
    render(d,filters);
  }catch(e){showErr(e.message);}
}

function showErr(msg){$('err').textContent='⚠ '+msg;$('err').style.display='';}

function applyFilters(){
  const f={};
  const i=$('fInstall').value;if(i)f.installId=i;
  const v=$('fVersion').value;if(v)f.version=v;
  const o=$('fOS').value;if(o)f.os=o;
  const m=$('fModel').value;if(m)f.model=m;
  const fr=$('fFrom').value;if(fr)f.from=fr;
  const to=$('fTo').value;if(to)f.to=to;
  const hasFilters=Object.keys(f).length>0;
  const fa=$('filterActive');
  if(hasFilters){fa.classList.add('show');fa.textContent='🔍 Filtered: '+Object.entries(f).map(([k,v])=>k+'='+v).join(', ');}
  else{fa.classList.remove('show');}
  go(f);
}

function clearFilters(){
  $('fInstall').value='';
  $('fVersion').value='';
  $('fOS').value='';
  $('fModel').value='';
  $('fFrom').value='';
  $('fTo').value='';
  $('filterActive').classList.remove('show');
  go({});
}

function populateDropdowns(opts){
  _filterOptions=opts;
  const cur={install:$('fInstall').value,ver:$('fVersion').value,os:$('fOS').value,model:$('fModel').value};
  fillSelect('fInstall',opts.installIds,'All installs',cur.install);
  fillSelect('fVersion',opts.versions,'All versions',cur.ver);
  fillSelect('fOS',opts.os,'All OS',cur.os);
  fillSelect('fModel',opts.models,'All models',cur.model);
  if(opts.dateRange?.from&&!$('fFrom').value)$('fFrom').value=opts.dateRange.from;
}

function fillSelect(id,items,placeholder,selected){
  const el=$(id);
  el.innerHTML='<option value="">'+placeholder+'</option>';
  for(const it of items){
    const o=document.createElement('option');
    o.value=it;o.textContent=it;
    if(it===selected)o.selected=true;
    el.appendChild(o);
  }
}

function render(d, filters={}){
  if(d.filterOptions)populateDropdowns(d.filterOptions);

  $('kpis').innerHTML=[
    {l:'Unique Installs',v:fmt(d.uniqueInstalls),c:'green'},
    {l:'Total Events',v:fmt(d.totalEvents),c:'blue'},
    {l:'Boots',v:fmt(d.totalBoots),c:'blue'},
    {l:'Avg Accounts',v:d.avgAccountsPerEvent,c:''},
    {l:'Total Requests',v:fmt(d.totalRequestsAcrossAll),c:'yellow'},
    {l:'Flags Detected',v:fmt(d.flags?.totalFlags||0),c:'red'},
    {l:'Avg Req/Flag',v:fmt(d.flags?.avgRequestsBeforeFlag||0),c:'red'},
    {l:'Period',v:d.period?.from||'—',sub:d.period?.to?'→ '+d.period.to:''},
  ].map(k=>'<div class="kpi '+k.c+'"><div class="label">'+k.l+'</div><div class="value">'+k.v+'</div>'+(k.sub?'<div class="sub">'+k.sub+'</div>':'')+'</div>').join('');

  const sv=d.savings||{};
  $('savTotal').textContent=usd(sv.totalUsd);
  const svRows=Object.entries(sv.byModel||{}).map(([m,v])=>'<tr><td class="mono">'+m+'</td><td>'+usd(v.inputUsd)+'</td><td>'+usd(v.outputUsd)+'</td><td><strong>'+usd(v.totalUsd)+'</strong></td></tr>').join('');
  $('savTable').innerHTML=svRows?'<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>'+svRows+'</tbody></table>':'<div class="empty">No data yet</div>';

  const fl=d.flags||{};
  $('flagKpis').innerHTML=[
    {l:'Total Flags',v:fmt(fl.totalFlags||0)},
    {l:'On Pro Accounts',v:fmt(fl.onProAccounts||0)},
    {l:'On Free Accounts',v:fmt(fl.onFreeAccounts||0)},
    {l:'Avg Requests Before Flag',v:fmt(fl.avgRequestsBeforeFlag||0)},
  ].map(k=>'<div class="flag-kpi"><div class="label">'+k.l+'</div><div class="value">'+k.v+'</div></div>').join('');
  mkChart('cPatterns','bar',Object.keys(fl.byPattern||{}),[{label:'Count',data:Object.values(fl.byPattern||{}),backgroundColor:R}]);
  mkChart('cFlagModels','doughnut',Object.keys(fl.byModel||{}),[{data:Object.values(fl.byModel||{}),backgroundColor:C}]);
  mkChart('cTimerType','doughnut',Object.keys(fl.byTimerType||{}),[{data:Object.values(fl.byTimerType||{}),backgroundColor:['#63b3ed','#f6e05e','#68d391']}]);

  const tk=d.tokensByModel||{};
  $('tokTable').innerHTML=Object.keys(tk).length?'<table><thead><tr><th>Model</th><th>Input Tokens</th><th>Output Tokens</th><th>Requests</th></tr></thead><tbody>'+Object.entries(tk).map(([m,v])=>'<tr><td class="mono">'+m+'</td><td>'+fmt(v.input)+'</td><td>'+fmt(v.output)+'</td><td>'+fmt(v.requests)+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No token data yet</div>';

  mkChart('cVersions','bar',Object.keys(d.versions||{}),[{label:'Events',data:Object.values(d.versions||{}),backgroundColor:'#63b3ed'}]);
  mkChart('cOS','doughnut',Object.keys(d.os||{}),[{data:Object.values(d.os||{}),backgroundColor:C}]);
  mkChart('cModels','doughnut',Object.keys(d.modelsUsed||{}),[{data:Object.values(d.modelsUsed||{}),backgroundColor:C}]);
  mkChart('cHealth','doughnut',Object.keys(d.routingHealth||{}),[{data:Object.values(d.routingHealth||{}),backgroundColor:['#68d391','#f6e05e','#fc8181','#718096']}]);
  mkChart('cFeatures','bar',Object.keys(d.featuresUsed||{}),[{label:'Times used',data:Object.values(d.featuresUsed||{}),backgroundColor:'#b794f4'}]);
}

const saved=localStorage.getItem('st');
if(saved){_token=saved;$('tok').value=saved;go({});}
setInterval(()=>{if(_token){const f={};const i=$('fInstall').value;if(i)f.installId=i;const v=$('fVersion').value;if(v)f.version=v;const o=$('fOS').value;if(o)f.os=o;const m=$('fModel').value;if(m)f.model=m;const fr=$('fFrom').value;if(fr)f.from=fr;const to=$('fTo').value;if(to)f.to=to;go(f);}},60000);
</script>
</body></html>`;
}
// ── HTTP Server ──────────────────────────────────────────────────────
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("Payload too large"));
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	const method = req.method?.toUpperCase();
	const url = req.url || "";

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Dashboard
	if (method === "GET" && (url === "/" || url === "/dashboard")) {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(buildDashboardHtml());
		return;
	}

	// Health check
	if (method === "GET" && url === "/v1/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
		return;
	}

	// Stats (protected)
	if (method === "GET" && url.startsWith("/v1/stats")) {
		if (!STATS_TOKEN) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "STATS_TOKEN not configured" }));
			return;
		}
		const auth = req.headers.authorization || "";
		if (auth !== `Bearer ${STATS_TOKEN}`) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}
		try {
			const q = parseQueryString(url);
			const filters = {};
			if (q.installId) filters.installId = q.installId;
			if (q.version) filters.version = q.version;
			if (q.os) filters.os = q.os;
			if (q.model) filters.model = q.model;
			if (q.from) filters.from = q.from;
			if (q.to) filters.to = q.to;
			const stats = computeStats(filters);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(stats, null, 2));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to compute stats" }));
		}
		return;
	}

	// Collect telemetry
	if (method === "POST" && url === "/v1/events") {
		const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
		if (isRateLimited(ip)) {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Too many requests" }));
			return;
		}

		try {
			const body = await readBody(req);
			const data = JSON.parse(body);

			if (!isValidPayload(data)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid payload" }));
				return;
			}

			storeEvent(data);
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ accepted: true }));
		} catch (err) {
			if (err.message === "Payload too large") {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Payload too large" }));
			} else {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Bad request" }));
			}
		}
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`Telemetry receiver listening on 0.0.0.0:${PORT}`);
	console.log(`Data dir: ${DATA_DIR}`);
	console.log(`Stats: ${STATS_TOKEN ? "protected by STATS_TOKEN" : "⚠ STATS_TOKEN not set — /v1/stats disabled"}`);
});
