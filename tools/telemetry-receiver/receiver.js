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
	writeFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || "3800", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";
const STATS_TOKEN = process.env.STATS_TOKEN || "";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function isStatsAuthorized(req) {
	return STATS_TOKEN.length > 0 &&
		req.headers.authorization === "Bearer " + STATS_TOKEN;
}

function sendUnauthorized(res) {
	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Unauthorized" }));
}

function requireStatsAuth(req, res) {
	if (!STATS_TOKEN) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "STATS_TOKEN not configured" }));
		return false;
	}
	if (!isStatsAuthorized(req)) {
		sendUnauthorized(res);
		return false;
	}
	return true;
}

// ── Notifications Storage ────────────────────────────────────────────
const NOTIFICATIONS_FILE = join(DATA_DIR, "notifications.json");

function loadNotifications() {
	try {
		if (existsSync(NOTIFICATIONS_FILE)) {
			return JSON.parse(readFileSync(NOTIFICATIONS_FILE, "utf-8"));
		}
	} catch { /* corrupted file, start fresh */ }
	return [];
}

function saveNotifications(notifications) {
	writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2), "utf-8");
}

const NOTIFICATION_TYPES = new Set(["info", "warning", "critical"]);
const MAX_NOTIFICATION_STRING_LEN = 512;

function isOptionalNotificationString(value) {
	return value === undefined || value === null ||
		(typeof value === "string" && value.length <= MAX_NOTIFICATION_STRING_LEN);
}

function isSafeNotificationUrl(value) {
	if (value === undefined || value === null || value === "") return true;
	if (typeof value !== "string" || value.length > MAX_NOTIFICATION_STRING_LEN) return false;
	try {
		const parsed = new URL(value, "http://localhost");
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isValidNotificationInput(data) {
	if (typeof data !== "object" || data === null) return false;
	if (data.id !== undefined && (typeof data.id !== "string" || data.id.length > MAX_NOTIFICATION_STRING_LEN)) return false;
	if (typeof data.title !== "string" || data.title.length === 0 || data.title.length > MAX_NOTIFICATION_STRING_LEN) return false;
	if (typeof data.message !== "string" || data.message.length === 0 || data.message.length > MAX_NOTIFICATION_STRING_LEN) return false;
	if (data.type !== undefined && !NOTIFICATION_TYPES.has(data.type)) return false;
	if (!isOptionalNotificationString(data.createdAt)) return false;
	if (!isOptionalNotificationString(data.expiresAt)) return false;
	if (!isOptionalNotificationString(data.minVersion)) return false;
	if (!isOptionalNotificationString(data.maxVersion)) return false;
	if (!isSafeNotificationUrl(data.actionUrl)) return false;
	if (!isOptionalNotificationString(data.actionLabel)) return false;
	return true;
}

/**
 * Simple semver comparison: returns true if a < b.
 */
function semverLt(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const av = pa[i] ?? 0;
		const bv = pb[i] ?? 0;
		if (av < bv) return true;
		if (av > bv) return false;
	}
	return false;
}

function semverLte(a, b) {
	return a === b || semverLt(a, b);
}

/**
 * Filter notifications for a client with a given version.
 * Removes expired notifications and applies version targeting.
 */
function getActiveNotifications(clientVersion) {
	const all = loadNotifications();
	const now = new Date().toISOString();
	return all.filter((n) => {
		// Filter expired
		if (n.expiresAt && n.expiresAt < now) return false;
		// Version targeting
		if (clientVersion) {
			if (n.minVersion && semverLt(clientVersion, n.minVersion)) return false;
			if (n.maxVersion && !semverLte(clientVersion, n.maxVersion)) return false;
		}
		return true;
	}).map((n) => ({
		id: n.id,
		type: n.type || "info",
		title: n.title,
		message: n.message,
		createdAt: n.createdAt,
		actionUrl: n.actionUrl || null,
		actionLabel: n.actionLabel || null,
	}));
}

// ── Validation ───────────────────────────────────────────────────────
const ALLOWED_EVENTS = new Set(["boot", "heartbeat", "shutdown", "flag"]);
const MAX_BODY_BYTES = 4096;
const MAX_MODELS = 20;
const MAX_STRING_LEN = 128;

function isCorePayload(data) {
	if (typeof data !== "object" || data === null) return false;
	if (typeof data.installId !== "string" || data.installId.length > 64) return false;
	if (typeof data.version !== "string" || data.version.length > MAX_STRING_LEN) return false;
	if (typeof data.ts !== "string" || data.ts.length > 30) return false;

	return true;
}

function isHeartbeatPayload(data) {
	if (!isCorePayload(data)) return false;
	if (typeof data.nodeVersion !== "string" || data.nodeVersion.length > MAX_STRING_LEN) return false;
	if (typeof data.os !== "string" || data.os.length > MAX_STRING_LEN) return false;
	if (typeof data.arch !== "string" || data.arch.length > MAX_STRING_LEN) return false;
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

function isFlagPayload(data) {
	if (!isCorePayload(data)) return false;
	if (data.event !== "flag") return false;
	if (typeof data.flag !== "object" || data.flag === null) return false;
	const flag = data.flag;
	if (typeof flag.flagHttpStatus !== "number") return false;
	if (!Array.isArray(flag.flagPatternsMatched)) return false;
	if (typeof flag.model !== "string") return false;
	if (typeof flag.timerType !== "string") return false;
	if (typeof flag.accountQuotaPercent !== "number") return false;
	if (typeof flag.wasProAccount !== "boolean") return false;
	if (typeof flag.accountTotalRequests !== "number") return false;
	if (typeof flag.accountRequestsLastHour !== "number") return false;
	if (typeof flag.accountConcurrentAtFlag !== "number") return false;
	if (typeof flag.poolSize !== "number") return false;
	if (typeof flag.poolHealthyCount !== "number") return false;
	if (typeof flag.protectivePauseTriggered !== "boolean") return false;
	if (typeof flag.uptimeSeconds !== "number") return false;
	if (typeof flag.timeSinceLastFlagSeconds !== "number") return false;

	const serialized = JSON.stringify(data);
	if (serialized.includes("@") && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]/.test(serialized)) {
		return false;
	}

	return true;
}

function isValidPayload(data) {
	if (typeof data !== "object" || data === null) return false;
	if (!ALLOWED_EVENTS.has(data.event)) return false;
	if (data.event === "flag") return isFlagPayload(data);
	return isHeartbeatPayload(data);
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
	const clean = Object.create(null);
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
	"gemini-3.5-flash":         { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-low":     { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-high":    { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.6-flash":         { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-high":    { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-low":     { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-tiered":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gpt-oss-120b-medium":      { inputPer1M: 2.00,  outputPer1M: 10.00 },
};

function getModelPricing(model) {
	if (MODEL_PRICING[model]) return MODEL_PRICING[model];
	const lower = (model || "").toLowerCase();
	if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6-thinking"];
	if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
	if (lower.includes("3.6-flash")) return MODEL_PRICING["gemini-3.6-flash-high"];
	if (lower.includes("3.5-flash")) return MODEL_PRICING["gemini-3.5-flash-high"];
	if (lower.includes("flash")) return MODEL_PRICING["gemini-3-flash"];
	if (lower.includes("pro")) return MODEL_PRICING["gemini-3.1-pro"];
	return null;
}

function calculateSavings(tokensByModel) {
	let totalUsd = 0;
	const byModel = Object.create(null);
	for (const [model, data] of Object.entries(tokensByModel)) {
		const pricing = getModelPricing(model);
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
	const params = Object.create(null);
	for (const part of url.slice(idx + 1).split("&")) {
		const separator = part.indexOf("=");
		const rawKey = separator === -1 ? part : part.slice(0, separator);
		const rawValue = separator === -1 ? "" : part.slice(separator + 1);
		try {
			const k = decodeURIComponent(rawKey);
			if (k) params[k] = decodeURIComponent(rawValue);
		} catch {
			// Ignore malformed query components.
		}
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


// ── Per-install list ─────────────────────────────────────────────────
// Returns one summary row per unique installId based on their latest
// heartbeat/boot event + flag count over the same filtered window.
function computeInstallList(filters = {}) {
	const { events: allEvents, flagEvents: allFlagEvents } = loadAllEvents();

	// Apply same filters as computeStats
	const events = allEvents.filter(({ ev, file }) => {
		if (filters.installId && ev.installId !== filters.installId) return false;
		if (filters.version   && ev.version   !== filters.version)   return false;
		if (filters.os        && ev.os        !== filters.os)        return false;
		if (filters.model     && !(ev.modelsUsed || []).includes(filters.model)) return false;
		const date = file.replace('.jsonl', '');
		if (filters.from && date < filters.from) return false;
		if (filters.to   && date > filters.to)   return false;
		return true;
	});

	const flagEvents = allFlagEvents.filter(({ fl, file }) => {
		if (filters.installId && fl.installId !== filters.installId) return false;
		const date = file.replace('-flags.jsonl', '');
		if (filters.from && date < filters.from) return false;
		if (filters.to   && date > filters.to)   return false;
		return true;
	});

	// Latest heartbeat snapshot per install
	const latest = Object.create(null); // installId -> ev
	for (const { ev } of events) {
		const prev = latest[ev.installId];
		if (!prev || ev.ts >= prev.ts) latest[ev.installId] = ev;
	}

	// First seen per install
	const firstSeen = Object.create(null);
	for (const { ev } of events) {
		if (!firstSeen[ev.installId] || ev.ts < firstSeen[ev.installId])
			firstSeen[ev.installId] = ev.ts;
	}

	// Flag counts per install
	const flagsByInstall = Object.create(null);
	for (const { fl } of flagEvents) {
		flagsByInstall[fl.installId] = (flagsByInstall[fl.installId] || 0) + 1;
	}

	// Total requests per install (max across all events — it's cumulative)
	const maxRequests = Object.create(null);
	for (const { ev } of events) {
		const cur = maxRequests[ev.installId] || 0;
		if ((ev.totalRequests || 0) > cur) maxRequests[ev.installId] = ev.totalRequests || 0;
	}

	const list = Object.values(latest).map((ev) => {
		const tokens = ev.tokensByModel && typeof ev.tokensByModel === 'object'
			? ev.tokensByModel : {};
		const savings = calculateSavings(tokens);
		return {
			installId:          ev.installId,
			version:            ev.version || '?',
			os:                 ev.os || '?',
			arch:               ev.arch || '?',
			accountCount:       ev.accountCount || 0,
			totalRequests:      maxRequests[ev.installId] || 0,
			routingHealthState: ev.routingHealthState || 'unknown',
			flaggedCount:       ev.flaggedCount || 0,
			disabledCount:      ev.disabledCount || 0,
			proCount:           ev.proCount || 0,
			freeCount:          ev.freeCount || 0,
			tokensByModel:      tokens,
			savingsUsd:         savings.totalUsd,
			flagEvents:         flagsByInstall[ev.installId] || 0,
			lastSeen:           ev.ts,
			firstSeen:          firstSeen[ev.installId] || ev.ts,
			featuresUsed:       ev.featuresUsed || {},
		};
	});

	// Sort by totalRequests desc by default
	list.sort((a, b) => b.totalRequests - a.totalRequests);
	return list;
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
	const versionCounts = Object.create(null);
	const osCounts = Object.create(null);
	const archCounts = Object.create(null);
	const modelCounts = Object.create(null);
	const healthCounts = Object.create(null);
	let totalAccounts = 0;
	let totalRequests = 0;
	let featuresCount = { dashboard: 0, proAdvisor: 0, freshWindowToggle: 0, hostedLogin: 0 };

	// tokensByModel is CUMULATIVE per install (each heartbeat sends total-since-boot).
	// To avoid multi-counting, track the LATEST snapshot per installId and sum those.
	const latestTokenSnapshotByInstall = Object.create(null); // installId → { ts, tokensByModel }

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
	const globalTokensByModel = Object.create(null);
	for (const { tokensByModel } of Object.values(latestTokenSnapshotByInstall)) {
		for (const [model, data] of Object.entries(tokensByModel)) {
			if (!globalTokensByModel[model]) globalTokensByModel[model] = { input: 0, output: 0, requests: 0 };
			globalTokensByModel[model].input += data.input || 0;
			globalTokensByModel[model].output += data.output || 0;
			globalTokensByModel[model].requests += data.requests || 0;
		}
	}

	// Flag aggregates
	const flagsByStatus = Object.create(null);
	const flagsByPattern = Object.create(null);
	const flagsByModel = Object.create(null);
	const flagsByTimerType = Object.create(null);
	let flagsOnProAccounts = 0;
	let flagsOnFreeAccounts = 0;
	let flagRequestsTotal = 0;
	let flagCount = 0;
	const uniqueFlagSignatures = new Set();

	for (const { fl } of flagEvents) {
		flagCount++;
		flagsByStatus[fl.flagHttpStatus] = (flagsByStatus[fl.flagHttpStatus] || 0) + 1;
		for (const p of fl.flagPatternsMatched || []) flagsByPattern[p] = (flagsByPattern[p] || 0) + 1;
		if (fl.model) flagsByModel[fl.model] = (flagsByModel[fl.model] || 0) + 1;
		if (fl.timerType) flagsByTimerType[fl.timerType] = (flagsByTimerType[fl.timerType] || 0) + 1;
		if (fl.wasProAccount) flagsOnProAccounts++;
		else flagsOnFreeAccounts++;
		flagRequestsTotal += fl.accountTotalRequests || 0;
		const signature = JSON.stringify({
			status: fl.flagHttpStatus,
			patterns: [...(fl.flagPatternsMatched || [])].sort(),
			model: fl.model || "",
			timerType: fl.timerType || "",
			quota: fl.accountQuotaPercent,
			pro: !!fl.wasProAccount,
			pause: !!fl.protectivePauseTriggered,
		});
		uniqueFlagSignatures.add(signature);
	}

	const avgRequestsBeforeFlag = flagCount > 0 ? Math.round(flagRequestsTotal / flagCount) : 0;
	const uniqueFlagIncidents = uniqueFlagSignatures.size;

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
			uniqueIncidents: uniqueFlagIncidents,
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

/* ── View toggle ── */
.view-tabs{display:flex;gap:8px;padding:12px 24px;background:#141820;border-bottom:1px solid #2d3748}
.view-tab{font-size:12px;font-weight:600;padding:5px 14px;border-radius:999px;border:1px solid #2d3748;background:transparent;color:#718096;cursor:pointer;font-family:inherit;transition:all .2s}
.view-tab.active{background:rgba(66,153,225,.15);border-color:rgba(66,153,225,.4);color:#63b3ed}
.view-tab:hover:not(.active){background:rgba(255,255,255,.04);color:#e2e8f0}

/* ── Installs list ── */
.install-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.install-search{background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:6px 12px;color:#e2e8f0;font-size:12px;font-family:inherit;width:200px;outline:none;transition:border-color .2s}
.install-search:focus{border-color:#4299e1}
.sort-btn{font-size:11px;padding:4px 10px;border:1px solid #2d3748;background:transparent;color:#718096;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .2s}
.sort-btn.active{border-color:rgba(66,153,225,.4);color:#63b3ed;background:rgba(66,153,225,.08)}
.install-table{width:100%;border-collapse:collapse}
.install-table th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#718096;padding:8px 12px;text-align:left;border-bottom:1px solid #2d3748;background:rgba(255,255,255,.02);white-space:nowrap;cursor:pointer;user-select:none}
.install-table th:hover{color:#e2e8f0}
.install-table th .arr{display:inline-block;margin-left:3px;opacity:.35;font-size:9px}
.install-table th.sort-active .arr{opacity:1;color:#63b3ed}
.install-table td{padding:9px 12px;font-size:12px;border-bottom:1px solid #1f2535;vertical-align:middle}
.install-table tr:last-child td{border-bottom:none}
.install-row{cursor:pointer;transition:background .15s}
.install-row:hover td{background:rgba(66,153,225,.05)}
.install-row.selected td{background:rgba(66,153,225,.1)}
.install-id{font-family:monospace;font-size:11px;color:#718096}
.install-id strong{color:#63b3ed;display:block;font-size:12px;margin-bottom:1px}
.mini-bar{display:flex;align-items:center;gap:5px}
.mini-bar-bg{width:50px;height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;flex-shrink:0}
.mini-bar-fill{height:100%;border-radius:2px}
.health-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;flex-shrink:0}
.install-list-panel{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px}
.install-list-panel h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
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

<div class="view-tabs" id="viewTabs" style="display:none"><button class="view-tab active" id="vtAgg" onclick="switchView(&apos;agg&apos;)">■ Aggregated</button><button class="view-tab" id="vtList" onclick="switchView(&apos;list&apos;)">☰ Installations</button></div>
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
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function jsString(s){
  return esc(String(s==null?'':s)
    .replace(/\\/g,'\\\\')
    .replace(/'/g,"\\'")
    .replace(/\r/g,'\\r')
    .replace(/\n/g,'\\n'));
}

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
    $('viewTabs').style.display='flex';
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
    {l:'Flag Events',v:fmt(d.flags?.totalFlags||0),c:'red'},
    {l:'Unique Flag Incidents',v:fmt(d.flags?.uniqueIncidents||0),c:'red'},
    {l:'Avg Req/Flag',v:fmt(d.flags?.avgRequestsBeforeFlag||0),c:'red'},
    {l:'Period',v:d.period?.from||'—',sub:d.period?.to?'→ '+d.period.to:''},
  ].map(k=>'<div class="kpi '+esc(k.c)+'"><div class="label">'+esc(k.l)+'</div><div class="value">'+esc(k.v)+'</div>'+(k.sub?'<div class="sub">'+esc(k.sub)+'</div>':'')+'</div>').join('');

  const sv=d.savings||{};
  $('savTotal').textContent=usd(sv.totalUsd);
  const svRows=Object.entries(sv.byModel||{}).map(([m,v])=>'<tr><td class="mono">'+esc(m)+'</td><td>'+usd(v.inputUsd)+'</td><td>'+usd(v.outputUsd)+'</td><td><strong>'+usd(v.totalUsd)+'</strong></td></tr>').join('');
  $('savTable').innerHTML=svRows?'<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>'+svRows+'</tbody></table>':'<div class="empty">No data yet</div>';

  const fl=d.flags||{};
  $('flagKpis').innerHTML=[
    {l:'Total Flags',v:fmt(fl.totalFlags||0)},
    {l:'On Pro Accounts',v:fmt(fl.onProAccounts||0)},
    {l:'On Free Accounts',v:fmt(fl.onFreeAccounts||0)},
    {l:'Avg Requests Before Flag',v:fmt(fl.avgRequestsBeforeFlag||0)},
  ].map(k=>'<div class="flag-kpi"><div class="label">'+esc(k.l)+'</div><div class="value">'+esc(k.v)+'</div></div>').join('');
  mkChart('cPatterns','bar',Object.keys(fl.byPattern||{}),[{label:'Count',data:Object.values(fl.byPattern||{}),backgroundColor:R}]);
  mkChart('cFlagModels','doughnut',Object.keys(fl.byModel||{}),[{data:Object.values(fl.byModel||{}),backgroundColor:C}]);
  mkChart('cTimerType','doughnut',Object.keys(fl.byTimerType||{}),[{data:Object.values(fl.byTimerType||{}),backgroundColor:['#63b3ed','#f6e05e','#68d391']}]);

  const tk=d.tokensByModel||{};
  $('tokTable').innerHTML=Object.keys(tk).length?'<table><thead><tr><th>Model</th><th>Input Tokens</th><th>Output Tokens</th><th>Requests</th></tr></thead><tbody>'+Object.entries(tk).map(([m,v])=>'<tr><td class="mono">'+esc(m)+'</td><td>'+fmt(v.input)+'</td><td>'+fmt(v.output)+'</td><td>'+fmt(v.requests)+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No token data yet</div>';

  mkChart('cVersions','bar',Object.keys(d.versions||{}),[{label:'Events',data:Object.values(d.versions||{}),backgroundColor:'#63b3ed'}]);
  mkChart('cOS','doughnut',Object.keys(d.os||{}),[{data:Object.values(d.os||{}),backgroundColor:C}]);
  mkChart('cModels','doughnut',Object.keys(d.modelsUsed||{}),[{data:Object.values(d.modelsUsed||{}),backgroundColor:C}]);
  mkChart('cHealth','doughnut',Object.keys(d.routingHealth||{}),[{data:Object.values(d.routingHealth||{}),backgroundColor:['#68d391','#f6e05e','#fc8181','#718096']}]);
  mkChart('cFeatures','bar',Object.keys(d.featuresUsed||{}),[{label:'Times used',data:Object.values(d.featuresUsed||{}),backgroundColor:'#b794f4'}]);
}

const saved=localStorage.getItem('st');
if(saved){_token=saved;$('tok').value=saved;go({});}

// ── Installs list view ───────────────────────────────────────────────
var CURRENT_VIEW = 'agg';
var INSTALL_SORT = 'requests';
var INSTALL_SORT_DIR = -1;
var _installs = [];

function switchView(view) {
  CURRENT_VIEW = view;
  $('vtAgg').className  = 'view-tab' + (view === 'agg'  ? ' active' : '');
  $('vtList').className = 'view-tab' + (view === 'list' ? ' active' : '');
  $('filterBar').style.display = view === 'agg'  ? 'flex' : 'none';
  var ae = $('app'); if(ae) ae.style.display = view === 'agg' ? 'block' : 'none';
  var le = $('installsView'); if(le) le.style.display = view === 'list' ? 'block' : 'none';
  if (view === 'list') loadInstalls();
}

async function loadInstalls() {
  console.log('[installs] token=', _token ? _token.slice(0,8)+'...' : 'EMPTY');
  if (!_token) { console.log('[installs] abort: no token'); return; }
  try {
    var r = await fetch('/v1/installs', { headers: { 'Authorization': 'Bearer ' + _token } });
    console.log('[installs] status=', r.status);
    if (!r.ok) { showErr('Failed to load installs: ' + r.status); return; }
    _installs = await r.json();
    console.log('[installs] rows=', _installs.length, _installs[0]);
    renderInstallList();
  } catch(e) { console.error('[installs] error:', e); showErr(e.message); }
}

function setInstallSort(col) {
  if (INSTALL_SORT === col) { INSTALL_SORT_DIR = -INSTALL_SORT_DIR; }
  else { INSTALL_SORT = col; INSTALL_SORT_DIR = -1; }
  ['requests','savings','accounts','flags','lastseen'].forEach(function(c) {
    var b = $('isort-' + c);
    if (b) b.className = 'sort-btn' + (c === INSTALL_SORT ? ' active' : '');
  });
  renderInstallList();
}

function renderInstallList() {
  var wrap = $('installTableWrap');
  if (!wrap) return;
  var q = (($('installSearch')||{}).value||'').toLowerCase();
  var rows = _installs.slice().filter(function(r) {
    if (!q) return true;
    return r.installId.toLowerCase().indexOf(q)!==-1 ||
           (r.version||'').toLowerCase().indexOf(q)!==-1 ||
           (r.os||'').toLowerCase().indexOf(q)!==-1;
  });
  rows.sort(function(a,b) {
    var av,bv;
    if      (INSTALL_SORT==='requests') {av=a.totalRequests;bv=b.totalRequests;}
    else if (INSTALL_SORT==='savings')  {av=a.savingsUsd;bv=b.savingsUsd;}
    else if (INSTALL_SORT==='accounts') {av=a.accountCount;bv=b.accountCount;}
    else if (INSTALL_SORT==='flags')    {av=a.flagEvents;bv=b.flagEvents;}
    else if (INSTALL_SORT==='lastseen') {av=a.lastSeen;bv=b.lastSeen;}
    else {av=0;bv=0;}
    if(av<bv) return INSTALL_SORT_DIR;
    if(av>bv) return -INSTALL_SORT_DIR;
    return 0;
  });
  if (rows.length===0) { wrap.innerHTML='<div class="empty">No installs found.</div>'; return; }
  var HC={healthy:'#68d391',cooldown_wait:'#f6e05e',busy:'#63b3ed',paused:'#fc8181',stopped:'#fc8181'};
  function ar(col) {
    if(INSTALL_SORT!==col) return '<span class="arr">&#8597;</span>';
    return '<span class="arr">'+(INSTALL_SORT_DIR===-1?'&#8595;':'&#8593;')+'</span>';
  }
  var html='<table class="install-table"><thead><tr>'+
    '<th>Install ID</th>'+
    '<th onclick="setInstallSort(&apos;requests&apos;)" class="'+(INSTALL_SORT==='requests'?'sort-active':'')+'">Requests'+ar('requests')+'</th>'+
    '<th onclick="setInstallSort(&apos;accounts&apos;)" class="'+(INSTALL_SORT==='accounts'?'sort-active':'')+'">Accounts'+ar('accounts')+'</th>'+
    '<th onclick="setInstallSort(&apos;savings&apos;)"  class="'+(INSTALL_SORT==='savings' ?'sort-active':'')+'">Savings' +ar('savings') +'</th>'+
    '<th onclick="setInstallSort(&apos;flags&apos;)"    class="'+(INSTALL_SORT==='flags'   ?'sort-active':'')+'">Flags'   +ar('flags')   +'</th>'+
    '<th>Health</th>'+
    '<th>Version / OS</th>'+
    '<th onclick="setInstallSort(&apos;lastseen&apos;)" class="'+(INSTALL_SORT==='lastseen'?'sort-active':'')+'">Last Seen'+ar('lastseen')+'</th>'+
    '<th></th>'+
    '</tr></thead><tbody>';
  rows.forEach(function(r) {
    var hc=HC[r.routingHealthState]||'#718096';
    var shortId=esc(r.installId.slice(0,8)+'…');
    var ls=r.lastSeen?new Date(r.lastSeen).toLocaleString():'—';
    var fc=r.flagEvents>0?'#fc8181':'#718096';
    var pf='';
    if(r.proCount>0||r.freeCount>0)
      pf='<span style="color:#68d391;font-size:10px">P:'+r.proCount+'</span> <span style="color:#718096;font-size:10px">F:'+r.freeCount+'</span>';
    html+='<tr class="install-row" onclick="drillDown(&apos;'+jsString(r.installId)+'&apos;)">'+
      '<td><div class="install-id"><strong>'+shortId+'</strong>'+esc(r.installId.slice(8))+'</div></td>'+
      '<td style="font-family:monospace;font-weight:700">'+fmt(r.totalRequests)+'</td>'+
      '<td>'+esc(r.accountCount)+(pf?'<br>'+pf:'')+'</td>'+
      '<td style="color:#68d391;font-family:monospace;font-weight:700">'+usd(r.savingsUsd)+'</td>'+
      '<td style="color:'+fc+';font-weight:700;font-family:monospace">'+esc(r.flagEvents)+'</td>'+
      '<td><span class="health-dot" style="background:'+hc+'"></span><span style="font-size:11px;color:'+hc+'">'+escI(r.routingHealthState||'?')+'</span></td>'+
      '<td style="font-size:11px"><span style="color:#63b3ed">v'+escI(r.version)+'</span> <span style="color:#718096">'+escI(r.os)+'/'+escI(r.arch)+'</span></td>'+
      '<td style="font-size:11px;color:#718096;font-family:monospace">'+esc(ls)+'</td>'+
      '<td><button class="sort-btn" style="padding:3px 8px;font-size:10px" onclick="event.stopPropagation();drillDown(&apos;'+jsString(r.installId)+'&apos;)">Filter &#8594;</button></td>'+
      '</tr>';
  });
  html+='</tbody></table>';
  wrap.innerHTML=html;
}

function drillDown(installId) {
  switchView('agg');
  var sel=$('fInstall');
  if(sel) { sel.value=installId; }
  applyFilters();
}

function escI(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

setInterval(()=>{if(_token){const f={};const i=$('fInstall').value;if(i)f.installId=i;const v=$('fVersion').value;if(v)f.version=v;const o=$('fOS').value;if(o)f.os=o;const m=$('fModel').value;if(m)f.model=m;const fr=$('fFrom').value;if(fr)f.from=fr;const to=$('fTo').value;if(to)f.to=to;go(f);}},60000);
</script>
<div class="main" id="installsView" style="display:none">
  <div class="install-list-panel">
    <h2>✶ Installations</h2>
    <div class="install-toolbar">
      <input class="install-search" id="installSearch" placeholder="Search…" oninput="renderInstallList()" />
      <button class="sort-btn" id="isort-requests" onclick="setInstallSort(&apos;requests&apos;)">Requests ↕</button>
      <button class="sort-btn" id="isort-savings" onclick="setInstallSort(&apos;savings&apos;)">Savings ↕</button>
      <button class="sort-btn" id="isort-accounts" onclick="setInstallSort(&apos;accounts&apos;)">Accounts ↕</button>
      <button class="sort-btn" id="isort-flags" onclick="setInstallSort(&apos;flags&apos;)">Flags ↕</button>
      <button class="sort-btn" id="isort-lastseen" onclick="setInstallSort(&apos;lastseen&apos;)">Last Seen ↕</button>
    </div>
    <div id="installTableWrap"></div>
  </div>
</div>
</body></html>`;
}

// ── Notifications Admin UI ───────────────────────────────────────────
function buildNotificationsAdminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Pi Rotator — Notification Manager</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
.header{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:14px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700;color:#fff}
.header .nav{margin-left:auto;display:flex;gap:10px;align-items:center}
.header .nav a{color:#718096;font-size:13px;text-decoration:none;padding:4px 10px;border-radius:6px;transition:color .2s,background .2s}
.header .nav a:hover{color:#e2e8f0;background:rgba(255,255,255,.06)}
.token-bar{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;gap:8px;align-items:center}
.token-bar input[type=password]{flex:1;background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:7px 12px;color:#e2e8f0;font-size:13px;font-family:monospace}
.token-bar input[type=password]:focus{outline:none;border-color:#4299e1}
.token-bar button{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap}
.token-bar button:hover{background:#3182ce}
.main{padding:20px 24px;max-width:1100px;margin:0 auto}
.section{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px;margin-bottom:14px}
.section h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group.full{grid-column:1/-1}
.form-group label{font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.form-group input,.form-group textarea,.form-group select{background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:8px 12px;color:#e2e8f0;font-size:13px;font-family:inherit}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{outline:none;border-color:#4299e1}
.form-group textarea{min-height:80px;resize:vertical}
.form-actions{display:flex;gap:8px;margin-top:14px;grid-column:1/-1}
.btn-primary{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:8px 20px;cursor:pointer;font-size:13px;font-weight:600}
.btn-primary:hover{background:#3182ce}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:#2d3748;color:#a0aec0;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px}
.btn-secondary:hover{background:#3d4a5e}
.btn-danger{background:rgba(248,113,113,.15);color:#fc8181;border:1px solid rgba(248,113,113,.3);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600}
.btn-danger:hover{background:rgba(248,113,113,.25)}
.btn-edit{background:rgba(66,153,225,.12);color:#63b3ed;border:1px solid rgba(66,153,225,.3);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600}
.btn-edit:hover{background:rgba(66,153,225,.22)}

table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 12px;color:#718096;border-bottom:1px solid #2d3748;font-weight:500;white-space:nowrap}
td{padding:7px 12px;border-bottom:1px solid #1f2535;color:#e2e8f0;vertical-align:top}
tr:last-child td{border-bottom:none}
.mono{font-family:monospace;color:#68d391;font-size:11px}
.type-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.type-info{background:rgba(66,153,225,.15);color:#63b3ed}
.type-warning{background:rgba(251,191,36,.15);color:#fbbf24}
.type-critical{background:rgba(248,113,113,.15);color:#fc8181}
.status-active{color:#68d391;font-weight:600;font-size:11px}
.status-expired{color:#718096;font-style:italic;font-size:11px}
.empty{color:#4a5568;font-size:12px;padding:20px;text-align:center}
.error{background:#2d1515;border:1px solid #742a2a;border-radius:8px;padding:12px;color:#fc8181;margin-bottom:14px}
.success{background:#1c2d1c;border:1px solid #276749;border-radius:8px;padding:12px;color:#68d391;margin-bottom:14px}

.preview{margin-top:14px;grid-column:1/-1}
.preview-label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;font-weight:700}
.preview-card{border-radius:10px;padding:14px 18px;display:flex;align-items:center;gap:12px}
.preview-card.p-info{background:linear-gradient(135deg,rgba(66,153,225,.12),rgba(99,179,237,.08));border:1px solid rgba(66,153,225,.35)}
.preview-card.p-warning{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(246,224,94,.08));border:1px solid rgba(251,191,36,.35)}
.preview-card.p-critical{background:linear-gradient(135deg,rgba(248,113,113,.12),rgba(252,129,129,.08));border:1px solid rgba(248,113,113,.35)}
.preview-icon{font-size:22px;flex-shrink:0}
.preview-content{flex:1;min-width:0}
.preview-title{font-weight:700;font-size:14px;margin-bottom:3px}
.preview-msg{font-size:12px;color:#a0aec0;line-height:1.4}
.preview-btn{display:inline-block;margin-top:6px;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none;border:1px solid rgba(255,255,255,.15);color:#e2e8f0;background:rgba(255,255,255,.06)}
.p-info .preview-title{color:#63b3ed}
.p-warning .preview-title{color:#fbbf24}
.p-critical .preview-title{color:#fc8181}
.version-hint{font-size:10px;color:#4a5568;margin-top:2px}
@media(max-width:700px){.form-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <h1>\u{1f514} Notification Manager</h1>
  <div class="nav">
    <a href="/">Telemetry Dashboard</a>
  </div>
</div>
<div class="token-bar">
  <input type="password" id="tok" placeholder="Paste STATS_TOKEN here\u2026" />
  <button onclick="authenticate()">Connect</button>
</div>

<div class="main">
  <div class="error" id="errMsg" style="display:none"></div>
  <div class="success" id="successMsg" style="display:none"></div>

  <div id="authedContent" style="display:none">
    <div class="section">
      <h2 id="formTitle">\u2795 Compose New Notification</h2>
      <div class="form-grid">
        <input type="hidden" id="editId" value="" />
        <div class="form-group">
          <label>Type</label>
          <select id="nType" onchange="updatePreview()">
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-group">
          <label>Expires At</label>
          <input type="datetime-local" id="nExpires" />
        </div>
        <div class="form-group full">
          <label>Title</label>
          <input type="text" id="nTitle" placeholder="Short headline for the notification" oninput="updatePreview()" />
        </div>
        <div class="form-group full">
          <label>Message</label>
          <textarea id="nMessage" placeholder="Full notification message. Explain what users need to do." oninput="updatePreview()"><\/textarea>
        </div>
        <div class="form-group">
          <label>Min Version <span class="version-hint">(show to users &ge; this version)</span></label>
          <input type="text" id="nMinVer" placeholder="e.g. 1.0.0" />
        </div>
        <div class="form-group">
          <label>Max Version <span class="version-hint">(show to users &le; this version)</span></label>
          <input type="text" id="nMaxVer" placeholder="e.g. 1.5.1" />
        </div>
        <div class="form-group">
          <label>Action URL (optional)</label>
          <input type="text" id="nActionUrl" placeholder="https://github.com/..." oninput="updatePreview()" />
        </div>
        <div class="form-group">
          <label>Action Label (optional)</label>
          <input type="text" id="nActionLabel" placeholder="e.g. View README" oninput="updatePreview()" />
        </div>
        <div class="preview" id="previewArea">
          <div class="preview-label">Live Preview</div>
          <div class="preview-card p-info" id="previewCard">
            <span class="preview-icon" id="previewIcon">\u{2139}\u{fe0f}</span>
            <div class="preview-content">
              <div class="preview-title" id="previewTitle">Notification title</div>
              <div class="preview-msg" id="previewMsg">Notification message will appear here</div>
            </div>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-primary" id="btnSubmit" onclick="submitNotification()">Create Notification</button>
          <button class="btn-secondary" id="btnCancel" onclick="cancelEdit()" style="display:none">Cancel Edit</button>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>\u{1f4cb} All Notifications</h2>
      <div id="notifTable"></div>
    </div>
  </div>
</div>

<script>

var _notifications = [];

function $(i) { return document.getElementById(i); }

function authenticate() {
  var t = $('tok').value.trim();
  if (!t) return;
  _token = t;
  localStorage.setItem('notif_token', t);
  loadAll();
}

async function loadAll() {
  try {
    // We need to verify the token by trying to load raw notifications
    // Use a GET with auth to confirm access
    var r = await fetch('/v1/stats', { headers: { 'Authorization': 'Bearer ' + _token } });
    if (r.status === 401) { showErr('Invalid token'); return; }
    hideErr();
    $('authedContent').style.display = 'block';
    await refreshList();
  } catch(e) { showErr(e.message); }
}

async function refreshList() {
  try {
    // Load all notifications from the file (we'll load the full list including expired)
    var r = await fetch('/v1/notifications?all=true', {
      headers: { 'Authorization': 'Bearer ' + _token }
    });
    if (!r.ok) { showErr('Failed to load notifications'); return; }
    _notifications = await r.json();
    renderTable();
  } catch(e) { showErr(e.message); }
}

function renderTable() {
  var tb = $('notifTable');
  if (!_notifications || _notifications.length === 0) {
    tb.innerHTML = '<div class="empty">No notifications yet. Create one above!</div>';
    return;
  }
  var now = new Date().toISOString();
  var html = '<table><thead><tr><th>Type</th><th>Title</th><th>Message</th><th>Version Target</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
  for (var i = 0; i < _notifications.length; i++) {
    var n = _notifications[i];
    var isExpired = n.expiresAt && n.expiresAt < now;
    var type = ['info','warning','critical'].includes(n.type) ? n.type : 'info';
    var typeClass = 'type-' + type;
    var verTarget = '';
    if (n.minVersion || n.maxVersion) {
      verTarget = (n.minVersion ? '\u2265' + n.minVersion : '') + (n.minVersion && n.maxVersion ? ' ' : '') + (n.maxVersion ? '\u2264' + n.maxVersion : '');
    } else {
      verTarget = 'All';
    }
    html += '<tr>'
      + '<td><span class="type-badge ' + typeClass + '">' + esc(n.type || 'info') + '</span></td>'
      + '<td><strong>' + esc(n.title) + '</strong></td>'
      + '<td style="max-width:280px;white-space:pre-wrap;word-break:break-word;font-size:11px;color:#a0aec0">' + esc(n.message).slice(0, 120) + (n.message.length > 120 ? '\u2026' : '') + '</td>'
      + '<td class="mono">' + esc(verTarget) + '</td>'
      + '<td><span class="' + (isExpired ? 'status-expired' : 'status-active') + '">' + (isExpired ? 'Expired' : 'Active') + '</span></td>'
      + '<td class="mono">' + esc(n.createdAt ? n.createdAt.slice(0, 16) : '\u2014') + '</td>'
      + '<td style="white-space:nowrap"><button class="btn-edit" onclick="editNotif(' + i + ')">Edit</button> <button class="btn-danger" onclick="deleteNotif(\\'' + jsString(n.id) + '\\')">Delete</button></td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  tb.innerHTML = html;
}

function editNotif(idx) {
  var n = _notifications[idx];
  if (!n) return;
  $('editId').value = n.id;
  $('nType').value = n.type || 'info';
  $('nTitle').value = n.title || '';
  $('nMessage').value = n.message || '';
  $('nMinVer').value = n.minVersion || '';
  $('nMaxVer').value = n.maxVersion || '';
  $('nActionUrl').value = n.actionUrl || '';
  $('nActionLabel').value = n.actionLabel || '';
  if (n.expiresAt) {
    $('nExpires').value = n.expiresAt.slice(0, 16);
  } else {
    $('nExpires').value = '';
  }
  $('formTitle').textContent = '\u270f\ufe0f Edit Notification';
  $('btnSubmit').textContent = 'Update Notification';
  $('btnCancel').style.display = '';
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  $('editId').value = '';
  $('nType').value = 'info';
  $('nTitle').value = '';
  $('nMessage').value = '';
  $('nMinVer').value = '';
  $('nMaxVer').value = '';
  $('nActionUrl').value = '';
  $('nActionLabel').value = '';
  $('nExpires').value = '';
  $('formTitle').textContent = '\u2795 Compose New Notification';
  $('btnSubmit').textContent = 'Create Notification';
  $('btnCancel').style.display = 'none';
  updatePreview();
}

async function submitNotification() {
  var title = $('nTitle').value.trim();
  var message = $('nMessage').value.trim();
  if (!title || !message) { showErr('Title and message are required'); return; }

  var payload = {
    type: $('nType').value,
    title: title,
    message: message,
    minVersion: $('nMinVer').value.trim() || null,
    maxVersion: $('nMaxVer').value.trim() || null,
    actionUrl: $('nActionUrl').value.trim() || null,
    actionLabel: $('nActionLabel').value.trim() || null,
    expiresAt: $('nExpires').value ? new Date($('nExpires').value).toISOString() : null,
  };

  var editId = $('editId').value;
  if (editId) payload.id = editId;

  $('btnSubmit').disabled = true;
  try {
    var r = await fetch('/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token },
      body: JSON.stringify(payload),
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      showSuccess(editId ? 'Notification updated!' : 'Notification created!');
      cancelEdit();
      await refreshList();
    } else {
      showErr(result.error || 'Failed to save notification');
    }
  } catch(e) {
    showErr(e.message);
  }
  $('btnSubmit').disabled = false;
}

async function deleteNotif(id) {
  if (!confirm('Delete this notification?')) return;
  try {
    var r = await fetch('/v1/notifications/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + _token },
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      showSuccess('Notification deleted');
      await refreshList();
    } else {
      showErr(result.error || 'Failed to delete');
    }
  } catch(e) { showErr(e.message); }
}

var ICONS = { info: '\u{2139}\u{fe0f}', warning: '\u26a0\ufe0f', critical: '\u{1f6a8}' };

function updatePreview() {
  var type = $('nType').value;
  var title = $('nTitle').value || 'Notification title';
  var msg = $('nMessage').value || 'Notification message will appear here';
  var actionUrl = $('nActionUrl').value;
  var actionLabel = $('nActionLabel').value || 'Learn More';
  var card = $('previewCard');
  card.className = 'preview-card p-' + type;
  $('previewIcon').textContent = ICONS[type] || ICONS.info;
  $('previewTitle').textContent = title;
  var html = esc(msg);
  if (actionUrl) html += '<br/><a class="preview-btn" href="#" onclick="return false">' + esc(actionLabel) + '</a>';
  $('previewMsg').innerHTML = html;
}

function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showErr(m) { $('errMsg').textContent = '\u26a0 ' + m; $('errMsg').style.display = ''; setTimeout(function(){ $('errMsg').style.display='none'; }, 8000); }
function hideErr() { $('errMsg').style.display = 'none'; }
function showSuccess(m) { $('successMsg').textContent = '\u2713 ' + m; $('successMsg').style.display = ''; setTimeout(function(){ $('successMsg').style.display='none'; }, 4000); }

// Auto-connect from saved token
var saved = localStorage.getItem('notif_token');
if (saved) { _token = saved; $('tok').value = saved; loadAll(); }
updatePreview();
<\/script>
</body></html>`;
}

// ── HTTP Server ──────────────────────────────────────────────────────
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let rejected = false;
		req.on("data", (chunk) => {
			if (rejected) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejected = true;
				req.destroy();
				reject(new Error("Payload too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
		});
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

	// Notifications Admin UI
	if (method === "GET" && url === "/notifications") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(buildNotificationsAdminHtml());
		return;
	}

	// ── Notifications API ──────────────────────────────────────────
	// GET /v1/notifications — Public, returns active notifications
	// Add ?all=true to load all (including expired) for admin UI
	if (method === "GET" && url.startsWith("/v1/notifications")) {
		try {
			const q = parseQueryString(url);
			if (q.all === "true") {
				// Return ALL notifications (for admin management UI)
				if (!requireStatsAuth(req, res)) return;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(loadNotifications()));
			} else {
				const clientVersion = q.version || null;
				const active = getActiveNotifications(clientVersion);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(active));
			}
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to load notifications" }));
		}
		return;
	}

	// POST /v1/notifications — Create/update notification (auth required)
	if (method === "POST" && url === "/v1/notifications") {
		if (!requireStatsAuth(req, res)) return;
		try {
			const body = await readBody(req);
			const data = JSON.parse(body);
			if (!isValidNotificationInput(data)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid notification fields" }));
				return;
			}
			const notifications = loadNotifications();
			const notification = {
				id: data.id || randomUUID(),
				type: data.type || "info",
				title: data.title,
				message: data.message,
				createdAt: data.createdAt || new Date().toISOString(),
				expiresAt: data.expiresAt || null,
				minVersion: data.minVersion || null,
				maxVersion: data.maxVersion || null,
				actionUrl: data.actionUrl || null,
				actionLabel: data.actionLabel || null,
			};
			// Update if id exists, otherwise add
			const existingIdx = notifications.findIndex((n) => n.id === notification.id);
			if (existingIdx >= 0) {
				notifications[existingIdx] = notification;
			} else {
				notifications.push(notification);
			}
			saveNotifications(notifications);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, notification }));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Bad request" }));
		}
		return;
	}

	// DELETE /v1/notifications/:id — Remove notification (auth required)
	if (method === "DELETE" && url.startsWith("/v1/notifications/")) {
		if (!requireStatsAuth(req, res)) return;
		try {
			const id = decodeURIComponent(url.slice("/v1/notifications/".length));
			const notifications = loadNotifications();
			const filtered = notifications.filter((n) => n.id !== id);
			if (filtered.length === notifications.length) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Notification not found" }));
				return;
			}
			saveNotifications(filtered);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, deleted: id }));
		} catch {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to delete notification" }));
		}
		return;
	}

	// Health check
	if (method === "GET" && url === "/v1/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
		return;
	}

	// Installs list (protected)
	if (method === "GET" && url.startsWith("/v1/installs")) {
		if (!requireStatsAuth(req, res)) return;
		try {
			const q = parseQueryString(url);
			const filters = {};
			if (q.from)    filters.from    = q.from;
			if (q.to)      filters.to      = q.to;
			if (q.version) filters.version = q.version;
			if (q.os)      filters.os      = q.os;
			const list = computeInstallList(filters);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(list));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to compute install list" }));
		}
		return;
	}

	// Stats (protected)
	if (method === "GET" && url.startsWith("/v1/stats")) {
		if (!requireStatsAuth(req, res)) return;
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
