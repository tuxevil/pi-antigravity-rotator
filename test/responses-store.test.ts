import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResponsesStore, type StoredResponseEntry } from "../src/responses-store.js";

function makeEntry(id: string, expiresAt: number): [string, StoredResponseEntry] {
	return [id, {
		response: { id, status: "completed" },
		inputItems: [],
		conversationMessages: [],
		callIdToName: { [`call_${id}`]: "toolA" },
		expiresAt,
	}];
}

describe("ResponsesStore", () => {
	let tmpDir: string;
	let store: ResponsesStore;
	let path: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rotator-responses-"));
		path = join(tmpDir, "responses.json");
		store = new ResponsesStore(path);
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null for an unknown id", () => {
		assert.equal(store.get("missing"), null);
	});

	it("set + get round-trips", () => {
		const [id, entry] = makeEntry("round-trip", Date.now() + 60_000);
		store.set(id, entry);
		const got = store.get(id);
		assert.ok(got);
		assert.equal(got?.response.id, "round-trip");
	});

	it("delete removes the entry", () => {
		const [id, entry] = makeEntry("to-delete", Date.now() + 60_000);
		store.set(id, entry);
		assert.equal(store.delete(id), true);
		assert.equal(store.get(id), null);
		assert.equal(store.delete(id), false);
	});

	it("clear removes all entries", () => {
		store.set("a", makeEntry("a", Date.now() + 60_000)[1]);
		store.set("b", makeEntry("b", Date.now() + 60_000)[1]);
		store.clear();
		assert.equal(store.get("a"), null);
		assert.equal(store.get("b"), null);
	});

	it("get returns null for expired entries and removes them", async () => {
		const id = "expired";
		const past = Date.now() - 1;
		store.set(id, makeEntry(id, past)[1]);
		assert.equal(store.get(id), null);
	});

	it("flush persists to disk atomically via .tmp", async () => {
		store.clear();
		store.set("disk-1", makeEntry("disk-1", Date.now() + 60_000)[1]);
		store.set("disk-2", makeEntry("disk-2", Date.now() + 60_000)[1]);
		await store.flush();
		assert.ok(existsSync(path));
		// .tmp should be cleaned up after rename
		assert.equal(existsSync(`${path}.tmp`), false);
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.version, 1);
		assert.equal(parsed.entries.length, 2);
		assert.ok(parsed.entries.find((e: [string, unknown]) => e[0] === "disk-1"));
		assert.ok(parsed.entries.find((e: [string, unknown]) => e[0] === "disk-2"));
	});

	it("load restores entries from disk", async () => {
		const fresh = new ResponsesStore(path);
		await fresh.load();
		assert.ok(fresh.get("disk-1"));
		assert.ok(fresh.get("disk-2"));
	});

	it("load prunes expired entries from disk", async () => {
		// Write a custom file with a mix of fresh and expired entries.
		const expiredId = "expired-on-disk";
		const freshId = "fresh-on-disk";
		const payload = {
			version: 1,
			entries: [
				makeEntry(expiredId, Date.now() - 1),
				makeEntry(freshId, Date.now() + 60_000),
			],
		};
		// Use sync write to avoid debounce delay
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, JSON.stringify(payload), "utf-8");
		const fresh = new ResponsesStore(path);
		await fresh.load();
		assert.equal(fresh.get(expiredId), null);
		assert.ok(fresh.get(freshId));
	});

	it("load handles missing file gracefully", async () => {
		const missing = join(tmpDir, "does-not-exist.json");
		const fresh = new ResponsesStore(missing);
		await fresh.load();
		assert.equal(fresh.get("anything"), null);
	});

	it("load renames corrupt file aside and starts empty", async () => {
		const corrupt = join(tmpDir, "corrupt.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(corrupt, "not json{{{", "utf-8");
		const fresh = new ResponsesStore(corrupt);
		await fresh.load();
		assert.equal(fresh.get("anything"), null);
		// Original file should have been moved aside.
		assert.equal(existsSync(corrupt), false);
		// A .corrupt-*.bak should exist.
		const backupName = readFileSync.sync; // touch: don't actually call
		const files = (await import("node:fs")).readdirSync(tmpDir);
		assert.ok(files.some((f) => f.startsWith("corrupt.json.corrupt-")), `expected corrupt backup, got: ${files.join(", ")}`);
	});
});

describe("ResponsesStore.flushSync", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rotator-responses-sync-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes to disk synchronously when dirty", () => {
		const path = join(tmpDir, "sync.json");
		const store = new ResponsesStore(path);
		store.set("sync-1", makeEntry("sync-1", Date.now() + 60_000)[1]);
		store.flushSync();
		assert.ok(existsSync(path));
		assert.equal(existsSync(`${path}.tmp`), false);
	});

	it("no-op when not dirty", () => {
		const path = join(tmpDir, "no-dirty.json");
		const store = new ResponsesStore(path);
		store.flushSync();
		// Should not create the file at all
		assert.equal(existsSync(path), false);
	});
});
