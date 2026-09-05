import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractToken } from "../src/auth/browserAuth.js";
import { KeyringSecretStore, MemorySecretStore, TokenStorageError } from "../src/auth/tokenStore.js";
import { encryptedTokenPath } from "../src/paths.js";
import { Session, WriteReplayRequiredError } from "../src/session.js";
import type { ApiClient } from "../src/api.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

function syntheticToken(length: number): string {
  return "synthetic-session-token-".padEnd(length, "x");
}

function fakeKeyring() {
  const values = new Map<string, string>();
  const faults = new Map<string, Error>();
  const writes: string[] = [];
  const entry = (account: string) => ({
    getPassword: () => {
      if (faults.has(`get:${account}`)) throw faults.get(`get:${account}`);
      return values.get(account) ?? null;
    },
    setPassword: (value: string) => {
      if (faults.has(`set:${account}`)) throw faults.get(`set:${account}`);
      writes.push(account);
      values.set(account, value);
    },
    deletePassword: () => {
      if (faults.has(`delete:${account}`)) throw faults.get(`delete:${account}`);
      return values.delete(account);
    },
  });
  return { values, faults, writes, entry };
}

function successfulApi(): ApiClient {
  return {
    request: async () => ({ httpStatus: 200, json: { status: 0 } }),
    requestWithRetry: async () => ({ httpStatus: 200, json: { status: 0 } }),
  } as ApiClient;
}

async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.ZHENGLIANG_MCP_HOME;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "zl-mcp-auth-"));
  process.env.ZHENGLIANG_MCP_HOME = temporary;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.ZHENGLIANG_MCP_HOME; else process.env.ZHENGLIANG_MCP_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("extractToken accepts only a JSON object with a nontrivial token", () => {
  assert.equal(extractToken(null), null);
  assert.equal(extractToken("not-json"), null);
  assert.equal(extractToken(JSON.stringify({ token: "short" })), null);
  assert.equal(extractToken(JSON.stringify({ token: "synthetic-session-token-value" })), "synthetic-session-token-value");
});

test("long tokens use encrypted fallback storage when the keyring rejects capacity", async () => {
  await withTempHome(async () => {
    const values = new Map<string, string>();
    let rejectToken = true;
    const fakeEntry = (account: string) => ({
      getPassword: () => values.get(account) ?? null,
      setPassword: (value: string) => {
        if (account.endsWith(":token") && rejectToken) throw new Error("Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars");
        values.set(account, value);
      },
      deletePassword: () => { values.delete(account); return true; },
    });
    const store = new KeyringSecretStore(fakeEntry);
    const token = "synthetic-long-token-" + "x".repeat(1400);
    await store.setToken(token);
    const raw = await fs.readFile(encryptedTokenPath(), "utf8");
    assert.equal(raw.includes(token), false);
    assert.equal(await store.getToken(), token);
    assert.equal(values.has("default:token"), false);
    rejectToken = false;
    await store.setToken("short-synthetic-session-token");
    assert.equal(await store.getToken(), "short-synthetic-session-token");
    await store.deleteToken();
    await assert.rejects(() => fs.access(encryptedTokenPath()), { code: "ENOENT" });
  });
});

test("file fallback survives a fresh store and rejects tampering without exposing token", async () => {
  await withTempHome(async () => {
    const values = new Map<string, string>();
    const fakeEntry = (account: string) => ({
      getPassword: () => values.get(account) ?? null,
      setPassword: (value: string) => values.set(account, value),
      deletePassword: () => { values.delete(account); return true; },
    });
    const first = new KeyringSecretStore(fakeEntry, "win32");
    const token = "synthetic-windows-token-" + "y".repeat(1300);
    await first.setToken(token);
    const second = new KeyringSecretStore(fakeEntry, "win32");
    assert.equal(await second.getToken(), token);
    const envelope = JSON.parse(await fs.readFile(encryptedTokenPath(), "utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await fs.writeFile(encryptedTokenPath(), JSON.stringify(envelope));
    await assert.rejects(() => second.getToken(), (error: unknown) => error instanceof TokenStorageError && !String(error).includes(token));
  });
});

test("stored token is validated and reused without opening a browser", async () => {
  await withTempHome(async () => {
  const secrets = new MemorySecretStore();
  await secrets.setToken("stored-synthetic-session-token");
  let browserCalls = 0;
  const api = { request: async () => ({ httpStatus: 200, json: { status: 0 } }), requestWithRetry: async () => ({ httpStatus: 200, json: { status: 0 } }) } as any;
  const session = new Session(secrets, { login: async () => { browserCalls += 1; return "new-synthetic-session-token"; } }, api);
  assert.equal(await session.ensureToken(), "stored-synthetic-session-token");
  assert.equal(browserCalls, 0);
  });
});

test("rejected stored token opens the browser once and replaces it", async () => {
  await withTempHome(async () => {
    const secrets = new MemorySecretStore();
    await secrets.setToken("expired-synthetic-session-token");
    let calls = 0;
    const api = {
      request: async () => ({ httpStatus: 200, json: calls++ === 0 ? { status: 2011 } : { status: 0 } }),
      requestWithRetry: async () => ({ httpStatus: 200, json: { status: 0 } }),
    } as any;
    const session = new Session(secrets, { login: async () => "renewed-synthetic-session-token" }, api);
    assert.equal(await session.ensureToken(), "renewed-synthetic-session-token");
    assert.equal(await secrets.getToken(), "renewed-synthetic-session-token");
  });
});

test("write requests are not replayed after authentication recovery", async () => {
  await withTempHome(async () => {
    const secrets = new MemorySecretStore();
    await secrets.setToken("stored-synthetic-session-token");
    let validationCalls = 0;
    const api = {
      request: async () => ({ httpStatus: 200, json: { status: validationCalls++ === 0 ? 0 : 0 } }),
      requestWithRetry: async () => ({ httpStatus: 200, json: { status: 2011 } }),
    } as any;
    const session = new Session(secrets, { login: async () => "renewed-synthetic-session-token" }, api);
    await session.ensureToken();
    await assert.rejects(() => session.call("/synthetic/write", { method: "POST", operation: "write", body: {} }), WriteReplayRequiredError);
  });
});

test("Windows boundary is measured in UTF-16 bytes; macOS keeps direct storage", async () => {
  await withTempHome(async () => {
    for (const length of [500, 1000, 1279, 1280, 1281, 1356, 1500]) {
      const fake = fakeKeyring();
      const store = new KeyringSecretStore(fake.entry, "win32");
      await store.setToken(syntheticToken(length));
      assert.equal(fake.values.has("default:token"), length <= 1280);
      assert.equal(await store.getToken(), syntheticToken(length));
      await store.deleteToken();
    }
    // 655 code points but 2586 UTF-16 bytes: counting code points would fail.
    const nonAscii = "synthetic-token" + "😀".repeat(640);
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(nonAscii);
    assert.equal(fake.values.has("default:token"), false);
    assert.equal(await store.getToken(), nonAscii);
    await store.deleteToken();
    const macStore = new KeyringSecretStore(fake.entry, "darwin");
    await macStore.setToken(syntheticToken(1500));
    assert.equal(fake.values.get("default:token"), syntheticToken(1500));
    assert.equal(fake.values.has("default:config-key"), true); // Existing key is preserved.
    await assert.rejects(fs.access(encryptedTokenPath()), { code: "ENOENT" });
  });
});

test("fallback encrypts with fresh IVs, binds profiles and preserves configuration keys on logout", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    const token = syntheticToken(1356);
    await store.setToken(token);
    const key = fake.values.get("default:config-key")!;
    const first = JSON.parse(await fs.readFile(encryptedTokenPath(), "utf8"));
    await store.setToken(token);
    const raw = await fs.readFile(encryptedTokenPath(), "utf8");
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes(key), false);
    assert.notEqual(JSON.parse(raw).iv, first.iv);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(encryptedTokenPath())).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(encryptedTokenPath()))).mode & 0o777, 0o700);
    }
    fake.values.set("synthetic-other:config-key", key);
    await fs.copyFile(encryptedTokenPath(), encryptedTokenPath("synthetic-other"));
    await assert.rejects(store.getToken("synthetic-other"), TokenStorageError);
    await store.deleteToken("synthetic-other");
    await store.deleteToken();
    await store.deleteToken();
    assert.equal(fake.values.get("default:config-key"), key);
    assert.equal(await store.getToken(), null);
  });
});

test("credential and disk failures are sanitized; only capacity errors trigger fallback", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "darwin");
    const secret = syntheticToken(40);
    fake.faults.set("set:default:token", new Error(`Synthetic access denied: ${secret}`));
    await assert.rejects(store.setToken(secret), (error: unknown) => {
      assert.ok(error instanceof TokenStorageError);
      assert.equal(String(error).includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(fake.writes, []);
    await assert.rejects(fs.access(encryptedTokenPath()), { code: "ENOENT" });
    fake.faults.clear();
    fake.faults.set("get:default:token", new Error(`Synthetic read failed: ${secret}`));
    await assert.rejects(store.getToken(), TokenStorageError);
    fake.faults.clear();
    fake.faults.set("set:default:config-key", new Error(`Synthetic key failure: ${secret}`));
    await assert.rejects(new KeyringSecretStore(fake.entry, "win32").setToken(syntheticToken(1356)), TokenStorageError);
    await assert.rejects(fs.access(encryptedTokenPath()), { code: "ENOENT" });
  });
});

test("corrupt, missing-key and unsupported files never fall through to an old credential", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(1356));
    const original = await fs.readFile(encryptedTokenPath(), "utf8");
    const key = fake.values.get("default:config-key")!;
    fake.values.set("default:token", "synthetic-stale-session-token");
    fake.values.delete("default:config-key");
    await assert.rejects(store.getToken(), TokenStorageError);
    fake.values.set("default:config-key", Buffer.alloc(32, 1).toString("base64"));
    await assert.rejects(store.getToken(), TokenStorageError);
    fake.values.set("default:config-key", key);
    for (const raw of ["synthetic-not-json", "null", JSON.stringify({ ...JSON.parse(original), version: 99 }), JSON.stringify({ ...JSON.parse(original), tag: "invalid" })]) {
      await fs.writeFile(encryptedTokenPath(), raw);
      await assert.rejects(store.getToken(), TokenStorageError);
    }
    await store.deleteToken();
    assert.equal(await store.getToken(), null);
  });
});

test("both short/long transitions resolve to the new token, including cleanup failure", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(40));
    fake.faults.set("delete:default:token", new Error("Synthetic deletion denied"));
    await assert.rejects(store.setToken(syntheticToken(1356)), TokenStorageError);
    assert.equal(fake.values.get("default:token"), syntheticToken(40));
    // New encrypted data takes precedence over the stale direct credential.
    assert.equal(await new KeyringSecretStore(fake.entry, "win32").getToken(), syntheticToken(1356));
    fake.faults.clear();
    await store.setToken(syntheticToken(1500));
    assert.equal(fake.values.has("default:token"), false);
    await store.setToken(syntheticToken(50));
    await assert.rejects(fs.access(encryptedTokenPath()), { code: "ENOENT" });
    assert.equal(await store.getToken(), syntheticToken(50));
  });
});

test("failed atomic replace preserves the old file and removes temporary ciphertext", async (t) => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(1356));
    const rename = t.mock.method(fs, "rename", async () => { throw new Error("Synthetic rename failure"); });
    try {
      await assert.rejects(store.setToken(syntheticToken(1500)), TokenStorageError);
      assert.equal(await store.getToken(), syntheticToken(1356));
      assert.deepEqual(await fs.readdir(path.dirname(encryptedTokenPath())), [path.basename(encryptedTokenPath())]);
    } finally { rename.mock.restore(); }
  });
});

test("logout attempts both stores and reports partial failures", async (t) => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(1356));
    fake.values.set("default:token", syntheticToken(40));
    fake.faults.set("delete:default:token", new Error("Synthetic keyring deletion failure"));
    await assert.rejects(store.deleteToken(), TokenStorageError);
    await assert.rejects(fs.access(encryptedTokenPath()), { code: "ENOENT" });
    assert.equal(fake.values.has("default:token"), true);
    fake.faults.clear();
    await store.setToken(syntheticToken(1356));
    fake.values.set("default:token", syntheticToken(40));
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = t.mock.method(fs, "unlink", async (target: string) => {
      if (target === encryptedTokenPath()) throw new Error("Synthetic file deletion failure");
      return originalUnlink(target);
    });
    try {
      await assert.rejects(store.deleteToken(), TokenStorageError);
      assert.equal(fake.values.has("default:token"), false);
    } finally { unlink.mock.restore(); }
    await store.deleteToken();
    assert.equal(await store.getToken(), null);
  });
});

test("long token login is shared concurrently and reused after a fresh runtime", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    let browserCalls = 0;
    const browser = { login: async () => { browserCalls++; return syntheticToken(1356); } };
    const session = new Session(store, browser, successfulApi());
    await Promise.all([session.ensureToken(), session.ensureToken(), session.call("/synthetic/read")]);
    assert.equal(browserCalls, 1);
    assert.deepEqual(await session.status(), { authenticated: true, profile: "default" });
    const restarted = new Session(new KeyringSecretStore(fake.entry, "win32"), browser, successfulApi());
    assert.equal(await restarted.ensureToken(), syntheticToken(1356));
    await restarted.call("/synthetic/read");
    assert.equal(browserCalls, 1);
  });
});

test("persistent storage failure blocks automatic relogin until explicit forced login", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    fake.faults.set("set:default:token", new Error("Synthetic credential store unavailable"));
    let browserCalls = 0;
    const session = new Session(new KeyringSecretStore(fake.entry, "win32"), {
      login: async () => { browserCalls++; return syntheticToken(40); },
    }, successfulApi());
    const results = await Promise.allSettled([session.ensureToken(), session.ensureToken()]);
    assert.equal(results.every((result) => result.status === "rejected"), true);
    await assert.rejects(session.ensureToken(), TokenStorageError);
    await assert.rejects(session.call("/synthetic/read"), TokenStorageError);
    await assert.rejects(session.status(), TokenStorageError);
    assert.equal(browserCalls, 1);
    fake.faults.clear();
    await assert.rejects(session.ensureToken(), TokenStorageError);
    await session.ensureToken(true);
    assert.equal(browserCalls, 2);
    assert.deepEqual(await session.status(), { authenticated: true, profile: "default" });
  });
});

test("read validation network failures preserve stored tokens without relogin", async () => {
  await withTempHome(async () => {
  const secrets = new MemorySecretStore();
  await secrets.setToken(syntheticToken(40));
  let browserCalls = 0;
  const api = successfulApi();
  api.request = async () => { throw new Error("Synthetic network timeout"); };
  const session = new Session(secrets, { login: async () => { browserCalls++; return syntheticToken(50); } }, api);
  await assert.rejects(session.ensureToken(), /Synthetic network timeout/);
  assert.equal(await secrets.getToken(), syntheticToken(40));
  assert.equal(browserCalls, 0);
  });
});

test("storage errors remain secret-free in MCP responses and server logs", async (t) => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const token = syntheticToken(40);
    fake.faults.set("set:default:token", new Error(`Synthetic native exception containing ${token}`));
    let browserCalls = 0;
    const session = new Session(new KeyringSecretStore(fake.entry, "win32"), {
      login: async () => { browserCalls++; return token; },
    }, successfulApi());
    const server = createServer({ session, vault: { load: async () => true } } as any);
    const client = new Client({ name: "synthetic-storage-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];
    const stderr = t.mock.method(process.stderr, "write", (value: string | Uint8Array) => { logs.push(String(value)); return true; });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const name of ["login", "login", "auth_status"]) {
        const result = await client.callTool({ name, arguments: {} });
        assert.equal(result.isError, true);
        assert.equal(JSON.stringify(result).includes(token), false);
        assert.equal(JSON.stringify(result).includes("force:true"), true);
      }
      assert.equal(browserCalls, 1);
      assert.equal(logs.join("").includes(token), false);
      fake.faults.clear();
      const recovered = await client.callTool({ name: "login", arguments: { force: true } });
      assert.notEqual(recovered.isError, true);
      assert.equal(browserCalls, 2);
    } finally {
      stderr.mock.restore();
      await client.close();
      await server.close();
    }
  });
});

test("failed logout blocks reuse of a residual token and can be retried", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(40));
    const session = new Session(store, { login: async () => syntheticToken(50) }, successfulApi());
    await session.ensureToken();
    fake.faults.set("delete:default:token", new Error("Synthetic failed logout"));
    await assert.rejects(session.logout(), TokenStorageError);
    await assert.rejects(session.ensureToken(), TokenStorageError);
    await assert.rejects(session.status(), TokenStorageError);
    fake.faults.clear();
    await session.logout();
    assert.deepEqual(await session.status(), { authenticated: false, profile: "default" });
  });
});

test("an in-flight expired request does not bypass the storage failure latch", async () => {
  await withTempHome(async () => {
    const fake = fakeKeyring();
    const store = new KeyringSecretStore(fake.entry, "win32");
    await store.setToken(syntheticToken(40));
    let resolveExpired!: (value: any) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const pendingResponse = new Promise<any>((resolve) => { resolveExpired = resolve; });
    const api = successfulApi();
    api.requestWithRetry = async () => { notifyStarted(); return pendingResponse; };
    let browserCalls = 0;
    const session = new Session(store, { login: async () => { browserCalls++; return syntheticToken(50); } }, api);
    const pendingCall = session.call("/synthetic/read");
    const rejected = assert.rejects(pendingCall, TokenStorageError);
    await started;
    fake.faults.set("set:default:token", new Error("Synthetic force login storage failure"));
    await assert.rejects(session.ensureToken(true), TokenStorageError);
    resolveExpired({ httpStatus: 401, json: { status: 2011 } });
    await rejected;
    assert.equal(browserCalls, 1);
    await assert.rejects(session.ensureToken(), TokenStorageError);
  });
});

test("oversized token recovery retries a read but never replays a write", async () => {
  await withTempHome(async () => {
    for (const operation of ["read", "write"] as const) {
      const fake = fakeKeyring();
      const store = new KeyringSecretStore(fake.entry, "win32");
      await store.setToken(syntheticToken(40));
      let requests = 0;
      const api = successfulApi();
      api.requestWithRetry = async () => ({ httpStatus: 200, json: { status: requests++ === 0 ? 2011 : 0 } });
      const session = new Session(store, { login: async () => syntheticToken(1356) }, api);
      const call = session.call("/synthetic/action", { method: "POST", operation, body: {} });
      if (operation === "write") await assert.rejects(call, WriteReplayRequiredError);
      else assert.equal((await call).json.status, 0);
      assert.equal(requests, operation === "write" ? 1 : 2);
      assert.equal(await store.getToken(), syntheticToken(1356));
      await store.deleteToken();
    }
  });
});
