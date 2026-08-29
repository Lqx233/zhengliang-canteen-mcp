import { scrubSecrets } from "./redaction.js";

const PHONE = /(?<!\d)1\d{10}(?!\d)/g;

function scrub(value: unknown, key = ""): unknown {
  const safe = scrubSecrets(value, key);
  if (typeof safe === "string") return safe.replace(PHONE, "[PHONE]");
  if (Array.isArray(safe)) return safe.map((item) => scrub(item));
  if (safe && typeof safe === "object") {
    return Object.fromEntries(
      Object.entries(safe as Record<string, unknown>).map(([childKey, child]) => [childKey, scrub(child, childKey)]),
    );
  }
  return safe;
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  const payload = scrub({ event, ...details });
  process.stderr.write(`[zhengliang-canteen] ${JSON.stringify(payload)}\n`);
}

export function redacted(value: unknown): unknown {
  return scrub(value);
}
