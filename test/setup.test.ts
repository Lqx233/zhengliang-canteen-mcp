import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCodexSkill, packagedSkillPathFromCompiledDirectory } from "../src/cli/setup.js";

test("packaged skill paths resolve for POSIX and Windows layouts", () => {
  assert.equal(packagedSkillPathFromCompiledDirectory("/pkg/build/src/cli", path.posix), "/pkg/skills/zhengliang-canteen");
  assert.equal(packagedSkillPathFromCompiledDirectory("C:\\pkg\\build\\src\\cli", path.win32), "C:\\pkg\\skills\\zhengliang-canteen");
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
