const TOKEN_KEYS = /^(admin-authorization|authorization|token|password|secret)$/i;
const PHONE = /(?<!\d)1\d{10}(?!\d)/g;

function scrub(value: unknown, key = ""): unknown {
  if (TOKEN_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(PHONE, "[PHONE]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/Admin-Authorization["':\s]+[^\s,}]+/gi, "Admin-Authorization: [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrub(child, childKey)]),
    );
  }
  return value;
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  const payload = scrub({ event, ...details });
  process.stderr.write(`[zhengliang-canteen] ${JSON.stringify(payload)}\n`);
}

export function redacted(value: unknown): unknown {
  return scrub(value);
}
