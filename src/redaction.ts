const SENSITIVE_WORDS = new Set([
  "token", "tokens",
  "authorization", "authorizations",
  "password", "passwords",
  "secret", "secrets",
  "cookie", "cookies",
  "credential", "credentials",
  "apikey", "apikeys",
]);
const SAFE_METADATA_SUFFIXES = new Set(["count", "counts", "length"]);

function keyWords(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (SAFE_METADATA_SUFFIXES.has(words.at(-1) ?? "")) return false;
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
  return words.some((word, index) => word === "api" && ["key", "keys"].includes(words[index + 1] ?? ""));
}

export function containsSensitiveFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveFields(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => isSensitiveKey(key) || containsSensitiveFields(child));
}

export function scrubSecrets(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/Admin-Authorization["':\s]+[^\s,}]+/gi, "Admin-Authorization: [REDACTED]")
      .replace(/([?&](?:access[_-]?token|refresh[_-]?token|session[_-]?token|token|authorization)=)[^&#\s]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrubSecrets(child, childKey)]));
  return value;
}
