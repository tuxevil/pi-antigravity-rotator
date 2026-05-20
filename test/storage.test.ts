import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile, readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } from "../src/storage.js";

describe("storage helpers", () => {
	it("writes text atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rotator-storage-"));
		const file = join(dir, "state.json");
		writeTextFileAtomic(file, "hello");
		assert.equal(existsSync(file), true);
	});

	it("writes and reads json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rotator-storage-"));
		const file = join(dir, "config.json");
		writeJsonFileAtomic(file, { ok: true, n: 2 });
		assert.deepEqual(readJsonFile(file), { ok: true, n: 2 });
	});

	it("creates backups for existing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rotator-storage-"));
		const file = join(dir, "accounts.json");
		writeFileSync(file, '{"a":1}\n', "utf-8");
		const backup = backupFile(file, "accounts");
		assert.ok(backup);
		assert.equal(existsSync(backup as string), true);
	});
});
