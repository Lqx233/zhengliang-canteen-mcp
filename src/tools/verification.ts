// Compare only fields deliberately sent by a tool, but never accept missing fields.
export function matchesFields(actual: any, expected: any): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  if (expected === null || actual === null) return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && sameRecords(actual, expected);
  }
  if (typeof expected === "object") {
    return actual !== null && typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => matchesFields(actual[key], value));
  }
  if (typeof expected === "number") return (typeof actual === "number" || (typeof actual === "string" && actual.trim() !== "")) && Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) < 0.0001;
  return String(actual) === String(expected);
}

export function sameRecords(actual: any[], expected: any[]): boolean {
  if (actual.length !== expected.length) return false;
  const unmatched = [...actual];
  return expected.every((wanted) => {
    const index = unmatched.findIndex((row) => matchesFields(row, wanted));
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
}
