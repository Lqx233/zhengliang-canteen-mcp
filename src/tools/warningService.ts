import type { ToolContext } from "./shared.js";
import { apiRows, apiSucceeded } from "./shared.js";

export const WARNING_STATUSES = ["未办理", "待审核", "审核未通过", "审核通过"] as const;

export interface WarningActionInput {
  recordId: string;
  opinion: string;
  handler: string;
  handleDate: string;
}

export function warningCounts(list: any[]): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries(WARNING_STATUSES.map((status) => [status, 0]));
  for (const item of list) result[item.status ?? "未知"] = (result[item.status ?? "未知"] ?? 0) + 1;
  return result;
}

export function warningSummary(item: any) {
  return {
    id: item.id,
    warningType: item.warningType,
    warningOverview: item.warningOverview,
    status: item.status,
    date: item.date,
    canteenOpinion: item.canteenOpinion,
    canteenHandler: item.canteenHandler,
    canteenHandleDate: item.canteenHandleDate,
    cancelStatus: item.cancelStatus,
  };
}

export async function foodSafetyList(context: ToolContext, pageIndex = 1, pageSize = 200): Promise<any[]> {
  const response = await context.session.call("/basic/api/early/warning/list", { method: "POST", operation: "read", body: { pageIndex, pageSize } });
  if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Warning list query failed");
  return apiRows(response.json);
}

export async function findFoodSafetyWarning(context: ToolContext, id: string): Promise<any | null> {
  const pageSize = 200;
  for (let pageIndex = 1; pageIndex <= 100; pageIndex += 1) {
    const response = await context.session.call("/basic/api/early/warning/list", { method: "POST", operation: "read", body: { pageIndex, pageSize } });
    if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Warning list query failed");
    const rows = apiRows(response.json);
    const target = rows.find((item: any) => String(item.id) === id);
    if (target) return target;
    const total = Number(response.json?.data?.totalCount ?? response.json?.data?.total ?? 0);
    if (rows.length < pageSize || (total > 0 && pageIndex * pageSize >= total)) return null;
  }
  throw new Error("Warning lookup exceeded the safe pagination limit");
}

export async function submitFoodSafetyWarning(context: ToolContext, input: WarningActionInput) {
  return context.session.call("/basic/api/early/warning/opinion", {
    method: "POST",
    operation: "write",
    body: input,
  });
}

export function verifyWarningAction(target: any | null, input: WarningActionInput) {
  const checks = {
    found: Boolean(target),
    status: target?.status === "待审核",
    opinion: target?.canteenOpinion === input.opinion,
    handler: target?.canteenHandler === input.handler,
    handleDate: String(target?.canteenHandleDate ?? "").slice(0, 10) === input.handleDate,
  };
  return { passed: Object.values(checks).every(Boolean), checks, status: target?.status };
}
