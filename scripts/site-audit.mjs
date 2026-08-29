#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const origin = "https://admin.zhenglianginfo.com";

function uniqueMatches(text, regex, normalize = (value) => value) {
  return [...new Set([...text.matchAll(regex)].map((match) => normalize(match[1] ?? match[0])))].sort();
}

export function capabilityContracts(source) {
  const file = ts.createSourceFile("capabilities.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const contracts = [];
  function textProperty(object, name) {
    const property = object.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(file).replace(/["']/g, "") === name);
    if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) return null;
    return property.initializer.text;
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "CAPABILITIES" && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const id = textProperty(element, "id");
        const method = textProperty(element, "method");
        const endpoint = textProperty(element, "path");
        if (id && method && endpoint) contracts.push({ id, method, path: endpoint });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return contracts;
}

export function auditBundleContracts(bundle, contracts) {
  const missing = [];
  const methodMismatches = [];
  for (const contract of contracts) {
    const methods = new Set();
    for (const endpoint of [`/api${contract.path}`, contract.path]) {
      for (const quote of ['"', "'", "`"]) {
        const needle = `${quote}${endpoint}${quote}`;
        let offset = 0;
        while ((offset = bundle.indexOf(needle, offset)) >= 0) {
          const window = bundle.slice(offset + needle.length, offset + needle.length + 240);
          const method = window.match(/method\s*:\s*["'](GET|POST)["']/)?.[1];
          if (method) methods.add(method);
          offset += needle.length;
        }
      }
    }
    if (methods.size === 0) missing.push(contract);
    else if (!methods.has(contract.method)) methodMismatches.push({ ...contract, frontendMethods: [...methods].sort() });
  }
  return { missing, methodMismatches };
}

async function sourceEndpoints(root) {
  const endpoints = new Set();
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith(".ts")) {
        const text = await fs.readFile(target, "utf8");
        for (const match of text.matchAll(/["'`](\/(?:auth|basic|supply|hygiene)\/[A-Za-z0-9_./-]+)/g)) endpoints.add(match[1]);
      }
    }
  }
  await walk(root);
  return [...endpoints].sort();
}

export async function runSiteAudit(options = {}) {
  const root = options.root ?? path.resolve("src");
  const fetchImpl = options.fetchImpl ?? fetch;
  const htmlResponse = await fetchImpl(`${origin}/web/user/login`, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Login page returned HTTP ${htmlResponse.status}`);
  const html = await htmlResponse.text();
  const script = html.match(/src=["'](\/umi\.[a-f0-9]+\.js)["']/i)?.[1];
  if (!script) throw new Error("The current Umi bundle could not be located");
  const bundleResponse = await fetchImpl(new URL(script, origin), { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Frontend bundle returned HTTP ${bundleResponse.status}`);
  const bundle = await bundleResponse.text();
  const routes = uniqueMatches(bundle, /path:"([^"]+)"/g);
  const proxiedEndpoints = uniqueMatches(bundle, /["'`](\/api\/(?:auth|basic|supply|hygiene)\/[A-Za-z0-9_./-]+)/g, (value) => value.slice(4));
  const directEndpoints = uniqueMatches(bundle, /["'`](\/(?:auth|basic|supply|hygiene)\/[A-Za-z0-9_./-]+)/g);
  const endpoints = [...new Set([...proxiedEndpoints, ...directEndpoints])].sort();
  const local = await sourceEndpoints(root);
  const source = await fs.readFile(path.join(root, "capabilities.ts"), "utf8");
  const contracts = capabilityContracts(source);
  if (contracts.length === 0) throw new Error("No capability contracts could be parsed");
  const frontendSet = new Set(endpoints);
  const localEndpointsNotFoundInBundle = local.filter((endpoint) => !frontendSet.has(endpoint));
  const contractAudit = auditBundleContracts(bundle, contracts);
  const drift = localEndpointsNotFoundInBundle.length > 0 || contractAudit.missing.length > 0 || contractAudit.methodMismatches.length > 0;
  return {
    auditStatus: drift ? "drift" : "passed",
    origin,
    bundle: path.basename(script),
    sha256: crypto.createHash("sha256").update(bundle).digest("hex"),
    routeCount: routes.length,
    endpointCount: endpoints.length,
    localEndpointCount: local.length,
    capabilityContractCount: contracts.length,
    localEndpointsNotFoundInBundle,
    capabilityContractsMissing: contractAudit.missing,
    capabilityMethodMismatches: contractAudit.methodMismatches,
  };
}

async function main() {
  try {
    const report = await runSiteAudit();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.auditStatus !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ auditStatus: "unavailable", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
