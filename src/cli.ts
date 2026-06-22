#!/usr/bin/env node

// CLI entry point for pi-antigravity-rotator
// Usage:
//   pi-antigravity-rotator start     Start the proxy
//   pi-antigravity-rotator login     Add a new account
//   pi-antigravity-rotator status    Show account status

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
    try {
      const port = 51200;
      const res = await fetch(`http://localhost:${port}/api/status`);
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error("Rotator is not running or unreachable on port 51200");
      process.exit(1);
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
