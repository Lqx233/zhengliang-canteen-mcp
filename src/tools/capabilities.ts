import crypto from "node:crypto";
import { z } from "zod";
import { callCapability, capabilitySummary, getCapability, type Capability } from "../capabilities.js";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiSucceeded, err, ok, sleep } from "./shared.js";
import { findFoodSafetyWarning, verifyWarningAction, type WarningActionInput } from "./warningService.js";

interface PreparedAction {
  revision: number;
  capabilityId: string;
  body: unknown;
  snapshot: Record<string, unknown>;
  expiresAt: number;
}

interface ActionAdapter {
  schema: z.ZodType;
  inspect(context: ToolContext, body: any): Promise<Record<string, unknown>>;
  revalidate(context: ToolContext, body: any, snapshot: Record<string, unknown>): Promise<void>;
  verify(context: ToolContext, body: any): Promise<Record<string, unknown>>;
}

let preparedBySession = new WeakMap<ToolContext["session"], Map<string, PreparedAction>>();
function actionsFor(context: ToolContext): Map<string, PreparedAction> {
  let actions = preparedBySession.get(context.session);
  if (!actions) { actions = new Map(); preparedBySession.set(context.session, actions); }
  return actions;
}
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
let actionNow = () => Date.now();
let actionWait = sleep;
const pageIndex = z.number().int().positive().optional();
const pageSize = z.number().int().positive().max(200).optional();
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const optionalScalar = scalar.optional();
const date = z.string().min(1).max(40).optional();
const page = { pageIndex, pageSize };
const strict = (shape: z.ZodRawShape = {}) => z.object(shape).strict();

const READ_INPUT_SCHEMAS: Record<string, z.ZodObject<any>> = {
  suppliers: strict({ ...page, isSemester: optionalScalar, status: optionalScalar, type: optionalScalar }),
  warehouses: strict(),
  orders: strict({ ...page, statusList: z.array(scalar).max(50).optional(), orderGoodsType: optionalScalar, orderSource: optionalScalar, startTime: date, endTime: date, stallQuery: optionalScalar }),
  order: strict({ orderCode: z.string().min(1) }),
  order_counts: strict(),
  online_goods: strict({ ...page, enterpriseCode: z.string().min(1).optional(), storeCode: z.string().min(1).optional(), name: z.string().max(200).optional() }),
  food_sample_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date }),
  accompanying_meal_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date }),
  tableware_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date, stallId: optionalScalar }),
  morning_check_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date }),
  device_disinfection_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date, stallId: optionalScalar }),
  waste_records: strict({ ...page, ledgerName: z.string().max(100).optional(), startTime: date, endTime: date, date }),
  diet_committee: strict({ ...page, committeeName: z.string().max(100).optional() }),
  parent_committee: strict({ ...page, committeeName: z.string().max(100).optional() }),
  food_safety_warnings: strict({ ...page, status: optionalScalar }),
  price_warnings: strict({ ...page, status: optionalScalar }),
  week_report: strict({ date, startDate: date, endDate: date }),
  canteen_info: strict(),
  employees: strict({ ...page, name: z.string().max(100).optional(), status: optionalScalar }),
  recipe_summary: strict({ startDate: date, endDate: date, semester: z.string().max(100).optional() }),
  meal_dates: strict({ semester: z.string().max(100).optional(), year: optionalScalar }),
  purchase_statistics: strict({ ...page, startDate: date, endDate: date }),
  auth_status_api: strict(),
  ledger_config: strict({ ledgerName: z.string().max(100).optional(), ledgerNo: z.string().max(100).optional(), stallId: optionalScalar }),
  safety_ledger: strict({ ...page, startTime: date, endTime: date, ledgerName: z.string().max(100).optional() }),
  recipe_meal_count: strict({ startDate: date, endDate: date, semester: z.string().max(100).optional() }),
  recipe_purchase_plan: strict({ ...page, date, startDate: date, endDate: date, recipeDate: date }),
  godown_records: strict({ ...page, startTime: date, endTime: date, startDate: date, endDate: date, supplierId: optionalScalar, status: optionalScalar }),
  outstock_records: strict({ ...page, startTime: date, endTime: date, startDate: date, endDate: date, status: optionalScalar }),
  inventory_statistics: strict({ ...page, startDate: date, endDate: date, warehouseId: optionalScalar, categoryId: optionalScalar }),
  meal_income: strict({ ...page, year: optionalScalar, month: optionalScalar, startDate: date, endDate: date }),
  cost_publicity: strict({ ...page, year: optionalScalar, month: optionalScalar, startDate: date, endDate: date }),
  settlement: strict({ ...page, date, startDate: date, endDate: date }),
  food_safety_risk: strict({ date, startDate: date, endDate: date }),
  notices: strict({ ...page, startTime: date, endTime: date }),
  todo_reminders: strict(page),
  documents: strict({ ...page, date, startDate: date, endDate: date }),
  superior_work: strict({ ...page, startDate: date, endDate: date, semester: z.string().max(100).optional() }),
  bidding_projects: strict({ ...page, startDate: date, endDate: date, status: optionalScalar, name: z.string().max(200).optional() }),
  external_links: strict(),
};

for (const capability of capabilitySummary()) {
  if (capability.kind === "read" && !READ_INPUT_SCHEMAS[capability.id]) throw new Error(`Missing input schema for read capability ${capability.id}`);
}

const warningActionSchema = z.object({
  recordId: z.string().min(1),
  opinion: z.string().min(1),
  handler: z.string().min(1),
  handleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const ACTION_ADAPTERS: Record<string, ActionAdapter> = {
  handle_food_safety_warning: {
    schema: warningActionSchema,
    async inspect(context, body: WarningActionInput) {
      const target = await findFoodSafetyWarning(context, body.recordId);
      if (!target) throw new Error("Warning record was not found");
      if (target.status !== "未办理") throw new Error(`Warning status is ${target.status}; only 未办理 can be handled`);
      return { recordId: String(target.id), status: target.status };
    },
    async revalidate(context, body: WarningActionInput, snapshot) {
      const target = await findFoodSafetyWarning(context, body.recordId);
      if (!target) throw new Error("Warning record disappeared after preparation; prepare the action again");
      if (target.status !== snapshot.status || target.status !== "未办理") throw new Error("Warning state changed after preparation; prepare the action again");
    },
    async verify(context, body: WarningActionInput) {
      let verification: ReturnType<typeof verifyWarningAction> = verifyWarningAction(null, body);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const target = await findFoodSafetyWarning(context, body.recordId);
        verification = verifyWarningAction(target, body);
        if (verification.passed) break;
        if (attempt < 2) await actionWait(1200 + attempt * 600);
      }
      return verification;
    },
  },
};

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function prune(prepared: Map<string, PreparedAction>): void {
  const now = actionNow();
  for (const [id, item] of prepared) if (item.expiresAt <= now) prepared.delete(id);
}

function resolveCapability(id: string): Capability | null {
  try { return getCapability(id); } catch { return null; }
}

export const CAPABILITY_TOOLS: ToolDefinition[] = [
  {
    name: "list_capabilities",
    effect: "read",
    description: "列出当前 MCP 已审计的官方主站能力、读写等级和风险级别，不返回租户数据。",
    schema: { category: z.string().optional(), kind: z.enum(["read", "write"]).optional() },
    async handler(args) {
      const capabilities = capabilitySummary().filter((item) => (!args.category || item.category === args.category) && (!args.kind || item.kind === args.kind));
      return ok({ count: capabilities.length, capabilities });
    },
  },
  {
    name: "query_capability",
    effect: "read",
    description: "按已审计能力 ID 查询官方主站数据；只允许 registry 中的 read 能力，自动使用当前会话。",
    schema: { capabilityId: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() },
    async handler(args, context) {
      const capability = resolveCapability(args.capabilityId);
      if (!capability) return err("Unknown capability");
      if (capability.kind !== "read") return err("Only read capabilities can be queried");
      const parsed = READ_INPUT_SCHEMAS[capability.id]?.safeParse(args.params ?? {});
      if (!parsed?.success) return err("Capability input validation failed", parsed?.error.issues ?? []);
      const response = await callCapability(context, capability, { query: capability.method === "GET" ? parsed.data : undefined, body: capability.method === "POST" ? parsed.data : undefined });
      const hasBusinessResult = response.json?.status !== undefined || response.json?.success !== undefined;
      if (response.httpStatus >= 400 || (hasBusinessResult && !apiSucceeded(response.json))) return err("Capability query failed", { httpStatus: response.httpStatus, status: response.json?.status, info: response.json?.info });
      return ok({ capabilityId: capability.id, httpStatus: response.httpStatus, data: response.json?.data ?? response.json });
    },
  },
  {
    name: "prepare_action",
    effect: "preview",
    description: "读取并锁定已审计写能力的当前状态，生成一次性确认句柄；不会执行网络写入。",
    schema: { capabilityId: z.string().min(1), body: z.unknown() },
    async handler(args, context) {
      const prepared = actionsFor(context);
      prune(prepared);
      const capability = resolveCapability(args.capabilityId);
      if (!capability) return err("Unknown capability");
      if (capability.kind !== "write") return err("Only write capabilities require an action confirmation");
      if (capability.execution !== "confirmable") return err("This capability must use its dedicated safety-checked tool");
      const adapter = ACTION_ADAPTERS[capability.id];
      if (!adapter) return err("This write capability has no registered safety adapter");
      const parsed = adapter.schema.safeParse(args.body);
      if (!parsed.success) return err("Action input validation failed", parsed.error.issues);
      try {
        await context.session.ensureToken();
        const revision = context.session.revision;
        const body = structuredClone(parsed.data);
        const snapshot = structuredClone(await adapter.inspect(context, body));
        context.session.assertRevision(revision);
        const confirmationId = crypto.randomBytes(18).toString("base64url");
        prepared.set(confirmationId, { revision, capabilityId: capability.id, body, snapshot, expiresAt: actionNow() + CONFIRMATION_TTL_MS });
        return ok({ status: "prepared", confirmationId, expiresInSeconds: CONFIRMATION_TTL_MS / 1000, capability: { id: capability.id, label: capability.label, risk: capability.risk, method: capability.method }, actionPreview: body, precondition: snapshot, payloadDigest: digest(body), preconditionDigest: digest(snapshot) });
      } catch (error: any) {
        return err(error?.message ?? "Action preparation failed");
      }
    },
  },
  {
    name: "execute_action",
    effect: "remote-write",
    description: "消费一次性确认句柄；执行前重验状态，写入后严格回查。要求 confirm:true。",
    schema: { confirmationId: z.string().min(1), confirm: z.boolean().default(false) },
    async handler(args, context) {
      const prepared = actionsFor(context);
      prune(prepared);
      if (args.confirm !== true) return ok({ status: "blocked", message: "Set confirm:true to execute the prepared action." });
      const action = prepared.get(args.confirmationId);
      if (!action) return err("Confirmation is missing, expired, or already consumed");
      prepared.delete(args.confirmationId);
      const capability = resolveCapability(action.capabilityId);
      const adapter = ACTION_ADAPTERS[action.capabilityId];
      if (!capability || !adapter || capability.kind !== "write" || capability.execution !== "confirmable") return err("Prepared capability is no longer executable");
      try {
        context.session.assertRevision(action.revision);
        await adapter.revalidate(context, action.body, action.snapshot);
        context.session.assertRevision(action.revision);
      } catch (error: any) {
        return err(error?.message ?? "Prepared action precondition failed");
      }
      const response = await callCapability(context, capability, { body: action.body, expectedAuthRevision: action.revision });
      if (response.httpStatus >= 400 || !apiSucceeded(response.json)) return err("Prepared action failed", { httpStatus: response.httpStatus, status: response.json?.status, info: response.json?.info });
      try {
        const verification = await adapter.verify(context, action.body);
        if (verification.passed !== true) return err("Action was accepted but verification failed", { capabilityId: capability.id, writeAccepted: true, payloadDigest: digest(action.body), verification });
        return ok({ status: "executed", capabilityId: capability.id, payloadDigest: digest(action.body), verification });
      } catch (error: any) {
        return err("Action was accepted but verification could not be completed", { capabilityId: capability.id, writeAccepted: true, payloadDigest: digest(action.body), reason: error?.message ?? "Verification failed" });
      }
    },
  },
];

export function clearPreparedActionsForTests(): void {
  preparedBySession = new WeakMap();
  actionNow = () => Date.now();
  actionWait = sleep;
}

export function setPreparedActionTestHooks(hooks: { now?: () => number; wait?: (milliseconds: number) => Promise<void> }): void {
  if (hooks.now) actionNow = hooks.now;
  if (hooks.wait) actionWait = hooks.wait;
}
