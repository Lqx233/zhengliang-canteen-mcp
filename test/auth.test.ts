import assert from "node:assert/strict";
import test from "node:test";
import { extractToken } from "../src/auth/browserAuth.js";
import { MemorySecretStore } from "../src/auth/tokenStore.js";
import { Session, WriteReplayRequiredError } from "../src/session.js";

test("extractToken accepts only a JSON object with a nontrivial token", () => {
  assert.equal(extractToken(null), null);
  assert.equal(extractToken("not-json"), null);
  assert.equal(extractToken(JSON.stringify({ token: "short" })), null);
  assert.equal(extractToken(JSON.stringify({ token: "synthetic-session-token-value" })), "synthetic-session-token-value");
});

test("stored token is validated and reused without opening a browser", async () => {
  const secrets = new MemorySecretStore();
  await secrets.setToken("stored-synthetic-session-token");
  let browserCalls = 0;
  const api = { request: async () => ({ httpStatus: 200, json: { status: 0 } }), requestWithRetry: async () => ({ httpStatus: 200, json: { status: 0 } }) } as any;
  const session = new Session(secrets, { login: async () => { browserCalls += 1; return "new-synthetic-session-token"; } }, api);
  assert.equal(await session.ensureToken(), "stored-synthetic-session-token");
  assert.equal(browserCalls, 0);
});

test("rejected stored token opens the browser once and replaces it", async () => {
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

test("write requests are not replayed after authentication recovery", async () => {
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
