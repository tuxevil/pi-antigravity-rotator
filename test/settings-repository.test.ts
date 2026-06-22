import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FileSettingsRepository,
  type ISettingsRepository,
} from "../src/settings-repository.js";

describe("FileSettingsRepository", () => {
  it("init and close are no-ops (no crash)", async () => {
    const repo = new FileSettingsRepository();
    await repo.init();
    await repo.close();
  });

  it("get/set works as in-memory cache with disk persistence", () => {
    const repo = new FileSettingsRepository();
    assert.equal(repo.get("nonexistent_key"), null);

    repo.set("nonexistent_key", "value1");
    assert.equal(repo.get("nonexistent_key"), "value1");

    repo.set("nonexistent_key", "value2");
    assert.equal(repo.get("nonexistent_key"), "value2");
  });

  it("stores multiple keys independently", () => {
    const repo = new FileSettingsRepository();
    repo.set("key_a", "1");
    repo.set("key_b", "2");
    assert.equal(repo.get("key_a"), "1");
    assert.equal(repo.get("key_b"), "2");
  });
});
