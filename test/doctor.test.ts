import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("doctor command", () => {
  it("reports warnings but exits cleanly for valid config without admin token", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-doctor-"));
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({
        proxyPort: 51200,
        accounts: [
          { email: "user@example.com", refreshToken: "rt", projectId: "pid" },
        ],
        requestsPerRotation: 5,
        rotateOnQuotaDrop: 20,
        quotaPollIntervalMs: 300000,
      }),
      "utf-8",
    );
    const run = spawnSync(
      "node",
      ["--import", "tsx/esm", "src/cli.ts", "doctor", "--config-dir", dir],
      {
        cwd: repoDir,
        encoding: "utf-8",
      },
    );
    assert.equal(run.status, 0);
    assert.match(run.stdout, /PI_ROTATOR_ADMIN_TOKEN is not configured/);
  });

  it("warns when config is corrupted (treated as missing by repository)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-doctor-"));
    writeFileSync(join(dir, "accounts.json"), "{not-json", "utf-8");
    const run = spawnSync(
      "node",
      ["--import", "tsx/esm", "src/cli.ts", "doctor", "--config-dir", dir],
      {
        cwd: repoDir,
        encoding: "utf-8",
      },
    );
    // Corrupted config is treated as missing by the repository — doctor
    // reports a warning ("no config found") but no hard error.
    assert.equal(run.status, 0);
    assert.match(run.stdout, /No accounts config found/);
  });
});
