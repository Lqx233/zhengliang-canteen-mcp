import { spawn } from "node:child_process";
import crypto from "node:crypto";
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

export const SUPPORTED_SETUP_CLIENTS = [
  "all",
  "none",
  "codex",
  "claude",
  "claude-code",
  "claude-desktop",
  "trae",
  "qoder",
  "workbuddy",
] as const;

type Rename = (source: string, destination: string) => Promise<void>;

export interface SkillInstallOptions {
  homeDir?: string;
  now?: Date;
  rename?: Rename;
}

export interface McpConfigOptions {
  browserPath?: string;
  cliFile?: string;
  nodePath?: string;
}

function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export function packagedSkillPathFromCompiledDirectory(directory: string, pathApi: typeof path = path): string {
  return pathApi.join(directory, "..", "..", "..", "skills", "zhengliang-canteen");
}

function packagedSkillPath(): string {
  return packagedSkillPathFromCompiledDirectory(path.dirname(fileURLToPath(import.meta.url)));
}

export function skillTargetPathsFromHome(homeDir: string, pathApi: typeof path = path): {
  codex: string;
  qoder: string;
  qoderwork: string;
  trae: string;
} {
  return {
    codex: pathApi.join(homeDir, ".codex", "skills", "zhengliang-canteen"),
    qoder: pathApi.join(homeDir, ".qoder", "skills", "zhengliang-canteen"),
    qoderwork: pathApi.join(homeDir, ".qoderwork", "skills", "zhengliang-canteen"),
    trae: pathApi.join(homeDir, ".trae", "skills", "zhengliang-canteen"),
  };
}

export function buildStdioMcpConfig(options: McpConfigOptions = {}): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
} {
  return {
    mcpServers: {
      [MCP_REGISTRATION_NAME]: {
        command: options.nodePath ?? process.execPath,
        args: [options.cliFile ?? cliPath(), "serve"],
        env: { PLAYWRIGHT_BROWSERS_PATH: options.browserPath ?? browserCacheDir() },
      },
    },
  };
}

export function buildTraeMcpConfig(options: McpConfigOptions = {}): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
} {
  const node = options.nodePath ?? process.execPath;
  const command = node.includes(" ") ? "node" : node;
  return buildStdioMcpConfig({ ...options, nodePath: command });
}

function stdioEntry(options: McpConfigOptions = {}): { command: string; args: string[]; env: Record<string, string> } {
  return buildStdioMcpConfig(options).mcpServers[MCP_REGISTRATION_NAME]!;
}

function prettyMcpConfig(
  options: McpConfigOptions = {},
  builder: (options: McpConfigOptions) => ReturnType<typeof buildStdioMcpConfig> = buildStdioMcpConfig,
): string {
  return JSON.stringify(builder(options), null, 2);
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

async function installPackagedSkill(
  dryRun: boolean,
  target: string,
  clientLabel: string,
  options: SkillInstallOptions = {},
  reportBackup = true,
): Promise<{ target: string; backup: string | null } | null> {
  const source = packagedSkillPath();
  if (dryRun) {
    process.stdout.write(`[dry-run] copy ${source} to ${target} (backup existing target)\n`);
    return null;
  }
  const parent = path.dirname(target);
  const staging = path.join(parent, `.zhengliang-canteen.install-${process.pid}-${crypto.randomUUID()}`);
  const rename = options.rename ?? ((sourcePath: string, destination: string) => fs.rename(sourcePath, destination));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  let backup: string | null = null;
  try {
    await fs.cp(source, staging, { recursive: true, errorOnExist: true });
    try {
      await fs.access(target);
      backup = `${target}.backup-${(options.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
      await rename(target, backup);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (backup) {
        try {
          await rename(backup, target);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Skill activation failed and the previous copy remains at ${backup}`);
        }
      }
      throw error;
    }
    if (backup && reportBackup) process.stdout.write(`Existing ${clientLabel} skill backed up to ${backup}.\n`);
    return { target, backup };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function rollbackSkillInstall(
  receipt: { target: string; backup: string | null },
  rename: Rename,
): Promise<void> {
  await fs.rm(receipt.target, { recursive: true, force: true });
  if (receipt.backup) await rename(receipt.backup, receipt.target);
}

export async function installCodexSkill(dryRun: boolean, options: SkillInstallOptions = {}): Promise<void> {
  const targets = skillTargetPathsFromHome(options.homeDir ?? os.homedir());
  await installPackagedSkill(dryRun, targets.codex, "Codex", options);
}

export async function installTraeSkill(dryRun: boolean, options: SkillInstallOptions = {}): Promise<void> {
  const targets = skillTargetPathsFromHome(options.homeDir ?? os.homedir());
  await installPackagedSkill(dryRun, targets.trae, "Trae", options);
}

export async function installQoderSkills(dryRun: boolean, options: SkillInstallOptions = {}): Promise<void> {
  const targets = skillTargetPathsFromHome(options.homeDir ?? os.homedir());
  const rename = options.rename ?? ((source: string, destination: string) => fs.rename(source, destination));
  const qoder = await installPackagedSkill(dryRun, targets.qoder, "Qoder IDE/CLI", options, false);
  let qoderwork: Awaited<ReturnType<typeof installPackagedSkill>>;
  try {
    qoderwork = await installPackagedSkill(dryRun, targets.qoderwork, "QoderWork", options, false);
  } catch (error) {
    if (!qoder) throw error;
    try {
      await rollbackSkillInstall(qoder, rename);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Qoder skill installation failed and rollback was unsuccessful${qoder.backup ? `; the previous copy remains at ${qoder.backup}` : ""}`,
      );
    }
    throw error;
  }
  if (qoder?.backup) process.stdout.write(`Existing Qoder IDE/CLI skill backed up to ${qoder.backup}.\n`);
  if (qoderwork?.backup) process.stdout.write(`Existing QoderWork skill backed up to ${qoderwork.backup}.\n`);
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
  const entry = stdioEntry();
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

function shellArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function qoderCliCommand(options: McpConfigOptions = {}, platform: NodeJS.Platform = process.platform): string {
  const entry = stdioEntry(options);
  return ["qoder", "mcp", "add", MCP_REGISTRATION_NAME, "--", entry.command, ...entry.args]
    .map((argument) => shellArgument(argument, platform))
    .join(" ");
}

function printManualMcpInstructions(client: "QoderWork / Qoder IDE" | "Qoder CLI" | "TraeWork / Trae IDE"): void {
  if (client === "QoderWork / Qoder IDE") {
    process.stdout.write("QoderWork: open Extensions -> Connectors -> + Add -> Paste JSON Config; Qoder IDE: open MCP settings and paste this JSON (JSON is not Qoder CLI input):\n");
    process.stdout.write(`${prettyMcpConfig()}\n`);
    return;
  }
  if (client === "Qoder CLI") {
    process.stdout.write("Qoder CLI does not accept the JSON block. Run this command from a shell:\n");
    process.stdout.write(`${qoderCliCommand()}\n`);
    process.stdout.write(`Set PLAYWRIGHT_BROWSERS_PATH=${browserCacheDir()} in the shell environment before launching Qoder CLI.\n`);
    return;
  }
  process.stdout.write("TraeWork / Trae IDE: open Settings -> MCP, add a custom server, then paste:\n");
  if ((process.execPath).includes(" ")) {
    process.stdout.write("Trae requires a command without spaces, so this JSON uses `node`; ensure Node.js is available on PATH.\n");
  }
  process.stdout.write(`${prettyMcpConfig({}, buildTraeMcpConfig)}\n`);
}

async function configureTrae(dryRun: boolean): Promise<void> {
  await installTraeSkill(dryRun);
  printManualMcpInstructions("TraeWork / Trae IDE");
}

async function configureQoder(dryRun: boolean): Promise<void> {
  await installQoderSkills(dryRun);
  printManualMcpInstructions("QoderWork / Qoder IDE");
  printManualMcpInstructions("Qoder CLI");
}

function workBuddyReadme(): string {
  return `# Zhengliang Digital Canteen for WorkBuddy

This reference bundle contains a minimal WorkBuddy skill manifest, the reusable MCP safety skill, and an example local stdio MCP configuration. These files are reference materials only; nothing is automatically registered in WorkBuddy.

1. Review \`skill.yml\`, \`SKILL.md\`, and the files under \`references/\`.
2. Install the skill with WorkBuddy's official Skill interface. If the installed WorkBuddy version requests extra manifest fields, enter them in the official interface instead of adding guessed fields here.
3. \`mcp.json\` is an example only. If the WorkBuddy Connectors interface offers a custom MCP import, review it and follow the official import flow manually. This setup command does not modify undocumented WorkBuddy settings or register anything automatically.
4. Restart WorkBuddy after installation.

Passwords must be entered only on the official Digital Canteen login page. Never paste a password or session token into WorkBuddy, this bundle, or the MCP configuration.
`;
}

export async function exportWorkBuddyBundle(
  dryRun: boolean,
  options: { tmpDir?: string; config?: McpConfigOptions } = {},
): Promise<string | null> {
  const temporaryRoot = options.tmpDir ?? os.tmpdir();
  if (dryRun) {
    process.stdout.write(`[dry-run] create WorkBuddy reference materials under ${temporaryRoot}\n`);
    process.stdout.write(`${prettyMcpConfig(options.config)}\n`);
    return null;
  }
  const bundle = await fs.mkdtemp(path.join(temporaryRoot, "zhengliang-canteen-workbuddy-"));
  await fs.chmod(bundle, 0o700);
  try {
    const source = packagedSkillPath();
    const [skill, workflows] = await Promise.all([
      fs.readFile(path.join(source, "SKILL.md"), "utf8"),
      fs.readFile(path.join(source, "references", "workflows.md"), "utf8"),
    ]);
    const references = path.join(bundle, "references");
    await fs.mkdir(references, { mode: 0o700 });
    await Promise.all([
      fs.writeFile(path.join(bundle, "skill.yml"), "name: zhengliang-canteen\ndescription: Safe read-first Digital Canteen operations through an MCP connector.\n", { mode: 0o600 }),
      fs.writeFile(path.join(bundle, "SKILL.md"), skill, { mode: 0o600 }),
      fs.writeFile(path.join(bundle, "README.md"), workBuddyReadme(), { mode: 0o600 }),
      fs.writeFile(path.join(bundle, "mcp.json"), `${prettyMcpConfig(options.config)}\n`, { mode: 0o600 }),
      fs.writeFile(path.join(references, "workflows.md"), workflows, { mode: 0o600 }),
    ]);
  } catch (error) {
    await fs.rm(bundle, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`WorkBuddy reference materials created at ${bundle}. Nothing was registered automatically.\n`);
  return bundle;
}

async function configureWorkBuddy(dryRun: boolean): Promise<void> {
  await exportWorkBuddyBundle(dryRun);
}

function validateClients(requestedClients: string[]): Set<string> {
  const clients = new Set(requestedClients);
  const supported = new Set<string>(SUPPORTED_SETUP_CLIENTS);
  const unknown = [...clients].filter((client) => !supported.has(client));
  if (unknown.length > 0) {
    throw new Error(`Unsupported setup client(s): ${unknown.join(", ")}. Supported values: ${SUPPORTED_SETUP_CLIENTS.join(", ")}`);
  }
  if (clients.has("none") && clients.size > 1) throw new Error('Setup client "none" cannot be combined with other clients');
  return clients;
}

export async function setup(options: SetupOptions): Promise<void> {
  const clients = validateClients(options.clients);
  await installBrowser(options.dryRun);
  if (clients.has("all") || clients.has("codex")) {
    await configureCodex(options.dryRun);
    await installCodexSkill(options.dryRun);
  }
  if (clients.has("all") || clients.has("claude") || clients.has("claude-code")) await configureClaudeCode(options.dryRun);
  if (clients.has("all") || clients.has("claude") || clients.has("claude-desktop")) await configureClaudeDesktop(options.dryRun);
  if (clients.has("all") || clients.has("trae")) await configureTrae(options.dryRun);
  if (clients.has("all") || clients.has("qoder")) await configureQoder(options.dryRun);
  if (clients.has("all") || clients.has("workbuddy")) await configureWorkBuddy(options.dryRun);
  process.stdout.write(options.dryRun
    ? "Dry run complete.\n"
    : "Setup complete. Restart configured MCP clients and follow any printed manual import steps.\n");
}
