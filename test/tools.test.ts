import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { redacted } from "../src/logger.js";
import { ALL_TOOLS, createServer } from "../src/server.js";
import { BASE_TOOLS } from "../src/tools/base.js";
import { PURCHASE_TOOLS } from "../src/tools/purchase.js";
import { CAPABILITY_TOOLS, clearPreparedActionsForTests, setPreparedActionTestHooks } from "../src/tools/capabilities.js";
import { err, ok, verifiedWrite } from "../src/tools/shared.js";

const originalTools = [
  "login", "list_orders", "order_counts", "query_goods", "get_order", "verify_order", "raw_request",
  "match_goods", "precheck_order", "save_order", "merge_items", "delete_order",
  "save_morning_check", "save_device_disinfection", "save_waste_disposal", "list_ledger_records",
  "scan_missing_tickets", "get_order_ticket", "update_order_ticket",
  "get_committee", "save_committee", "list_warnings", "handle_warning",
];

test("all original tool names remain registered", () => {
  const names = new Set(ALL_TOOLS.map((tool) => tool.name));
  for (const name of originalTools) assert.equal(names.has(name), true, `${name} is registered`);
  for (const name of ["list_capabilities", "query_capability", "prepare_action", "execute_action"]) assert.equal(names.has(name), true, `${name} is registered`);
  assert.equal(ALL_TOOLS.length >= 32, true);
});

test("tool output recursively redacts secret fields", () => {
  const value = {
    nested: { token: "synthetic-secret-value", authorization: "Bearer synthetic-value", accessToken: "synthetic-access-token", refreshToken: "synthetic-refresh-token" },
    tokens: ["synthetic-list-token"], tokenList: ["synthetic-token-list"], authTokens: ["synthetic-auth-token"],
    apiKeys: ["synthetic-api-key"], cookies: ["synthetic-cookie"], cookieJar: ["synthetic-cookie-jar"],
    tokenCount: 3, ordinary: "visible",
  };
  const result = ok(value);
  assert.equal(result.content[0]!.text.includes("synthetic-secret-value"), false);
  assert.equal(result.content[0]!.text.includes("synthetic-value"), false);
  assert.equal(result.content[0]!.text.includes("synthetic-access-token"), false);
  assert.equal(result.content[0]!.text.includes("synthetic-refresh-token"), false);
  assert.equal(JSON.stringify(result.structuredContent).includes("synthetic-access-token"), false);
  for (const secret of ["synthetic-list-token", "synthetic-token-list", "synthetic-auth-token", "synthetic-api-key", "synthetic-cookie", "synthetic-cookie-jar"]) {
    assert.equal(result.content[0]!.text.includes(secret), false);
    assert.equal(JSON.stringify(result.structuredContent).includes(secret), false);
    assert.equal(JSON.stringify(redacted(value)).includes(secret), false);
  }
  assert.equal((result.structuredContent as any).tokenCount, 3);
  assert.equal(result.content[0]!.text.includes("visible"), true);
  assert.equal(err("Synthetic failure", { tokens: ["synthetic-error-token"] }).content[0]!.text.includes("synthetic-error-token"), false);
});

test("raw_request rejects sensitive URL and body fields before network access", async () => {
  const raw = BASE_TOOLS.find((item) => item.name === "raw_request")!;
  const calls: Array<{ pathname: string; options: unknown }> = [];
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string, options: unknown) => {
    calls.push({ pathname, options });
    return { httpStatus: 200, json: { status: 0, data: {} } };
  } } } as any;
  const queryResult = await raw.handler({ path: "/auth/groups/getUserGroupAuth?access%5Ftoken=synthetic-url-token", method: "GET" }, context);
  const bodyResult = await raw.handler({ path: "/supply/order/getOrderList", method: "POST", body: { nested: { tokenList: ["synthetic-body-token"] } } }, context);
  assert.equal(queryResult.isError, true);
  assert.equal(bodyResult.isError, true);
  assert.equal(calls.length, 0);
  const allowed = await raw.handler({ path: "/supply/order/getOrderList?pageIndex=1", method: "POST", body: { pageSize: 10 } }, context);
  assert.equal(allowed.isError, undefined);
  assert.equal(calls.length, 1);
});

test("verified writes report uncertain outcomes as MCP errors", () => {
  const failed = verifiedWrite("Synthetic verification failed", { action: "created" }, { passed: false, tokens: ["synthetic-verification-token"] });
  assert.equal(failed.isError, true);
  assert.equal((failed.structuredContent as any).details.writeAccepted, true);
  assert.equal((failed.structuredContent as any).details.verification.passed, false);
  assert.equal(failed.content[0]!.text.includes("synthetic-verification-token"), false);
  const passed = verifiedWrite("Synthetic verification failed", { action: "created" }, { passed: true });
  assert.equal(passed.isError, undefined);
  assert.equal((passed.structuredContent as any).verification.passed, true);
});

test("prepared actions are one-time and verify after execution", async () => {
  clearPreparedActionsForTests();
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const execute = CAPABILITY_TOOLS.find((item) => item.name === "execute_action")!;
  const calls: any[] = [];
  let handled = false;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string, options: any) => {
    calls.push({ pathname, options });
    if (pathname.endsWith("/opinion")) { handled = true; return { httpStatus: 200, json: { status: 0, data: {} } }; }
    return { httpStatus: 200, json: { status: 0, data: { list: [{ id: "synthetic-warning", status: handled ? "待审核" : "未办理", canteenOpinion: handled ? "Synthetic resolution" : undefined, canteenHandler: handled ? "Synthetic Handler" : undefined, canteenHandleDate: handled ? "2099-01-02" : undefined }] } } };
  } } } as any;
  const actionBody = { recordId: "synthetic-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" };
  const preview = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: actionBody }, context);
  const confirmationId = (preview.structuredContent as any).confirmationId;
  assert.equal(typeof confirmationId, "string");
  actionBody.opinion = "Synthetic mutation after preparation";
  const executed = await execute.handler({ confirmationId, confirm: true }, context);
  assert.equal((executed.structuredContent as any).status, "executed");
  assert.equal(calls.some((call) => call.pathname.endsWith("/opinion")), true);
  assert.equal(calls.find((call) => call.pathname.endsWith("/opinion")).options.body.opinion, "Synthetic resolution");
  const repeated = await execute.handler({ confirmationId, confirm: true }, context);
  assert.equal(repeated.isError, true);
});

test("prepared warning action rejects a missing target instead of executing", async () => {
  clearPreparedActionsForTests();
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async () => ({ httpStatus: 200, json: { status: 0, data: { list: [] } } }) } } as any;
  const result = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "missing-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" } }, context);
  assert.equal(result.isError, true);
});

test("query capability reports business failures on HTTP 200", async () => {
  const query = CAPABILITY_TOOLS.find((item) => item.name === "query_capability")!;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async () => ({ httpStatus: 200, json: { status: 534, info: "Synthetic permission denied" } }) } } as any;
  const result = await query.handler({ capabilityId: "canteen_info", params: {} }, context);
  assert.equal(result.isError, true);
});

test("expired confirmation handles cannot be executed", async () => {
  clearPreparedActionsForTests();
  let now = 1_000_000;
  setPreparedActionTestHooks({ now: () => now });
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async () => ({ httpStatus: 200, json: { status: 0, data: { list: [{ id: "synthetic-warning", status: "未办理" }] } } }) } } as any;
  const result = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" } }, context);
  now += 10 * 60 * 1000 + 1;
  const execute = CAPABILITY_TOOLS.find((item) => item.name === "execute_action")!;
  const expired = await execute.handler({ confirmationId: (result.structuredContent as any).confirmationId, confirm: true }, context);
  assert.equal(expired.isError, true);
  clearPreparedActionsForTests();
});

test("state changes after preparation block the write", async () => {
  clearPreparedActionsForTests();
  let reads = 0;
  let writes = 0;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string) => {
    if (pathname.endsWith("/opinion")) { writes += 1; return { httpStatus: 200, json: { status: 0 } }; }
    reads += 1;
    return { httpStatus: 200, json: { status: 0, data: { list: [{ id: "synthetic-warning", status: reads === 1 ? "未办理" : "待审核" }] } } };
  } } } as any;
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const execute = CAPABILITY_TOOLS.find((item) => item.name === "execute_action")!;
  const preview = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" } }, context);
  const result = await execute.handler({ confirmationId: (preview.structuredContent as any).confirmationId, confirm: true }, context);
  assert.equal(result.isError, true);
  assert.equal(writes, 0);
});

test("a missing post-write target is an uncertain error", async () => {
  clearPreparedActionsForTests();
  setPreparedActionTestHooks({ wait: async () => undefined });
  let handled = false;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string) => {
    if (pathname.endsWith("/opinion")) { handled = true; return { httpStatus: 200, json: { status: 0 } }; }
    return { httpStatus: 200, json: { status: 0, data: { list: handled ? [] : [{ id: "synthetic-warning", status: "未办理" }] } } };
  } } } as any;
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const execute = CAPABILITY_TOOLS.find((item) => item.name === "execute_action")!;
  const preview = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" } }, context);
  const result = await execute.handler({ confirmationId: (preview.structuredContent as any).confirmationId, confirm: true }, context);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as any).details.writeAccepted, true);
  assert.equal((result.structuredContent as any).details.verification.checks.found, false);
  clearPreparedActionsForTests();
});

test("concurrent execution consumes a confirmation only once", async () => {
  clearPreparedActionsForTests();
  let handled = false;
  let writes = 0;
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string) => {
    if (pathname.endsWith("/opinion")) { writes += 1; handled = true; return { httpStatus: 200, json: { status: 0 } }; }
    return { httpStatus: 200, json: { status: 0, data: { list: [{ id: "synthetic-warning", status: handled ? "待审核" : "未办理", canteenOpinion: handled ? "Synthetic resolution" : undefined, canteenHandler: handled ? "Synthetic Handler" : undefined, canteenHandleDate: handled ? "2099-01-02" : undefined }] } } };
  } } } as any;
  const prepare = CAPABILITY_TOOLS.find((item) => item.name === "prepare_action")!;
  const execute = CAPABILITY_TOOLS.find((item) => item.name === "execute_action")!;
  const preview = await prepare.handler({ capabilityId: "handle_food_safety_warning", body: { recordId: "synthetic-warning", opinion: "Synthetic resolution", handler: "Synthetic Handler", handleDate: "2099-01-02" } }, context);
  const confirmationId = (preview.structuredContent as any).confirmationId;
  const results = await Promise.all([execute.handler({ confirmationId, confirm: true }, context), execute.handler({ confirmationId, confirm: true }, context)]);
  assert.equal(results.filter((result) => result.isError).length, 1);
  assert.equal(writes, 1);
});

test("query capability validates fields and forwards GET and POST correctly", async () => {
  const query = CAPABILITY_TOOLS.find((item) => item.name === "query_capability")!;
  const calls: any[] = [];
  const context = { session: { revision: 0, ensureToken: async () => "synthetic-unit-test-session", assertRevision: (revision: number) => { assert.equal(revision, 0); }, call: async (pathname: string, options: any) => {
    calls.push({ pathname, options });
    return { httpStatus: 200, json: { status: 0, data: {} } };
  } } } as any;
  const unknown = await query.handler({ capabilityId: "synthetic-unknown", params: {} }, context);
  const invalid = await query.handler({ capabilityId: "canteen_info", params: { unsupported: true } }, context);
  assert.equal(unknown.isError, true);
  assert.equal(invalid.isError, true);
  await query.handler({ capabilityId: "order", params: { orderCode: "synthetic-order" } }, context);
  await query.handler({ capabilityId: "canteen_info", params: {} }, context);
  assert.match(calls[0].pathname, /orderCode=synthetic-order/);
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(calls[1].options.body, {});
});

test("MCP server exposes tools, resources, prompts, and effect annotations", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({} as any);
  const client = new Client({ name: "synthetic-test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const prompts = await client.listPrompts();
  assert.equal(tools.tools.some((tool) => tool.name === "logout" && tool.annotations?.readOnlyHint === false), true);
  assert.equal(resources.resources.some((resource) => resource.uri === "zhengliang://security"), true);
  assert.equal(prompts.prompts.some((prompt) => prompt.name === "canteen_workflow"), true);
  await client.close();
  await server.close();
});

test("merge_items combines identical labels and units", async () => {
  const tool = PURCHASE_TOOLS.find((item) => item.name === "merge_items")!;
  const result = await tool.handler({ items: [["Synthetic Item", 2, "unit"], ["Synthetic Item", 3, "unit"]] }, {} as any);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].saveAmount, 5);
});
