import assert from "node:assert/strict";
import test from "node:test";
import { auditBundleContracts, capabilityContracts } from "../scripts/site-audit.mjs";

const source = `export const CAPABILITIES = [
  { id: "synthetic_read", kind: "read", method: "GET", path: "/basic/synthetic/read" },
  { id: "synthetic_write", kind: "write", method: "POST", path: "/hygiene/api/synthetic/write" },
];`;

test("site audit parses capability contracts and accepts matching methods", () => {
  const contracts = capabilityContracts(source);
  const bundle = `request("/api/basic/synthetic/read",{method:"GET"});request("/hygiene/api/synthetic/write",{method:"POST"})`;
  assert.equal(contracts.length, 2);
  assert.deepEqual(auditBundleContracts(bundle, contracts), { missing: [], methodMismatches: [] });
});

test("site audit distinguishes missing endpoints from method drift", () => {
  const contracts = capabilityContracts(source);
  const bundle = `request("/api/basic/synthetic/read",{method:"POST"})`;
  const result = auditBundleContracts(bundle, contracts);
  assert.equal(result.methodMismatches[0].id, "synthetic_read");
  assert.equal(result.missing[0].id, "synthetic_write");
});
