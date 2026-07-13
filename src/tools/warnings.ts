import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok, sleep, today } from "./shared.js";

const STATUSES = ["未办理", "待审核", "审核未通过", "审核通过"];

async function foodSafetyList(context: ToolContext, pageIndex = 1, pageSize = 200): Promise<any[]> {
  const response = await context.session.call("/basic/api/early/warning/list", { method: "POST", operation: "read", body: { pageIndex, pageSize } });
  if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Warning list query failed");
  return apiRows(response.json);
}

function counts(list: any[]): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of list) result[item.status ?? "未知"] = (result[item.status ?? "未知"] ?? 0) + 1;
  return result;
}

function summary(item: any) {
  return {
    id: item.id, warningType: item.warningType, warningOverview: item.warningOverview, status: item.status, date: item.date,
    canteenOpinion: item.canteenOpinion, canteenHandler: item.canteenHandler, canteenHandleDate: item.canteenHandleDate, cancelStatus: item.cancelStatus,
  };
}

export const WARNING_TOOLS: ToolDefinition[] = [
  {
    name: "list_warnings",
    description: "查询食安预警或当前账号可见的价格预警，并按状态计数。",
    schema: { kind: z.enum(["food_safety", "price"]), status: z.string().optional(), pageIndex: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional() },
    async handler(args, context) {
      let list: any[];
      if (args.kind === "food_safety") {
        list = await foodSafetyList(context, args.pageIndex ?? 1, args.pageSize ?? 50);
      } else {
        const response = await context.session.call(`/supply/ew/highPrice/warning/home/list?pageIndex=${args.pageIndex ?? 1}&pageSize=${args.pageSize ?? 50}`, { operation: "read" });
        if (String(response.json?.status) === "534") return ok({ kind: "price", count: 0, list: [], counts: counts([]), note: "The current account does not have price-warning permission." });
        list = Array.isArray(response.json?.data) ? response.json.data : apiRows(response.json);
      }
      const filtered = args.status ? list.filter((item) => item.status === args.status) : list;
      return ok({ kind: args.kind, counts: counts(list), count: filtered.length, list: filtered.map(summary) });
    },
  },
  {
    name: "handle_warning",
    description: "办理一条未办理食安预警；必须 confirm:true，办理后回查状态和计数。",
    schema: { kind: z.enum(["food_safety", "price"]), id: z.string().min(1), handler: z.string().min(1), note: z.string().min(1), handleDate: z.string().optional(), attachment: z.string().optional(), confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.confirm !== true) return ok({ action: "dry_run", preview: { kind: args.kind, id: args.id, handler: args.handler, note: args.note, handleDate: args.handleDate ?? today() } });
      if (args.kind === "price") return err("Price-warning handling requires a regulator workflow and is not enabled in this package");
      const before = await foodSafetyList(context);
      const target = before.find((item) => item.id === args.id);
      if (!target) return err("Warning record was not found");
      if (target.status !== "未办理") return err(`Warning status is ${target.status}; only 未办理 can be handled`);
      const beforeCounts = counts(before);
      const saved = await context.session.call("/basic/api/early/warning/opinion", {
        method: "POST", operation: "write", body: { recordId: args.id, opinion: args.note, handler: args.handler, handleDate: args.handleDate ?? today() },
      });
      if (!apiSucceeded(saved.json)) return err("Warning handling failed", saved.json?.info);
      await sleep(1800);
      const after = await foodSafetyList(context);
      const afterTarget = after.find((item) => item.id === args.id);
      const afterCounts = counts(after);
      const passed = afterTarget?.status === "待审核" && Number(afterCounts["未办理"] ?? 0) === Number(beforeCounts["未办理"] ?? 0) - 1;
      return ok({ handled: true, id: args.id, verification: { passed, beforeStatus: target.status, afterStatus: afterTarget?.status, beforeCounts, afterCounts } });
    },
  },
];
