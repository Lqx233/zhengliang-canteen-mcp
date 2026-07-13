#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const excluded = new Set([".git", "node_modules", "build", "coverage", "artifacts", "output", "test-results", "playwright-report"]);
const textExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".toml", ".txt", ""]);
const findings = [];
const rules = [
  { name: "mobile phone", regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: "UUID literal", regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "literal bearer token", regex: /Bearer\s+[A-Za-z0-9._~-]{20,}/g },
  { name: "tenant-specific place marker", regex: new RegExp(["绥", "宁"].join(""), "g") },
];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (textExtensions.has(path.extname(entry.name))) {
      const text = await fs.readFile(target, "utf8");
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(text)) findings.push({ file: path.relative(root, target), rule: rule.name });
      }
      if (/employee_(?:page|detail)\.json/i.test(entry.name)) findings.push({ file: path.relative(root, target), rule: "production employee fixture" });
    }
  }
}

await walk(root);
if (findings.length) {
  process.stderr.write(`${JSON.stringify({ privacyAudit: "failed", findings }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ privacyAudit: "passed", root })}\n`);
