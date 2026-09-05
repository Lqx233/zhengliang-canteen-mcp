import type { ToolContext } from "./tools/shared.js";

export type CapabilityKind = "read" | "write";

export interface Capability {
  id: string;
  category: string;
  label: string;
  kind: CapabilityKind;
  method: "GET" | "POST";
  path: string;
  risk: "low" | "medium" | "high";
  description: string;
  execution?: "dedicated" | "confirmable";
  verificationPath?: string;
}

/**
 * A deliberately small, reviewed surface over the much larger web client.
 * Additions must be based on a captured frontend contract and must not include
 * tenant data, credentials, or example API responses.
 */
export const CAPABILITIES: readonly Capability[] = [
  { id: "suppliers", category: "basic", label: "线上供应商", kind: "read", method: "GET", path: "/basic/supplyAdmin/getSupplierCustomerList", risk: "low", description: "List active online suppliers visible to the account." },
  { id: "warehouses", category: "basic", label: "仓库", kind: "read", method: "POST", path: "/supply/warehouseDisplay/getUserWarehouse", risk: "low", description: "List warehouses visible to the account." },
  { id: "orders", category: "procurement", label: "线上采购订单", kind: "read", method: "POST", path: "/supply/order/getOrderList", risk: "low", description: "Search online procurement orders." },
  { id: "order", category: "procurement", label: "采购订单详情", kind: "read", method: "GET", path: "/supply/order/getOrder", risk: "low", description: "Read one order by orderCode." },
  { id: "order_counts", category: "procurement", label: "采购订单计数", kind: "read", method: "GET", path: "/supply/order/orderCountByStatus", risk: "low", description: "Read order counts grouped by status." },
  { id: "online_goods", category: "procurement", label: "在线商品", kind: "read", method: "POST", path: "/supply/goods/getGoodsList", risk: "low", description: "Search the live online goods catalogue." },
  { id: "food_sample_records", category: "ledger", label: "食品留样", kind: "read", method: "GET", path: "/hygiene/api/foodSample/getFoodSampleLedgerRecordList", risk: "low", description: "Read food-sample ledger records." },
  { id: "accompanying_meal_records", category: "ledger", label: "陪餐评价", kind: "read", method: "GET", path: "/hygiene/api/accompanyMeal/getAccompanyLedgerRecordList", risk: "low", description: "Read accompanying-meal ledger records." },
  { id: "tableware_records", category: "ledger", label: "餐具消毒", kind: "read", method: "GET", path: "/hygiene/api/fillInValue/getLedgerValueRecordList", risk: "low", description: "Read configurable ledger records such as tableware disinfection." },
  { id: "morning_check_records", category: "ledger", label: "人员晨检", kind: "read", method: "GET", path: "/hygiene/api/staffInspection/getStaffInspectionLedgerRecordList", risk: "low", description: "Read morning staff-check records." },
  { id: "device_disinfection_records", category: "ledger", label: "设备清洗消毒", kind: "read", method: "GET", path: "/hygiene/api/fillInValue/getLedgerValueRecordList", risk: "low", description: "Read device-disinfection records." },
  { id: "waste_records", category: "ledger", label: "废弃物处置", kind: "read", method: "GET", path: "/hygiene/api/wasteDisposalLedgerRecord", risk: "low", description: "Read waste-disposal records." },
  { id: "diet_committee", category: "basic", label: "膳食委员会", kind: "read", method: "POST", path: "/basic/dietCommittee/selDietCommitteeForSchool", risk: "low", description: "Read diet committee terms and members." },
  { id: "parent_committee", category: "basic", label: "家长监督委员会", kind: "read", method: "GET", path: "/basic/parentsOversightCommittee/getCommitteePageList", risk: "low", description: "Read parent oversight committee terms." },
  { id: "food_safety_warnings", category: "food_safety", label: "食安预警", kind: "read", method: "POST", path: "/basic/api/early/warning/list", risk: "low", description: "Read food-safety warnings visible to the account." },
  { id: "price_warnings", category: "food_safety", label: "价格预警", kind: "read", method: "GET", path: "/supply/ew/highPrice/warning/home/list", risk: "low", description: "Read price warnings when the account has permission." },
  { id: "week_report", category: "food_safety", label: "工作周报", kind: "read", method: "GET", path: "/basic/api/weekReport/canteen/detail", risk: "low", description: "Read the canteen weekly report." },
  { id: "canteen_info", category: "basic", label: "食堂信息", kind: "read", method: "POST", path: "/basic/canteen/querySelfInfo", risk: "low", description: "Read the current canteen profile." },
  { id: "employees", category: "basic", label: "从业人员", kind: "read", method: "POST", path: "/basic/canteenEmployee/queryEmployeeInfoByCriterias", risk: "low", description: "Read visible canteen employee records." },
  { id: "recipe_summary", category: "recipe", label: "食谱概览", kind: "read", method: "GET", path: "/basic/edu/dataDashboard/queryRecipeSummary", risk: "low", description: "Read recipe summary data." },
  { id: "meal_dates", category: "recipe", label: "开餐日期", kind: "read", method: "GET", path: "/basic/api/semester/meal-date-setting", risk: "low", description: "Read configured meal dates." },
  { id: "purchase_statistics", category: "statistics", label: "采购统计", kind: "read", method: "POST", path: "/basic/api/municipal/supplierInfo", risk: "low", description: "Read supplier-facing statistics exposed to the account." },
  { id: "ledger_config", category: "ledger", label: "台账配置", kind: "read", method: "GET", path: "/hygiene/api/ledger/getLedgerConfig", risk: "low", description: "Read ledger configuration and enabled record types." },
  { id: "safety_ledger", category: "food_safety", label: "安全台账", kind: "read", method: "GET", path: "/hygiene/api/ledger/getLedgerStatisticsList", risk: "low", description: "Read safety-ledger completion statistics." },
  { id: "recipe_meal_count", category: "recipe", label: "供餐统计", kind: "read", method: "GET", path: "/basic/edu/dataDashboard/queryRecipeTermMealCount", risk: "low", description: "Read recipe meal-count summary." },
  { id: "recipe_purchase_plan", category: "recipe", label: "食谱采购计划", kind: "read", method: "POST", path: "/supply/purchasePlan/selFoodNameAndCategoryByRecipeNew", risk: "low", description: "Read ingredients derived from published recipes." },
  { id: "godown_records", category: "procurement", label: "入库记录", kind: "read", method: "POST", path: "/supply/godown/queryInfoByCriteriasForCanteen", risk: "low", description: "Read offline purchase and godown records." },
  { id: "outstock_records", category: "procurement", label: "出库记录", kind: "read", method: "POST", path: "/supply/outStockRecord/queryAllOutStockRecord", risk: "low", description: "Read ingredient out-stock records." },
  { id: "inventory_statistics", category: "statistics", label: "库存统计", kind: "read", method: "POST", path: "/supply/api/inventory/stat", risk: "low", description: "Read inventory statistics." },
  { id: "meal_income", category: "finance", label: "餐费收入", kind: "read", method: "GET", path: "/supply/api/cost/meal/income/list-by-month", risk: "low", description: "Read monthly meal-income records." },
  { id: "cost_publicity", category: "finance", label: "成本公示", kind: "read", method: "POST", path: "/supply/api/cost/account/publicity", risk: "low", description: "Read cost-accounting publicity data." },
  { id: "settlement", category: "finance", label: "结算对账", kind: "read", method: "GET", path: "/supply/edu/dataDashboard/settlePayment", risk: "low", description: "Read settlement summary visible to the account." },
  { id: "food_safety_risk", category: "food_safety", label: "食品安全风险", kind: "read", method: "GET", path: "/basic/riskScore/canteenFoodSafetyRisk", risk: "low", description: "Read current food-safety risk score." },
  { id: "notices", category: "system", label: "通知公告", kind: "read", method: "POST", path: "/basic/notice/queryMoreNotices", risk: "low", description: "Read notices visible to the account." },
  { id: "todo_reminders", category: "system", label: "待办提醒", kind: "read", method: "POST", path: "/basic/todoReminders/getTodoRemindersList", risk: "low", description: "Read outstanding official-site reminders." },
  { id: "documents", category: "documents", label: "数字档案", kind: "read", method: "GET", path: "/hygiene/api/dataLooK/getDataDownload", risk: "low", description: "Read available official archive metadata; downloads remain explicit." },
  { id: "superior_work", category: "superior", label: "上级工作", kind: "read", method: "GET", path: "/basic/api/se/course/record/list", risk: "low", description: "Read assigned superior-work records when permitted." },
  { id: "bidding_projects", category: "bidding", label: "竞价项目", kind: "read", method: "POST", path: "/supply/api/purchase/bidding/page", risk: "low", description: "Read bidding projects visible to the canteen account." },
  { id: "external_links", category: "external", label: "外部系统入口", kind: "read", method: "GET", path: "/basic/externalSystemManagement/getLink/binding/screenList", risk: "low", description: "List configured external-system links without opening or operating them." },
  { id: "auth_status_api", category: "auth", label: "账号权限", kind: "read", method: "GET", path: "/auth/groups/getUserGroupAuth", risk: "low", description: "Validate the current session and read permission metadata." },
  { id: "save_order_draft", category: "procurement", label: "保存采购草稿", kind: "write", method: "POST", path: "/supply/order/saveOrder", risk: "medium", execution: "dedicated", description: "Create a draft through save_order, which performs catalogue and duplicate checks.", verificationPath: "/supply/order/getOrder" },
  { id: "save_morning_check", category: "ledger", label: "保存人员晨检", kind: "write", method: "POST", path: "/hygiene/api/staffInspection/saveStaffInspectionRecord", risk: "high", execution: "dedicated", description: "Create through save_morning_check, which uses a checked template.", verificationPath: "/hygiene/api/staffInspection/getStaffInspectionLedgerRecord" },
  { id: "save_device_disinfection", category: "ledger", label: "保存设备消毒", kind: "write", method: "POST", path: "/hygiene/api/fillInValue/saveRecords", risk: "high", execution: "dedicated", description: "Create through save_device_disinfection, which uses a checked template.", verificationPath: "/hygiene/api/fillInValue/getRecords" },
  { id: "save_waste_disposal", category: "ledger", label: "保存废弃物处置", kind: "write", method: "POST", path: "/hygiene/api/wasteDisposal", risk: "high", execution: "dedicated", description: "Create through save_waste_disposal, which enforces configured defaults and checks existing state.", verificationPath: "/hygiene/api/wasteDisposal" },
  { id: "handle_food_safety_warning", category: "food_safety", label: "办理食安预警", kind: "write", method: "POST", path: "/basic/api/early/warning/opinion", risk: "high", execution: "confirmable", description: "Handle one unprocessed food-safety warning after a one-time preview.", verificationPath: "/basic/api/early/warning/list" },
];

const byId = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));

export function getCapability(id: string): Capability {
  const capability = byId.get(id);
  if (!capability) throw new Error("Unknown capability");
  return capability;
}

export function capabilitySummary(): Array<Omit<Capability, "path" | "verificationPath">> {
  return CAPABILITIES.map(({ path: _path, verificationPath: _verificationPath, ...summary }) => summary);
}

export function buildCapabilityPath(capability: Capability, query: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) params.set(key, value.join(","));
    else if (typeof value === "object") params.set(key, JSON.stringify(value));
    else params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${capability.path}?${queryString}` : capability.path;
}

export async function callCapability(context: ToolContext, capability: Capability, input: { query?: Record<string, unknown>; body?: unknown; expectedAuthRevision?: number }): Promise<any> {
  return context.session.call(buildCapabilityPath(capability, capability.method === "GET" ? input.query : {}), {
    method: capability.method,
    body: capability.method === "POST" ? input.body : undefined,
    operation: capability.kind,
    expectedAuthRevision: input.expectedAuthRevision,
  });
}
