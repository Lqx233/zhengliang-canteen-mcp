import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemorySecretStore } from "../src/auth/tokenStore.js";
import { ProfileVault } from "../src/config/vault.js";
import { encryptedProfilePath } from "../src/paths.js";
import type { TenantProfile } from "../src/types.js";

const syntheticProfile: TenantProfile = {
  version: 1,
  buyer: "Operator A",
  buyerPhone: "phone-A",
  purpose: 1,
  warehouses: [{ warehouseId: "warehouse-A", warehouseName: "Warehouse A", receiver: "Receiver A", receiverPhone: "phone-B", nutrition: 0, remark: "Warehouse A" }],
  ledgers: { morningChecker: "Checker A", deviceChecker: "Checker B", deviceExecuter: "Operator B", wasteChecker: "Checker C", wasteDisposer: "Operator C", wasteHandler: "Operator D", dinersCount: 100 },
  wasteQuickFill: { enabled: false, foodWaste: 0, prepWaste: 0, otherWaste: 0 },
  aliases: [],
};

test("profile vault encrypts content and detects tampering", async () => {
  const previous = process.env.ZHENGLIANG_MCP_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-vault-"));
  process.env.ZHENGLIANG_MCP_HOME = home;
  try {
    const vault = new ProfileVault(new MemorySecretStore());
    await vault.save(syntheticProfile);
    const raw = await fs.readFile(encryptedProfilePath(), "utf8");
    assert.equal(raw.includes("Operator A"), false);
    assert.deepEqual(await vault.load(), syntheticProfile);
    const envelope = JSON.parse(raw);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await fs.writeFile(encryptedProfilePath(), JSON.stringify(envelope));
    await assert.rejects(() => vault.load());
  } finally {
    if (previous === undefined) delete process.env.ZHENGLIANG_MCP_HOME; else process.env.ZHENGLIANG_MCP_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
