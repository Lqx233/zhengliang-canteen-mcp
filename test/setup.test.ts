import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildStdioMcpConfig,
  buildTraeMcpConfig,
  exportWorkBuddyBundle,
  installCodexSkill,
  installQoderSkills,
  installTraeSkill,
  packagedSkillPathFromCompiledDirectory,
  qoderCliCommand,
  setup,
  skillTargetPathsFromHome,
} from "../src/cli/setup.js";

test("packaged skill paths resolve for POSIX and Windows layouts", () => {
  assert.equal(packagedSkillPathFromCompiledDirectory("/pkg/build/src/cli", path.posix), "/pkg/skills/zhengliang-canteen");
  assert.equal(packagedSkillPathFromCompiledDirectory("C:\\pkg\\build\\src\\cli", path.win32), "C:\\pkg\\skills\\zhengliang-canteen");
});

test("client skill targets use documented user-level directories", () => {
  const targets = skillTargetPathsFromHome("/synthetic/home", path.posix);
  assert.equal(targets.trae, "/synthetic/home/.trae/skills/zhengliang-canteen");
  assert.equal(targets.qoder, "/synthetic/home/.qoder/skills/zhengliang-canteen");
  assert.equal(targets.qoderwork, "/synthetic/home/.qoderwork/skills/zhengliang-canteen");
});

test("stdio MCP configuration is deterministic and contains no credentials", () => {
  const config = buildStdioMcpConfig({ nodePath: "/synthetic/node", cliFile: "/synthetic/cli.js", browserPath: "/synthetic/browser-cache" });
  assert.deepEqual(config, {
    mcpServers: {
      "zhengliang-canteen-packaged": {
        command: "/synthetic/node",
        args: ["/synthetic/cli.js", "serve"],
        env: { PLAYWRIGHT_BROWSERS_PATH: "/synthetic/browser-cache" },
      },
    },
  });
  assert.equal(JSON.stringify(config).includes("token"), false);
});

test("Trae uses node fallback when the Node executable path contains spaces", () => {
  const config = buildTraeMcpConfig({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliFile: "C:\\Users\\Synthetic User\\zhengliang-canteen-mcp\\cli.js",
    browserPath: "C:\\Synthetic Cache",
  });
  const entry = config.mcpServers["zhengliang-canteen-packaged"]!;
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, ["C:\\Users\\Synthetic User\\zhengliang-canteen-mcp\\cli.js", "serve"]);
  assert.equal(entry.env.PLAYWRIGHT_BROWSERS_PATH, "C:\\Synthetic Cache");
});

test("Qoder CLI command preserves Windows paths containing spaces", () => {
  assert.equal(
    qoderCliCommand({ nodePath: "C:\\Program Files\\nodejs\\node.exe", cliFile: "C:\\Synthetic User\\cli.js" }, "win32"),
    "qoder mcp add zhengliang-canteen-packaged -- 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Synthetic User\\cli.js' serve",
  );
});

test("setup rejects unknown clients before performing setup work", async () => {
  await assert.rejects(setup({ clients: ["synthetic-unknown-client"], dryRun: true }), /Unsupported setup client/);
  await assert.rejects(setup({ clients: ["none", "trae"], dryRun: true }), /cannot be combined/);
});

test("Codex skill installation backs up an existing copy", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-setup-"));
  try {
    await installCodexSkill(false, { homeDir: temporary, now: new Date("2099-01-02T03:04:05.000Z") });
    const target = path.join(temporary, ".codex", "skills", "zhengliang-canteen");
    await fs.writeFile(path.join(target, "synthetic-marker.txt"), "synthetic old skill");
    await installCodexSkill(false, { homeDir: temporary, now: new Date("2099-01-02T03:04:06.000Z") });
    const entries = await fs.readdir(path.dirname(target));
    const backup = entries.find((entry) => entry.startsWith("zhengliang-canteen.backup-"));
    assert.equal(Boolean(backup), true);
    await assert.rejects(fs.access(path.join(target, "synthetic-marker.txt")));
    assert.equal(await fs.readFile(path.join(path.dirname(target), backup!, "synthetic-marker.txt"), "utf8"), "synthetic old skill");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Codex skill installation restores the previous copy after activation failure", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-setup-"));
  try {
    await installCodexSkill(false, { homeDir: temporary });
    const target = path.join(temporary, ".codex", "skills", "zhengliang-canteen");
    await fs.writeFile(path.join(target, "synthetic-marker.txt"), "synthetic retained skill");
    const rename = async (source: string, destination: string) => {
      if (path.basename(source).startsWith(".zhengliang-canteen.install-")) throw new Error("synthetic activation failure");
      await fs.rename(source, destination);
    };
    await assert.rejects(installCodexSkill(false, { homeDir: temporary, rename }));
    assert.equal(await fs.readFile(path.join(target, "synthetic-marker.txt"), "utf8"), "synthetic retained skill");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Trae and Qoder skills install into isolated user-level directories", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-adapters-"));
  try {
    await installTraeSkill(false, { homeDir: temporary });
    await installQoderSkills(false, { homeDir: temporary });
    const targets = skillTargetPathsFromHome(temporary);
    for (const target of [targets.trae, targets.qoder, targets.qoderwork]) {
      assert.equal(await fs.readFile(path.join(target, "SKILL.md"), "utf8").then((value) => value.includes("Zhengliang Digital Canteen")), true);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Qoder skill installation rolls back the first target when the second target fails", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-qoder-rollback-"));
  try {
    const targets = skillTargetPathsFromHome(temporary);
    await fs.mkdir(targets.qoder, { recursive: true });
    await fs.writeFile(path.join(targets.qoder, "synthetic-marker.txt"), "synthetic previous Qoder skill");
    const rename = async (source: string, destination: string) => {
      if (destination === targets.qoderwork) throw new Error("synthetic QoderWork activation failure");
      await fs.rename(source, destination);
    };
    await assert.rejects(installQoderSkills(false, { homeDir: temporary, now: new Date("2099-01-02T03:04:05.000Z"), rename }), /synthetic QoderWork activation failure/);
    assert.equal(await fs.readFile(path.join(targets.qoder, "synthetic-marker.txt"), "utf8"), "synthetic previous Qoder skill");
    await assert.rejects(fs.access(targets.qoderwork));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Qoder skill installation reports both installation and rollback failures", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-qoder-aggregate-"));
  try {
    const targets = skillTargetPathsFromHome(temporary);
    const now = new Date("2099-01-02T03:04:05.000Z");
    const backup = `${targets.qoder}.backup-2099-01-02T03-04-05-000Z`;
    await fs.mkdir(targets.qoder, { recursive: true });
    await fs.writeFile(path.join(targets.qoder, "synthetic-marker.txt"), "synthetic recoverable Qoder skill");
    const rename = async (source: string, destination: string) => {
      if (destination === targets.qoderwork) throw new Error("synthetic QoderWork activation failure");
      if (source === backup && destination === targets.qoder) throw new Error("synthetic Qoder rollback failure");
      await fs.rename(source, destination);
    };
    await assert.rejects(
      installQoderSkills(false, { homeDir: temporary, now, rename }),
      (error: unknown) => error instanceof AggregateError
        && error.errors.length === 2
        && /rollback was unsuccessful/.test(error.message),
    );
    assert.equal(await fs.readFile(path.join(backup, "synthetic-marker.txt"), "utf8"), "synthetic recoverable Qoder skill");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("setup dry-run routes Trae, Qoder, and WorkBuddy instructions", async () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await setup({ clients: ["trae"], dryRun: true });
    assert.match(output, /TraeWork \/ Trae IDE/);
    assert.match(output, /"mcpServers"/);
    output = "";
    await setup({ clients: ["qoder"], dryRun: true });
    assert.match(output, /Qoder CLI does not accept the JSON block/);
    assert.match(output, /qoder mcp add zhengliang-canteen-packaged --/);
    assert.match(output, /QoderWork: open Extensions/);
    output = "";
    await setup({ clients: ["workbuddy"], dryRun: true });
    assert.match(output, /reference materials/);
    assert.doesNotMatch(output, /import bundle/);
    output = "";
    await setup({ clients: ["all"], dryRun: true });
    for (const expected of ["codex mcp add", "claude mcp add", "TraeWork / Trae IDE", "QoderWork", "Qoder CLI", "WorkBuddy reference materials"]) {
      assert.match(output, new RegExp(expected));
    }
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("WorkBuddy export contains only synthetic, reviewable reference materials", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-workbuddy-"));
  try {
    const bundle = await exportWorkBuddyBundle(false, {
      tmpDir: temporary,
      config: { nodePath: "/synthetic/node", cliFile: "/synthetic/cli.js", browserPath: "/synthetic/cache" },
    });
    assert.ok(bundle);
    const entries = (await fs.readdir(bundle)).sort();
    assert.deepEqual(entries, ["README.md", "SKILL.md", "mcp.json", "references", "skill.yml"]);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(bundle)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(bundle, "mcp.json"))).mode & 0o777, 0o600);
    }
    const manifest = await fs.readFile(path.join(bundle, "skill.yml"), "utf8");
    assert.match(manifest, /^name: zhengliang-canteen/m);
    assert.equal(manifest.includes("token"), false);
    const mcp = JSON.parse(await fs.readFile(path.join(bundle, "mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers["zhengliang-canteen-packaged"].command, "/synthetic/node");
    const readme = await fs.readFile(path.join(bundle, "README.md"), "utf8");
    assert.match(readme, /reference bundle/);
    assert.match(readme, /example only/);
    assert.match(readme, /nothing is automatically registered/);
    assert.doesNotMatch(readme, /import bundle/);
    await fs.rm(bundle, { recursive: true, force: true });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
