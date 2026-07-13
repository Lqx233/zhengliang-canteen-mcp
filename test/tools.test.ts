import assert from "node:assert/strict";
import test from "node:test";
import { ALL_TOOLS } from "../src/server.js";
import { staffTemperature, staffTime } from "../src/tools/ledger.js";
import { PURCHASE_TOOLS } from "../src/tools/purchase.js";

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
  assert.equal(ALL_TOOLS.length, 28);
});

test("merge_items combines identical labels and units", async () => {
  const tool = PURCHASE_TOOLS.find((item) => item.name === "merge_items")!;
  const result = await tool.handler({ items: [["Synthetic Item", 2, "unit"], ["Synthetic Item", 3, "unit"]] }, {} as any);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].saveAmount, 5);
});

test("generated morning values remain in configured ranges", () => {
  const temperatures = Array.from({ length: 50 }, (_, index) => Number(staffTemperature(index)));
  assert.equal(temperatures.every((value) => value >= 36.2 && value <= 37.1), true);
  const times = Array.from({ length: 30 }, (_, index) => staffTime(index, 30));
  assert.equal(times.every((value) => value >= "05:30:00" && value < "06:00:00"), true);
});
