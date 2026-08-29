import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok, sleep, today } from "./shared.js";
import { findFoodSafetyWarning, foodSafetyList, submitFoodSafetyWarning, verifyWarningAction, warningCounts, warningSummary } from "./warningService.js";

export const WARNING_TOOLS: ToolDefinition[] = [
  {
    name: "list_warnings",
    effect: "read",
    description: "查询食安预警或当前账号可见的价格预警，并按状态计数。",
    schema: { kind: z.enum(["food_safety", "price"]), status: z.string().optional(), pageIndex: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional() },
    async handler(args, context) {
      let list: any[];
      if (args.kind === "food_safety") {
        list = await foodSafetyList(context, args.pageIndex ?? 1, args.pageSize ?? 50);
      } else {
        const response = await context.session.call(`/supply/ew/highPrice/warning/home/list?pageIndex=${args.pageIndex ?? 1}&pageSize=${args.pageSize ?? 50}`, { operation: "read" });
        if (String(response.json?.status) === "534") return ok({ kind: "price", count: 0, list: [], counts: warningCounts([]), note: "The current account does not have price-warning permission." });
        list = Array.isArray(response.json?.data) ? response.json.data : apiRows(response.json);
      }
      const filtered = args.status ? list.filter((item) => item.status === args.status) : list;
      return ok({ kind: args.kind, counts: warningCounts(list), count: filtered.length, list: filtered.map(warningSummary) });
    },
  },
  {
    name: "handle_warning",
    effect: "remote-write",
    description: "办理一条未办理食安预警；必须 confirm:true，办理后回查状态和计数。",
    schema: { kind: z.enum(["food_safety", "price"]), id: z.string().min(1), handler: z.string().min(1), note: z.string().min(1), handleDate: z.string().optional(), attachment: z.string().optional(), confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.confirm !== true) return ok({ action: "dry_run", preview: { kind: args.kind, id: args.id, handler: args.handler, note: args.note, handleDate: args.handleDate ?? today() } });
      if (args.kind === "price") return err("Price-warning handling requires a regulator workflow and is not enabled in this package");
      const before = await foodSafetyList(context);
      const target = await findFoodSafetyWarning(context, args.id);
      if (!target) return err("Warning record was not found");
      if (target.status !== "未办理") return err(`Warning status is ${target.status}; only 未办理 can be handled`);
      const beforeCounts = warningCounts(before);
      const input = { recordId: args.id, opinion: args.note, handler: args.handler, handleDate: args.handleDate ?? today() };
      const saved = await submitFoodSafetyWarning(context, input);
      if (!apiSucceeded(saved.json)) return err("Warning handling failed", saved.json?.info);
      await sleep(1800);
      const after = await foodSafetyList(context);
      const afterTarget = await findFoodSafetyWarning(context, args.id);
      const afterCounts = warningCounts(after);
      const verification = verifyWarningAction(afterTarget, input);
      if (!verification.passed) return err("Warning write was accepted but verification failed", { writeAccepted: true, verification, beforeStatus: target.status, beforeCounts, afterCounts });
      return ok({ handled: true, id: args.id, verification: { ...verification, beforeStatus: target.status, beforeCounts, afterCounts } });
    },
  },
];
