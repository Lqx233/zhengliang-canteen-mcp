import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ApiClient, RequestFailure, isAuthFailure } from "../src/api.js";
import { Session, AuthenticationChangedError } from "../src/session.js";
import { KeyringSecretStore, MemorySecretStore } from "../src/auth/tokenStore.js";
import { acquireStorageLock } from "../src/auth/lock.js";
import { CAPABILITY_TOOLS, clearPreparedActionsForTests } from "../src/tools/capabilities.js";
import { PURCHASE_TOOLS } from "../src/tools/purchase.js";
import { LEDGER_TOOLS } from "../src/tools/ledger.js";
import { COMMITTEE_TOOLS } from "../src/tools/committee.js";
import { TICKET_TOOLS } from "../src/tools/tickets.js";
import { ProfileWizard } from "../src/config/wizard.js";
import { EventEmitter } from "node:events";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DiscoveryService } from "../src/discovery.js";
import { matchesFields, sameRecords } from "../src/tools/verification.js";

const token = "synthetic-stability-session-value";
const response = (data: unknown = {}) => ({ httpStatus: 200, json: { status: 0, data } });
const api = () => ({ request: async () => response(), requestWithRetry: async () => response() }) as unknown as ApiClient;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function isolated(run: () => Promise<void>) {
  const old = process.env.ZHENGLIANG_MCP_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-stability-"));
  process.env.ZHENGLIANG_MCP_HOME = home;
  try { await run(); } finally {
    if (old === undefined) delete process.env.ZHENGLIANG_MCP_HOME; else process.env.ZHENGLIANG_MCP_HOME = old;
    await fs.rm(home, { recursive: true, force: true });
  }
}
function fakeEntries() {
  const values = new Map<string, string>();
  const entry = (account: string) => ({ getPassword: () => values.get(account) ?? null,
    setPassword: (value: string) => { values.set(account, value); }, deletePassword: () => values.delete(account) });
  return { values, entry };
}
const profile: any = {
  version: 1, buyer: "Synthetic Buyer", buyerPhone: "synthetic-contact", purpose: 1,
  warehouses: [{ warehouseId: "synthetic-warehouse", warehouseName: "Synthetic Warehouse", receiver: "Synthetic Receiver", receiverPhone: "synthetic-contact", nutrition: 0, remark: "Synthetic Warehouse" }],
  ledgers: { morningChecker: "Synthetic Checker", deviceChecker: "Synthetic Checker", deviceExecuter: "Synthetic Executor", wasteChecker: "Synthetic Checker", wasteDisposer: "Synthetic Disposer", wasteHandler: "Synthetic Handler", dinersCount: 100 }, aliases: [],
};

test("logout cancels an unfinished login and prevents late token persistence", async () => isolated(async () => {
  const secrets = new MemorySecretStore();
  const started = deferred<void>(); const browserResult = deferred<string>();
  const session = new Session(secrets, { login: async () => { started.resolve(); return browserResult.promise; } }, api());
  const failed = assert.rejects(session.ensureToken(), AuthenticationChangedError);
  await started.promise;
  await session.logout();
  browserResult.resolve(token);
  await failed;
  assert.equal(await secrets.getToken(), null);
  assert.equal((await session.status()).authenticated, false);
}));

test("logout during persistence waits for the write then removes it", async () => isolated(async () => {
  const secrets = new MemorySecretStore(); const started = deferred<void>(); const persist = deferred<void>();
  secrets.setToken = async (value) => { started.resolve(); await persist.promise; MemorySecretStore.prototype.setToken.call(secrets, value); };
  const session = new Session(secrets, { login: async () => token }, api());
  const failed = assert.rejects(session.ensureToken(), AuthenticationChangedError);
  await started.promise; const logout = session.logout(); persist.resolve();
  await logout; await failed;
  assert.equal(await secrets.getToken(), null);
}));

test("late expired responses reuse the renewed token without a second browser", async () => isolated(async () => {
  const secrets = new MemorySecretStore(); await secrets.setToken(token);
  const late = deferred<any>(); const started = deferred<void>(); let browserCalls = 0;
  const client = api(); let count = 0;
  client.requestWithRetry = async (_path, options) => {
    if (options?.token !== token) return response();
    if (++count === 1) { started.resolve(); return late.promise; }
    return { httpStatus: 401, json: {} };
  };
  const session = new Session(secrets, { login: async () => { browserCalls++; return `${token}-renewed`; } }, client);
  const first = session.call("/synthetic/first"); await started.promise;
  await session.call("/synthetic/second");
  late.resolve({ httpStatus: 401, json: {} }); await first;
  assert.equal(browserCalls, 1); assert.equal(await secrets.getToken(), `${token}-renewed`);
}));

test("503 and non-JSON validation never authenticate or erase saved credentials", async () => isolated(async () => {
  for (const validation of [{ httpStatus: 503, json: { status: 0 } }, { httpStatus: 200, json: { status: "parse_error" } }]) {
    const secrets = new MemorySecretStore(); await secrets.setToken(token); const client = api();
    client.request = async () => validation;
    const session = new Session(secrets, { login: async () => { assert.fail("must not relogin"); } }, client);
    await assert.rejects(session.ensureToken(), /not successful/);
    await assert.rejects(session.status(), /not successful/);
    assert.equal(await secrets.getToken(), token);
  }
  assert.equal(isAuthFailure({ httpStatus: 200, json: { status: 0, info: "Synthetic token metadata" } }), false);
}));

test("concurrent key creation returns one key across store instances", async () => isolated(async () => {
  const fake = fakeEntries();
  const first = new KeyringSecretStore(fake.entry); const second = new KeyringSecretStore(fake.entry);
  const keys = await Promise.all([first.ensureConfigKey(), second.ensureConfigKey(), first.ensureConfigKey()]);
  assert.ok(keys.every((key) => key.equals(keys[0]!)));
  assert.ok(keys[0]!.equals((await second.getConfigKey())!));
}));

test("live storage lock is not stolen; cancellation and release are idempotent", async () => isolated(async () => {
  const release = await acquireStorageLock("synthetic", "test");
  await assert.rejects(acquireStorageLock("synthetic", "test", undefined, 20), /Timed out/);
  const controller = new AbortController(); const waiting = acquireStorageLock("synthetic", "test", controller.signal);
  controller.abort(); await assert.rejects(waiting);
  await release();
  const newer = await acquireStorageLock("synthetic", "test");
  await release(); // Old release cannot remove the new lock.
  await assert.rejects(acquireStorageLock("synthetic", "test", undefined, 20), /Timed out/);
  await newer();
}));

test("API deadline includes response body and distinguishes uncertain writes", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, options: any) => ({
    status: 200, text: async () => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error(token)), { once: true });
    }),
  }));
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    for (const operation of ["read", "write"] as const) {
      await assert.rejects(new ApiClient().request("/synthetic", { operation, method: "POST", timeoutMs: 20 }), (error: unknown) => {
        assert.ok(error instanceof RequestFailure); assert.equal(error.writeUncertain, operation === "write");
        assert.equal(error.timedOut, true); assert.equal(String(error).includes(token), false); return true;
      });
    }
  } finally { clearTimeout(keepAlive); fetchMock.mock.restore(); }
});

test("only explicit reads retry rate limits; HTML and pre-aborted requests stay safe", async (t) => {
  const client = new ApiClient(); let calls = 0;
  client.request = async () => { calls++; return { httpStatus: 429, json: { status: 9999 } }; };
  for (const options of [{ operation: "write" as const, method: "GET" as const }, { method: "POST" as const }]) {
    calls = 0; await client.requestWithRetry("/synthetic", options); assert.equal(calls, 1);
  }
  calls = 0; client.request = async () => ({ httpStatus: 200, json: { status: calls++ === 0 ? 9999 : 0 } });
  await client.requestWithRetry("/synthetic", { operation: "read", timeoutMs: 2000 }); assert.equal(calls, 2);
  calls = 0; await assert.rejects(client.requestWithRetry("/synthetic", { operation: "read", timeoutMs: 20 }), RequestFailure); assert.equal(calls, 1);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; return { status: 502, text: async () => `<html>${token}</html>` }; });
  const html = await new ApiClient().request("/synthetic"); assert.equal(JSON.stringify(html).includes(token), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new ApiClient().request("/synthetic", { operation: "write", signal: controller.signal }), (error: any) => error instanceof RequestFailure && !error.writeUncertain);
  assert.equal(fetches, 1);
});

function actionContext() {
  let handled = false; let writes = 0; let revision = 1;
  const session = { get revision() { return revision; }, ensureToken: async () => token,
    assertRevision: (expected: number) => { if (revision !== expected) throw new AuthenticationChangedError(); },
    call: async (_path: string, options: any) => {
      if (options.operation === "write") { writes++; handled = true; }
      return response({ list: [{ id: "synthetic-warning", status: handled ? "待审核" : "未办理", canteenOpinion: "Synthetic opinion", canteenHandler: "Synthetic Handler", canteenHandleDate: "2099-01-01" }] });
    } };
  return { context: { session } as any, writes: () => writes, renew: () => { revision++; } };
}

test("confirmations are bound to session and authentication revision", async () => {
  clearPreparedActionsForTests(); const a = actionContext(); const b = actionContext();
  const prepare = CAPABILITY_TOOLS.find((tool) => tool.name === "prepare_action")!;
  const execute = CAPABILITY_TOOLS.find((tool) => tool.name === "execute_action")!;
  const result = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic opinion", handler: "Synthetic Handler", handleDate: "2099-01-01" } }, a.context);
  const args = { confirmationId: result.structuredContent!.confirmationId, confirm: true };
  assert.equal((await execute.handler(args, b.context)).isError, true);
  a.renew(); assert.equal((await execute.handler(args, a.context)).isError, true);
  assert.equal(a.writes() + b.writes(), 0);
});

test("conflicting prices or goods are rejected and ambiguous catalogue matches block", async () => {
  const merge = PURCHASE_TOOLS.find((tool) => tool.name === "merge_items")!;
  await assert.rejects(merge.handler({ items: [["Synthetic Goods", 1, "unit", { priceOverride: 1 }], ["Synthetic Goods", 1, "unit", { priceOverride: 2 }]] }, {} as any), /Conflicting/);
  const context = { vault: { load: async () => profile }, discovery: { suppliers: async () => [{ enterpriseCode: "synthetic-supplier", enterpriseName: "Synthetic Supplier", storeCode: "synthetic-store" }] }, session: { call: async () => response([{ code: "synthetic-a", name: "Synthetic Goods", unit: "unit", price: 1 }, { code: "synthetic-b", name: "Synthetic Goods", unit: "unit", price: 1 }]) } } as any;
  const matched = await PURCHASE_TOOLS.find((tool) => tool.name === "match_goods")!.handler({ enterpriseCode: "synthetic-supplier", items: [["Synthetic Goods", 1, "unit"]] }, context);
  assert.equal(matched.structuredContent!.status, "blocked_human_decision");
});

const actualRecord = { employeeId: "synthetic-employee", temperature: 38.1, attendanceTime: "07:12:00", attendanceStatus: 0,
  isVomiting: 0, isDiarrhea: 0, isCough: 1, isInfection: 0, decorations: 1, nailsHair: 1, overalls: 1,
  temperatureStatus: 0, processResult: "Synthetic abnormal result", remarks: "Synthetic follow-up" };

test("morning checks require actual records and preserve abnormal measurements", async (t) => {
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => { queueMicrotask(callback); return { unref() {} }; }) as any);
  const tool = LEDGER_TOOLS.find((item) => item.name === "save_morning_check")!;
  let body: any; let writes = 0;
  const context = { vault: { load: async () => profile }, session: { call: async (_p: string, options: any) => {
    if (options.operation === "write") { body = options.body; writes++; return response(); }
    if (body) return response(body);
    if (_p.includes("2099-01-02")) return response({});
    return response({ date: "2099-01-01", recordValue: [{ employeeId: "synthetic-employee", employeeName: "Synthetic Employee", value: "{}" }] });
  } } } as any;
  assert.equal((await tool.handler({ date: "2099-01-02" }, context)).isError, true); assert.equal(writes, 0);
  const result = await tool.handler({ date: "2099-01-02", records: [actualRecord] }, context);
  assert.equal(JSON.parse(body.recordValue[0].value).temperature, "38.1");
  assert.equal(JSON.parse(body.recordValue[0].value).isCough, 1);
  assert.equal((result.structuredContent!.verification as any).passed, true);
  assert.equal(writes, 1);
});

test("committee roles, waste amounts and ticket fields must match after a write", async (t) => {
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => { queueMicrotask(callback); return { unref() {} }; }) as any);
  const committee = await COMMITTEE_TOOLS.find((tool) => tool.name === "save_committee")!.handler({ kind: "diet", semester: "Synthetic Term", confirm: true, members: [{ name: "Synthetic Member", position: 1 }] }, { session: { call: async (p: string) => p.endsWith("updateInfo") ? response() : response([{ id: "synthetic-term", committeeName: "Synthetic Term", itemList: [{ name: "Synthetic Member", position: 3 }] }]) } } as any);
  assert.equal(committee.isError, true);
  let payload: any;
  const waste = await LEDGER_TOOLS.find((tool) => tool.name === "save_waste_disposal")!.handler({ date: "2099-01-01", amounts: { 餐厨: 1, 食材废料: 2, 其他: 3 } }, { vault: { load: async () => profile }, session: { call: async (_p: string, o: any) => {
    if (o.operation === "write") { payload = structuredClone(o.body); const value = JSON.parse(payload.recordValue.value); value.wasteDisposalDtlList[0].amount = 999; payload.recordValue.value = JSON.stringify(value); return response(); }
    return response(payload ?? {});
  } } } as any);
  assert.equal(waste.isError, true);
  let saved = false;
  const tickets = await TICKET_TOOLS.find((tool) => tool.name === "update_order_ticket")!.handler({ queryTicketId: 1, confirm: true, certificateList: [{ id: "synthetic-certificate", url: "synthetic-new-image" }] }, { session: { call: async (_p: string, o: any) => {
    if (o.operation === "write") { saved = true; return response(); }
    return response({ id: 1, invoiceList: [], certificateList: [{ id: "synthetic-certificate", url: "synthetic-old-image" }] });
  } } } as any);
  assert.equal(saved, true); assert.equal(tickets.isError, true);
});

function browserStub(onNavigate: (url: string, page: EventEmitter) => Promise<void>) {
  const browser = new EventEmitter() as any; const page = new EventEmitter() as any;
  let closed = false;
  browser.newContext = async () => ({ newPage: async () => page });
  browser.close = async () => { closed = true; browser.emit("disconnected"); };
  page.goto = async (url: string) => onNavigate(url, page);
  return { browser, closed: () => closed };
}

test("configuration window is shared and retains aliases when saved", async () => {
  const existing = { ...profile, aliases: [{ enterpriseCode: "synthetic-supplier", label: "Synthetic Goods", unit: "unit", goodsCode: "synthetic-goods", goodsName: "Synthetic Goods" }] };
  let saved: any; let launches = 0;
  const stub = browserStub(async (url) => {
    const parsed = new URL(url); const headers = { "x-setup-nonce": parsed.searchParams.get("nonce")! };
    const discovery = await fetch(`${parsed.origin}/api/discovery`, { headers }).then((r) => r.json());
    assert.equal(discovery.profile.buyer, profile.buyer);
    const result = await fetch(`${parsed.origin}/api/save`, { method: "POST", headers, body: JSON.stringify({ ...profile, buyer: "Synthetic Changed Buyer", aliases: [] }) });
    assert.equal(result.status, 200);
  });
  const wizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => existing, save: async (p: any) => { saved = p; } } as any, async () => { launches++; return stub.browser; });
  const a = wizard.open(); const b = wizard.open(); assert.equal(a, b); await a;
  assert.equal(launches, 1); assert.equal(stub.closed(), true); assert.deepEqual(saved.aliases, existing.aliases);
});

test("configuration startup failure closes its listener; closing a page settles the request", async (t) => {
  const servers: http.Server[] = []; const create = http.createServer.bind(http);
  const mock = t.mock.method(http, "createServer", ((...args: any[]) => { const server = (create as any)(...args); servers.push(server); return server; }) as any);
  try {
    const wizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => null } as any, async () => { throw new Error("Synthetic browser failure"); });
    await assert.rejects(wizard.open(), /Synthetic browser failure/); assert.ok(servers.every((server) => !server.listening));
    const stub = browserStub(async (_url, page) => { page.emit("close"); });
    const closeWizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => null } as any, async () => stub.browser);
    await assert.rejects(closeWizard.open(), /closed/); assert.equal(stub.closed(), true); assert.ok(servers.every((server) => !server.listening));
  } finally { mock.mock.restore(); }
});

test("configuration timeout settles hung launch and navigation and closes late browsers", async () => {
  const launched = deferred<any>();
  const late = browserStub(async () => undefined);
  const wizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => null } as any, () => launched.promise, 30);
  await assert.rejects(wizard.open(), /timed out/);
  launched.resolve(late.browser);
  await delay(10);
  assert.equal(late.closed(), true);
  const hung = browserStub(async () => new Promise(() => undefined));
  const navigation = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => null } as any, async () => hung.browser, 30);
  await assert.rejects(navigation.open(), /timed out/);
  assert.equal(hung.closed(), true);
});

test("configuration rejects duplicate saves and permits retry after a failed save", async () => {
  const started = deferred<void>(); const finish = deferred<void>(); let attempts = 0;
  const stub = browserStub(async (url) => {
    const parsed = new URL(url); const options = { method: "POST", headers: { "x-setup-nonce": parsed.searchParams.get("nonce")! }, body: JSON.stringify(profile) };
    const first = fetch(`${parsed.origin}/api/save`, options);
    await started.promise;
    assert.equal((await fetch(`${parsed.origin}/api/save`, options)).status, 409);
    finish.resolve(); assert.equal((await first).status, 400);
    assert.equal((await fetch(`${parsed.origin}/api/save`, options)).status, 200);
  });
  const wizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => profile, save: async () => {
    if (++attempts === 1) { started.resolve(); await finish.promise; throw new Error("Synthetic storage error"); }
  } } as any, async () => stub.browser);
  await wizard.open(); assert.equal(attempts, 2);
});

test("configuration timeout aborts an incomplete request body", async () => {
  let request: http.ClientRequest | undefined;
  const stub = browserStub(async (url) => {
    const parsed = new URL(url);
    request = http.request(`${parsed.origin}/api/save`, { method: "POST", headers: { "x-setup-nonce": parsed.searchParams.get("nonce")!, "content-length": 1000 } });
    request.on("error", () => undefined);
    request.write("{");
  });
  const wizard = new ProfileWizard({ warehouses: async () => [] } as any, { load: async () => null, save: async () => assert.fail("incomplete input must not save") } as any, async () => stub.browser, 50);
  try { await assert.rejects(wizard.open(), /timed out/); assert.equal(stub.closed(), true); }
  finally { request?.destroy(); }
});

function purchaseContext(mode: "correct" | "wrong-price" | "ambiguous") {
  let payload: any; let writes = 0;
  const row = (orderCode: string) => ({ orderCode, enterpriseCode: "synthetic-supplier", warehouseName: profile.warehouses[0].warehouseName });
  return { writes: () => writes, context: { vault: { load: async () => structuredClone(profile) },
    discovery: { suppliers: async () => [{ enterpriseCode: "synthetic-supplier", enterpriseName: "Synthetic Supplier", storeCode: "synthetic-store" }] },
    session: { call: async (p: string, o: any) => {
      if (p.includes("getGoodsList")) return response([{ code: "synthetic-goods", name: "Synthetic Goods", unit: "unit", price: 2 }]);
      if (p.includes("saveOrder")) { payload = o.body; writes++; return response(); }
      if (p.includes("getOrderList")) return response(payload ? [row("synthetic-order-a"), ...(mode === "ambiguous" ? [row("synthetic-order-b")] : [])] : []);
      return response({ ...payload, status: 0, orderGoodsList: payload.goodsList.map((item: any) => ({ ...item, price: mode === "wrong-price" ? 999 : item.price })) });
    } },
  } as any };
}

test("purchase verification accepts one exact draft but rejects wrong prices and ambiguity", async (t) => {
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => { queueMicrotask(callback); return { unref() {} }; }) as any);
  const tool = PURCHASE_TOOLS.find((item) => item.name === "save_order")!;
  for (const mode of ["correct", "wrong-price", "ambiguous"] as const) {
    const c = purchaseContext(mode);
    const result = await tool.handler({ enterpriseCode: "synthetic-supplier", warehouse: "synthetic-warehouse", deliveryDate: "2099-01-01 08:00:00", items: [["Synthetic Goods", 1, "unit"]] }, c.context);
    assert.equal(Boolean(result.isError), mode !== "correct", mode); assert.equal(c.writes(), 1);
  }
});

test("draft deletion checks page two and rejects incomplete or repeated pages", async (t) => {
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => { queueMicrotask(callback); return { unref() {} }; }) as any);
  const first = Array.from({ length: 100 }, (_v, index) => ({ orderCode: `synthetic-draft-${index}` }));
  const tool = PURCHASE_TOOLS.find((item) => item.name === "delete_order")!;
  for (const mode of ["present", "absent", "repeated", "incomplete"]) {
    let pages = 0; let writes = 0;
    const result = await tool.handler({ orderCode: "synthetic-target", confirm: true }, { session: { call: async (p: string, o: any) => {
      if (o.operation === "write") { writes++; return response(); }
      if (!p.includes("getOrderList")) return response({ status: 0 });
      pages++;
      if (o.body.pageIndex === 1) return response({ list: first, totalCount: 101 });
      return response({ list: mode === "incomplete" ? [] : mode === "repeated" ? [first[0]] : [{ orderCode: mode === "present" ? "synthetic-target" : "synthetic-unrelated" }], totalCount: 101 });
    } } } as any);
    assert.equal(Boolean(result.isError), mode !== "absent", mode); assert.equal(pages, 2); assert.equal(writes, 1);
  }
});

test("actual employee identity and device fields must match; missing employees block before writes", async (t) => {
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => { queueMicrotask(callback); return { unref() {} }; }) as any);
  const morning = LEDGER_TOOLS.find((tool) => tool.name === "save_morning_check")!;
  for (const mode of ["unknown", "duplicate", "changed"] as const) {
    let payload: any; let writes = 0;
    const records = mode === "duplicate" ? [actualRecord, actualRecord] : [{ ...actualRecord, employeeId: mode === "unknown" ? "synthetic-unknown" : actualRecord.employeeId }];
    const result = await morning.handler({ date: "2099-01-02", records }, { vault: { load: async () => profile }, session: { call: async (p: string, o: any) => {
      if (o.operation === "write") { payload = structuredClone(o.body); writes++; return response(); }
      if (payload) { payload.recordValue[0].employeeId = "synthetic-wrong-employee"; return response(payload); }
      return response(p.includes("2099-01-02") ? {} : { recordValue: [{ employeeId: actualRecord.employeeId, employeeName: "Synthetic Employee", value: "{}" }] });
    } } } as any);
    assert.equal(result.isError, true); assert.equal(writes, mode === "changed" ? 1 : 0);
  }
  for (const wrong of [false, true]) {
    let payload: any;
    const result = await LEDGER_TOOLS.find((tool) => tool.name === "save_device_disinfection")!.handler({ date: "2099-01-02", duration: 40 }, { vault: { load: async () => profile }, session: { call: async (p: string, o: any) => {
      if (o.operation === "write") { payload = structuredClone(o.body); return response(); }
      if (payload) {
        const data = JSON.parse(payload.recordValue.value); if (wrong) data.deviceDistinctionItemList[0].duration = 1;
        return response({ ...payload, recordValue: { value: JSON.stringify(data) } });
      }
      return response(p.includes("2099-01-02") ? {} : { recordValue: { value: JSON.stringify({ deviceDistinctionItemList: [{ id: "synthetic-device", name: "Synthetic Device" }] }) } });
    } } } as any);
    assert.equal(Boolean(result.isError), wrong);
  }
});

test("transport errors and backoff cancellation do not resend writes or expose causes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error(token); });
  await assert.rejects(new ApiClient().requestWithRetry("/synthetic", { method: "POST", operation: "write" }), (error: any) => error.writeUncertain && !String(error).includes(token));
  assert.equal(calls, 1);
  const client = new ApiClient(); const controller = new AbortController();
  client.request = async () => { queueMicrotask(() => controller.abort()); return { httpStatus: 429, json: {} }; };
  await assert.rejects(client.requestWithRetry("/synthetic", { operation: "read", signal: controller.signal }), RequestFailure);
});

test("storage locks serialize child processes and recover an exited owner", async () => isolated(async () => {
  const run = promisify(execFile);
  const moduleUrl = new URL("../src/auth/lock.js", import.meta.url).href;
  const counter = path.join(process.env.ZHENGLIANG_MCP_HOME!, "synthetic-counter.json");
  await fs.writeFile(counter, "0");
  const child = (script: string) => run(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
  await child(`import { acquireStorageLock } from ${JSON.stringify(moduleUrl)}; await acquireStorageLock('synthetic-process', 'counter'); process.exit(0);`);
  const increment = `import { acquireStorageLock } from ${JSON.stringify(moduleUrl)};
    import fs from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    for (let i = 0; i < 3; i++) {
      const release = await acquireStorageLock('synthetic-process', 'counter');
      try { const count = Number(await fs.readFile(${JSON.stringify(counter)}, 'utf8'));
        await delay(10); await fs.writeFile(${JSON.stringify(counter)}, String(count + 1));
      } finally { await release(); }
    }`;
  await Promise.all([child(increment), child(increment), child(increment)]);
  assert.equal(await fs.readFile(counter, "utf8"), "9");
}));

test("concurrent token transitions leave one decryptable value and delete both stores", async () => isolated(async () => {
  const fake = fakeEntries();
  const first = new KeyringSecretStore(fake.entry, "win32"); const second = new KeyringSecretStore(fake.entry, "win32");
  const long = "synthetic-session-".repeat(100);
  await Promise.all([first.setToken(long), second.setToken(`${token}-short`)]);
  assert.ok([long, `${token}-short`].includes((await first.getToken())!));
  await Promise.all([first.deleteToken(), second.deleteToken()]);
  assert.equal(await first.getToken(), null); assert.equal(await second.getToken(), null);
}));

test("discovery failures propagate instead of becoming empty inventories", async () => {
  const discovery = new DiscoveryService({ call: async () => ({ httpStatus: 503, json: { status: 0, data: [] } }) } as any);
  await assert.rejects(discovery.warehouses(), /not successful/);
  await assert.rejects(discovery.suppliers(), /not successful/);
});

test("late status validation cannot report authenticated after logout", async () => isolated(async () => {
  const secrets = new MemorySecretStore(); await secrets.setToken(token);
  const client = api(); const started = deferred<void>(); const result = deferred<any>();
  client.request = async () => { started.resolve(); return result.promise; };
  const session = new Session(secrets, { login: async () => token }, client);
  const pending = assert.rejects(session.status(), AuthenticationChangedError);
  await started.promise; await session.logout(); result.resolve(response()); await pending;
  assert.equal((await session.status()).authenticated, false);
}));

test("real session renewal during confirmation revalidation prevents the write", async () => isolated(async () => {
  clearPreparedActionsForTests();
  const client = api(); const secrets = new MemorySecretStore(); await secrets.setToken(token);
  let expire = false; let writes = 0;
  client.requestWithRetry = async (_p, o) => {
    if (o?.operation === "write") { writes++; return response(); }
    if (expire && o?.token === token) return { httpStatus: 401, json: {} };
    return response({ list: [{ id: "synthetic-warning", status: "未办理" }] });
  };
  const session = new Session(secrets, { login: async () => `${token}-new` }, client);
  const context = { session } as any;
  const prepared = await CAPABILITY_TOOLS.find((tool) => tool.name === "prepare_action")!.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic opinion", handler: "Synthetic Handler", handleDate: "2099-01-01" } }, context);
  assert.equal(Boolean(prepared.isError), false);
  expire = true;
  const result = await CAPABILITY_TOOLS.find((tool) => tool.name === "execute_action")!.handler({ confirmationId: prepared.structuredContent!.confirmationId, confirm: true }, context);
  assert.equal(result.isError, true); assert.equal(writes, 0);
}));

test("verification supports numeric API strings without accepting missing or duplicated fields", () => {
  assert.equal(matchesFields({ amount: "2", price: "1.20" }, { amount: 2, price: 1.2 }), true);
  assert.equal(matchesFields({ amount: true }, { amount: 1 }), false);
  assert.equal(matchesFields({ amount: " " }, { amount: 0 }), false);
  assert.equal(matchesFields({}, { amount: 0 }), false);
  assert.equal(sameRecords([{ id: "synthetic-a" }, { id: "synthetic-b" }], [{ id: "synthetic-a" }, { id: "synthetic-a" }]), false);
});

test("a non-JSON write response is uncertain and is not replayed", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { status: 200, text: async () => `<html>${token}</html>` }; });
  await assert.rejects(new ApiClient().requestWithRetry("/synthetic", { method: "POST", operation: "write" }), (error: any) => error instanceof RequestFailure && error.writeUncertain && !String(error).includes(token));
  assert.equal(calls, 1);
});
