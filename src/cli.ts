// CLI entry point for pi-antigravity-rotator
// Usage:
//   pi-antigravity-rotator start     Start the proxy
//   pi-antigravity-rotator login     Add a new account
//   pi-antigravity-rotator status    Show account status
//   pi-antigravity-rotator keys      Manage virtual API keys

import { getConfigDir } from "./paths.js";

const args = process.argv
  .slice(2)
  .filter(
    (a) =>
      !a.startsWith("--config-dir") &&
      a !== process.argv[process.argv.indexOf("--config-dir") + 1],
  );
const command = args[0] || "start";

console.log(`Config dir: ${getConfigDir()}`);
console.log();


switch (command) {
  case "start": {
    // Dynamic import to avoid loading everything for help
    const { main } = await import("./index.js");
    await main();
    break;
  }
  case "login": {
    const { initDb } = await import("./db-store.js");
    await initDb();
    const { runLogin } = await import("./login.js");
    await runLogin();
    break;
  }
  case "status": {
    const { initDb, closeDb } = await import("./db-store.js");
    const {
      getConfiguredAdminToken,
      readPersistedAdminToken,
      setPersistedAdminToken,
    } = await import("./admin-auth.js");
    try {
      await initDb();
      setPersistedAdminToken(readPersistedAdminToken());
      const token = getConfiguredAdminToken();
      const port = 51200;
      const res = await fetch(`http://localhost:${port}/api/status`, {
        headers: token ? { "X-Rotator-Admin-Token": token } : {},
      });
      if (res.status === 401) {
        console.error(
          "Rotator status is protected and the local admin token was rejected.",
        );
        process.exitCode = 1;
        break;
      }
      if (!res.ok) {
        console.error(`Rotator status returned HTTP ${res.status}`);
        process.exitCode = 1;
        break;
      }
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error("Rotator is not running or unreachable on port 51200");
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
    break;
  }
  case "doctor": {
    const { initDb } = await import("./db-store.js");
    await initDb();
    const { printDoctorReport, runDoctor } = await import("./doctor.js");
    const result = await runDoctor();
    printDoctorReport(result);
    process.exit(result.ok ? 0 : 1);
    break;
  }
  case "keys": {
    const initDb = (await import("./db-store.js")).initDb;
    const { isDbConfigured } = await import("./db-store.js");
    if (!isDbConfigured()) {
      console.error("Virtual keys require PostgreSQL. Set PI_ROTATOR_DATABASE_URL.");
      process.exit(1);
    }
    await initDb();
    const { runKeyMigrations } = await import("./key-migrations.js");
    await runKeyMigrations();

    const {
      listVirtualKeys,
      generateVirtualKey,
      deleteVirtualKey,
    } = await import("./virtual-keys.js");

    const subAction = args[1] || "list";

    if (subAction === "list") {
      const keys = await listVirtualKeys();
      if (keys.length === 0) {
        console.log("No virtual keys found. Use 'pi-antigravity-rotator keys generate' to create one.");
      } else {
        console.log(`${keys.length} virtual key(s):`);
        console.log("─".repeat(70));
        for (const k of keys) {
          console.log(`  Alias:     ${k.keyAlias}`);
          console.log(`  Key:       ${k.keyName}`);
          console.log(`  Hash:      ${k.tokenHash}`);
          console.log(`  User:      ${k.userId || "(any)"}`);
          console.log(`  Models:    ${k.models && k.models.length > 0 ? k.models.join(", ") : "(all)"}`);
          console.log(`  Status:    ${k.blocked ? "BLOCKED" : "active"}`);
          console.log(`  Created:   ${k.createdAt}`);
          console.log(`  Last used: ${k.lastActive || "never"}`);
          console.log("─".repeat(70));
        }
      }
      process.exit(0);
    }

    if (subAction === "generate") {
      const aliasIdx = args.indexOf("--alias");
      const alias = aliasIdx >= 0 ? args[aliasIdx + 1] : null;
      if (!alias) {
        console.error("Missing --alias <name> (e.g. --alias cursor-agent)");
        process.exit(1);
      }

      const userIdIdx = args.indexOf("--user-id");
      const userId = userIdIdx >= 0 ? args[userIdIdx + 1] : undefined;

      const modelsIdx = args.indexOf("--models");
      const modelsRaw = modelsIdx >= 0 ? args[modelsIdx + 1] : undefined;
      const models = modelsRaw ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

      const { rawKey, key } = await generateVirtualKey({
        alias,
        userId,
        models,
        createdBy: "cli",
      });

      console.log("Virtual key generated successfully!");
      console.log(`  Alias:   ${key.keyAlias}`);
      console.log(`  Raw key: ${rawKey}`);
      console.log();
      console.log("⚠ Save this key now — it cannot be retrieved later.");
      console.log("  Use Authorization: Bearer " + rawKey);
      console.log("  Or x-rotator-key: " + rawKey);
      process.exit(0);
    }

    if (subAction === "delete") {
      const hash = args[2];
      if (!hash) {
        console.error("Usage: pi-antigravity-rotator keys delete <hash>");
        process.exit(1);
      }
      const deleted = await deleteVirtualKey(hash);
      if (deleted) {
        console.log("Virtual key deleted.");
      } else {
        console.error("Virtual key not found.");
        process.exit(1);
      }
      process.exit(0);
    }

    console.error(`Unknown subcommand: ${subAction}`);
    console.log("Usage: pi-antigravity-rotator keys [list|generate|delete]");
    process.exit(1);
  }
  break;
  default:
    console.log("Pi Antigravity Rotator");
    console.log();
    console.log("Usage:");
    console.log("  pi-antigravity-rotator start     Start the proxy (default)");
    console.log("  pi-antigravity-rotator login     Add a new Google account");
    console.log(
      "  pi-antigravity-rotator status    Show account status (JSON)",
    );
    console.log(
      "  pi-antigravity-rotator doctor    Validate config and local state",
    );
    console.log("  pi-antigravity-rotator keys     Manage virtual API keys");
    console.log(
      "                                 list   - List all virtual keys",
    );
    console.log(
      "                                 generate --alias <name> [--user-id <id>] [--models m1,m2]",
    );
    console.log(
      "                                 delete <hash> - Delete a virtual key",
    );
    console.log();
    console.log("Options:");
    console.log(
      "  --config-dir <path>    Config directory (default: ~/.pi-antigravity-rotator/)",
    );
    console.log();
    console.log("Environment:");
    console.log("  PI_ROTATOR_DIR         Config directory override");
    process.exit(command === "help" || command === "--help" ? 0 : 1);
}
