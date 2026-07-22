import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const RECEIVER_PATH = join(process.cwd(), "tools/telemetry-receiver/receiver.js");

async function waitForHealth(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return;
		} catch {
			// retry
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("receiver did not become healthy in time");
}

describe("telemetry receiver", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	const port = 40000 + Math.floor(Math.random() * 20000);

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-"));
		proc = spawn(process.execPath, [RECEIVER_PATH], {
			env: {
				...process.env,
				PORT: String(port),
				DATA_DIR: dir,
				STATS_TOKEN: "secret-token",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		await waitForHealth(port);
	});

	after(async () => {
		proc?.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("accepts flag payloads and writes dedicated -flags.jsonl", async () => {
		const payload = {
			event: "flag",
			installId: "test-install",
			version: "1.10.0",
			ts: new Date().toISOString(),
			flag: {
				flagHttpStatus: 403,
				flagPatternsMatched: ["violat", "blocked_401"],
				model: "quota-poll",
				timerType: "7d",
				accountQuotaPercent: 0,
				wasProAccount: true,
				accountTotalRequests: 123,
				accountRequestsLastHour: 9,
				accountConcurrentAtFlag: 1,
				poolSize: 18,
				poolHealthyCount: 3,
				protectivePauseTriggered: false,
				uptimeSeconds: 42,
				timeSinceLastFlagSeconds: -1,
			},
		};

		const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(res.status, 202);

		const day = new Date().toISOString().slice(0, 10);
		const flagsFile = join(dir, `${day}-flags.jsonl`);
		const raw = await readFile(flagsFile, "utf8");
		const line = JSON.parse(raw.trim().split("\n")[0]);
		assert.equal(line.installId, "test-install");
		assert.equal(line.flagHttpStatus, 403);
		assert.deepEqual(line.flagPatternsMatched, ["violat", "blocked_401"]);
	});

	it("does not expose historical notifications without the admin token", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/v1/notifications?all=true`);
		assert.equal(res.status, 401);
	});

	it("calculates estimated savings for gemini 3.6 flash models in /v1/stats", async () => {
		const payload = {
			event: "heartbeat",
			installId: "savings-test-install",
			version: "2.3.6",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gemini-3.6-flash-high", "gemini-3.6-flash"],
			totalRequests: 15,
			uptimeSeconds: 100,
			routingHealthState: "healthy",
			tokensByModel: {
				"gemini-3.6-flash-high": { input: 1_000_000, output: 1_000_000, requests: 10 },
				"gemini-3.6-flash": { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(stats.savings);
		assert.ok(stats.savings.byModel["gemini-3.6-flash-high"]);
		assert.ok(stats.savings.byModel["gemini-3.6-flash"]);
		assert.equal(stats.savings.byModel["gemini-3.6-flash-high"].totalUsd, 9.00);
		assert.equal(stats.savings.byModel["gemini-3.6-flash"].totalUsd, 9.00);
	});
});
