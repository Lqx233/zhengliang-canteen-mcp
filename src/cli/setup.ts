import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MCP_REGISTRATION_NAME } from "../constants.js";
import { browserCacheDir } from "../paths.js";

export interface SetupOptions {
  clients: string[];
  dryRun: boolean;
}

function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function installBrowser(dryRun: boolean): Promise<void> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("playwright/package.json");
  const playwrightCli = path.join(path.dirname(packageJson), "cli.js");
  const command = [process.execPath, playwrightCli, "install", "chromium"];
  if (dryRun) {
    process.stdout.write(`[dry-run] PLAYWRIGHT_BROWSERS_PATH=${browserCacheDir()} ${command.join(" ")}\n`);
    return;
  }
  const code = await run(command[0]!, command.slice(1), { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCacheDir() });
  if (code !== 0) throw new Error("Chromium installation failed");
}

async function commandExists(command: string): Promise<boolean> {
  const detector = process.platform === "win32" ? "where" : "which";
  try { return await run(detector, [command]) === 0; } catch { return false; }
}

async function configureCodex(dryRun: boolean): Promise<void> {
  const args = ["mcp", "add", MCP_REGISTRATION_NAME, "--env", `PLAYWRIGHT_BROWSERS_PATH=${browserCacheDir()}`, "--", process.execPath, cliPath(), "serve"];
  if (dryRun) return void process.stdout.write(`[dry-run] codex ${args.join(" ")}\n`);
  if (!await commandExists("codex")) return void process.stdout.write("Codex CLI not found; skipped Codex registration.\n");
  await run("codex", ["mcp", "remove", MCP_REGISTRATION_NAME]);
  if (await run("codex", args) !== 0) throw new Error("Codex MCP registration failed");
}

async function configureClaudeCode(dryRun: boolean): Promise<void> {
  const args = ["mcp", "add", "--scope", "user", MCP_REGISTRATION_NAME, "-e", `PLAYWRIGHT_BROWSERS_PATH=${browserCacheDir()}`, "--", process.execPath, cliPath(), "serve"];
  if (dryRun) return void process.stdout.write(`[dry-run] claude ${args.join(" ")}\n`);
  if (!await commandExists("claude")) return void process.stdout.write("Claude Code CLI not found; skipped Claude Code registration.\n");
  await run("claude", ["mcp", "remove", "--scope", "user", MCP_REGISTRATION_NAME]);
  if (await run("claude", args) !== 0) throw new Error("Claude Code MCP registration failed");
}

function claudeDesktopPath(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
}

async function configureClaudeDesktop(dryRun: boolean): Promise<void> {
  const target = claudeDesktopPath();
  const entry = { command: process.execPath, args: [cliPath(), "serve"], env: { PLAYWRIGHT_BROWSERS_PATH: browserCacheDir() } };
  if (dryRun) return void process.stdout.write(`[dry-run] merge ${MCP_REGISTRATION_NAME} into ${target}: ${JSON.stringify(entry)}\n`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let config: any = {};
  try {
    const raw = await fs.readFile(target, "utf8");
    config = JSON.parse(raw);
    await fs.copyFile(target, `${target}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), [MCP_REGISTRATION_NAME]: entry };
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function setup(options: SetupOptions): Promise<void> {
  await installBrowser(options.dryRun);
  const clients = new Set(options.clients);
  if (clients.has("all") || clients.has("codex")) await configureCodex(options.dryRun);
  if (clients.has("all") || clients.has("claude") || clients.has("claude-code")) await configureClaudeCode(options.dryRun);
  if (clients.has("all") || clients.has("claude") || clients.has("claude-desktop")) await configureClaudeDesktop(options.dryRun);
  process.stdout.write(options.dryRun ? "Dry run complete.\n" : "Setup complete. Restart MCP clients to connect.\n");
}
