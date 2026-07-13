#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRuntime } from "./runtime.js";
import { serve } from "./server.js";
import { setup } from "./cli/setup.js";
import { doctor } from "./cli/doctor.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") return serve();
  if (command === "setup") {
    const parsed = parseArgs({ args: process.argv.slice(3), options: { clients: { type: "string", default: "all" }, "dry-run": { type: "boolean", default: false } } });
    return setup({ clients: String(parsed.values.clients).split(",").map((value) => value.trim()), dryRun: parsed.values["dry-run"] === true });
  }
  if (command === "doctor") return doctor();

  const runtime = createRuntime();
  if (command === "auth") {
    const action = process.argv[3] ?? "status";
    if (action === "status") return void process.stdout.write(`${JSON.stringify(await runtime.session.status(), null, 2)}\n`);
    if (action === "login") {
      await runtime.session.ensureToken(process.argv.includes("--force"));
      process.stdout.write("Authenticated.\n");
      return;
    }
    if (action === "logout") {
      if (!process.argv.includes("--confirm")) throw new Error("auth logout requires --confirm");
      await runtime.session.logout();
      process.stdout.write("Logged out.\n");
      return;
    }
  }
  if (command === "profile" && process.argv[3] === "configure") {
    await runtime.session.ensureToken();
    await runtime.wizard.open();
    process.stdout.write("Profile configured.\n");
    return;
  }
  process.stderr.write("Usage: zhengliang-canteen-mcp <serve|setup|doctor|auth login|auth status|auth logout --confirm|profile configure>\n");
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
