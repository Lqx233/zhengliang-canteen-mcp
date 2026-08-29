import { z } from "zod";
import { containsSensitiveFields, isSensitiveKey } from "../redaction.js";
import type { ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok } from "./shared.js";

const STATUS_LABELS: Record<number, string> = {
  0: "草稿",
  1: "待确认",
  2: "待供应商确认",
  3: "供应商已确认",
  4: "待验收",
  5: "已完成",
  7: "退货",
};

function orderSummary(order: any) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    status: Number(order.status),
    statusLabel: STATUS_LABELS[Number(order.status)] ?? `未知(${order.status})`,
    enterpriseCode: order.enterpriseCode,
    enterpriseName: order.enterpriseName ?? order.supplierName,
    warehouseName: order.warehouseName,
    deliveryDate: order.deliveryDate,
    totalPrice: order.totalPrice ?? order.deliveryTotalPrice,
    ticketTotal: order.ticketTotal ?? 0,
  };
}

const RAW_READ_ENDPOINTS = new Map<string, Set<string>>([
  ["/auth/groups/getUserGroupAuth", new Set(["GET"])],
  ["/basic/supplyAdmin/getSupplierCustomerList", new Set(["GET"])],
  ["/supply/order/getOrder", new Set(["GET"])],
  ["/supply/order/getOrderList", new Set(["POST"])],
  ["/supply/goods/getGoodsList", new Set(["POST"])],
  ["/hygiene/api/staffInspection/getStaffInspectionLedgerRecord", new Set(["GET"])],
  ["/hygiene/api/fillInValue/getRecords", new Set(["GET"])],
  ["/hygiene/api/wasteDisposal", new Set(["GET"])],
]);

export const BASE_TOOLS: ToolDefinition[] = [
  {
    name: "login",
    effect: "local-write",
    description: "打开官方数字食堂登录页并安全保存当前会话；不会返回 token。",
    schema: { force: z.boolean().optional().default(false) },
    async handler(args, context) {
      await context.session.ensureToken(args.force === true);
      if (!await context.vault.load()) await context.wizard.open();
      return ok({ authenticated: true, profile: "default" });
    },
  },
  {
    name: "auth_status",
    effect: "read",
    description: "返回本机 MCP 认证状态，不暴露账号、学校或 token。",
    schema: {},
    async handler(_args, context) {
      return ok(await context.session.status());
    },
  },
  {
    name: "logout",
    effect: "local-destructive",
    description: "删除本机保存的登录 token。必须 confirm:true。",
    schema: { confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.confirm !== true) return ok({ action: "blocked", message: "Set confirm:true to delete the stored token." });
      await context.session.logout();
      return ok({ action: "logged_out" });
    },
  },
  {
    name: "open_profile_setup",
    effect: "local-write",
    description: "打开本机加密配置向导，确认采购、仓库和台账默认值。",
    schema: {},
    async handler(_args, context) {
      await context.session.ensureToken();
      const profile = await context.wizard.open();
      return ok({ configured: true, warehouseCount: profile.warehouses.length });
    },
  },
  {
    name: "list_suppliers",
    effect: "read",
    description: "实时查询当前账号可用的线上供应商。",
    schema: {},
    async handler(_args, context) {
      const suppliers = await context.discovery.suppliers();
      return ok({ count: suppliers.length, suppliers });
    },
  },
  {
    name: "list_warehouses",
    effect: "read",
    description: "实时查询仓库候选；收货人以本机已确认配置为准。",
    schema: {},
    async handler(_args, context) {
      const discovered = await context.discovery.warehouses();
      const profile = await context.vault.load();
      return ok({ discovered, configured: profile?.warehouses ?? [] });
    },
  },
  {
    name: "list_orders",
    effect: "read",
    description: "按状态和日期查询采购订单列表。",
    schema: {
      statusList: z.array(z.number().int()).min(1),
      pageIndex: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(200).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
    async handler(args, context) {
      const response = await context.session.call("/supply/order/getOrderList", {
        method: "POST",
        operation: "read",
        body: {
          pageIndex: args.pageIndex ?? 1,
          pageSize: args.pageSize ?? 30,
          statusList: args.statusList,
          orderGoodsType: 1,
          orderSource: 0,
          startTime: args.startDate,
          endTime: args.endDate,
        },
      });
      if (!apiSucceeded(response.json)) return err("Order list query failed", response.json?.info);
      const orders = apiRows(response.json).map(orderSummary);
      return ok({ orders, count: orders.length, total: response.json?.data?.totalCount ?? response.json?.data?.total ?? orders.length });
    },
  },
  {
    name: "order_counts",
    effect: "read",
    description: "查询各采购订单状态的实时计数。",
    schema: {},
    async handler(_args, context) {
      const response = await context.session.call("/supply/order/orderCountByStatus", { operation: "read" });
      if (!apiSucceeded(response.json)) return err("Order count query failed", response.json?.info);
      return ok({ counts: response.json?.data ?? response.json });
    },
  },
  {
    name: "query_goods",
    effect: "read",
    description: "按实时供应商编码、商品名和可选单位查询商品目录。",
    schema: {
      enterpriseCode: z.string().min(1),
      storeCode: z.string().optional(),
      name: z.string().min(1),
      unit: z.string().optional(),
    },
    async handler(args, context) {
      const response = await context.session.call("/supply/goods/getGoodsList", {
        method: "POST",
        operation: "read",
        body: { enterpriseCode: args.enterpriseCode, storeCode: args.storeCode ?? "000", name: args.name, pageIndex: 1, pageSize: 100 },
      });
      if (!apiSucceeded(response.json)) return err("Goods query failed", response.json?.info);
      const goods = apiRows(response.json).filter((item) => !args.unit || item.unit === args.unit).map((item) => ({
        code: item.code ?? item.goodsCode,
        name: item.name,
        unit: item.unit,
        specs: item.specs,
        price: item.price ?? item.originalPrice ?? item.currentPrice,
        categoryName: item.categoryName,
      }));
      return ok({ count: goods.length, goods });
    },
  },
  {
    name: "get_order",
    effect: "read",
    description: "按 orderCode 查询采购订单详情。",
    schema: { orderCode: z.string().min(1) },
    async handler(args, context) {
      const response = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(args.orderCode)}`, { operation: "read" });
      if (!apiSucceeded(response.json)) return err("Order detail query failed", response.json?.info);
      return ok(response.json?.data);
    },
  },
  {
    name: "verify_order",
    effect: "read",
    description: "按期望字段验收订单详情，只比较明确传入的字段。",
    schema: {
      orderCode: z.string().min(1),
      expect: z.object({
        status: z.number().optional(), supplier: z.string().optional(), warehouse: z.string().optional(), receiver: z.string().optional(),
        deliveryDate: z.string().optional(), remark: z.string().optional(), purpose: z.number().optional(),
        goods: z.array(z.object({ name: z.string(), unit: z.string(), amount: z.number() })).optional(),
      }),
    },
    async handler(args, context) {
      const response = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(args.orderCode)}`, { operation: "read" });
      const detail = response.json?.data;
      if (!apiSucceeded(response.json) || !detail) return err("Order detail query failed", response.json?.info);
      const checks: Record<string, boolean> = {};
      const expect = args.expect;
      if (expect.status !== undefined) checks.status = Number(detail.status) === expect.status;
      if (expect.supplier !== undefined) checks.supplier = detail.enterpriseCode === expect.supplier || detail.enterpriseName === expect.supplier;
      if (expect.warehouse !== undefined) checks.warehouse = detail.warehouseName === expect.warehouse;
      if (expect.receiver !== undefined) checks.receiver = detail.receiver === expect.receiver;
      if (expect.deliveryDate !== undefined) checks.deliveryDate = String(detail.deliveryDate).replace("T", " ").slice(0, 19) === expect.deliveryDate;
      if (expect.remark !== undefined) checks.remark = detail.remark === expect.remark;
      if (expect.purpose !== undefined) checks.purpose = Number(detail.purpose) === expect.purpose;
      if (expect.goods) checks.goods = expect.goods.every((wanted: any) => (detail.orderGoodsList ?? []).some((actual: any) => actual.name === wanted.name && actual.unit === wanted.unit && Number(actual.amount) === wanted.amount));
      return ok({ passed: Object.values(checks).every(Boolean), checks, orderCode: args.orderCode });
    },
  },
  {
    name: "raw_request",
    effect: "read",
    description: "调用严格白名单内的只读接口；未知或写入接口会拒绝。",
    schema: { path: z.string().min(1), method: z.enum(["GET", "POST"]).optional(), body: z.unknown().optional() },
    async handler(args, context) {
      const parsed = new URL(args.path, "https://local.invalid");
      const method = args.method ?? "GET";
      const allowed = RAW_READ_ENDPOINTS.get(parsed.pathname);
      if (!allowed?.has(method)) return err("Endpoint is not in the read-only allowlist");
      if ([...parsed.searchParams.keys()].some((key) => isSensitiveKey(key))) return err("Sensitive values are not allowed in raw_request query parameters");
      if (containsSensitiveFields(args.body)) return err("Sensitive values are not allowed in raw_request bodies");
      const response = await context.session.call(`${parsed.pathname}${parsed.search}`, { method, body: args.body, operation: "read" });
      return ok({ httpStatus: response.httpStatus, data: response.json });
    },
  },
];
