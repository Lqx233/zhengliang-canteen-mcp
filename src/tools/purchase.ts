import { z } from "zod";
import { findWarehouse } from "../config/profile.js";
import type { SupplierInfo, TenantProfile } from "../types.js";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok, requireProfile, sleep } from "./shared.js";

const confirmedGoodsSchema = z.object({ code: z.string().min(1), name: z.string().min(1), unit: z.string().min(1) });
const itemOptionsSchema = z.object({
  saveAmount: z.number().positive().optional(),
  saveUnit: z.string().min(1).optional(),
  conversion: z.string().optional(),
  priceOverride: z.number().positive().optional(),
  modelSuggestions: z.array(z.string().min(1)).max(3).optional(),
  confirmedGoods: confirmedGoodsSchema.optional(),
  rememberAlias: z.boolean().optional(),
}).strict();
const itemSchema = z.union([
  z.tuple([z.string().min(1), z.number().positive(), z.string().min(1)]),
  z.tuple([z.string().min(1), z.number().positive(), z.string().min(1), itemOptionsSchema]),
]);
const supplierShape = {
  enterpriseCode: z.string().optional(),
  supplierName: z.string().optional(),
};
const priceSheetSchema = z.object({
  asOf: z.string(),
  entries: z.array(z.object({
    enterpriseCode: z.string(), goodsCode: z.string().optional(), goodsName: z.string(), unit: z.string(), referencePrice: z.number().positive(),
  })),
}).optional();

type InputItem = z.infer<typeof itemSchema>;

function priceOf(goods: any): number | null {
  const price = Number(goods.price ?? goods.originalPrice ?? goods.currentPrice ?? goods.unitPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function resolveSupplier(context: ToolContext, ref: any): Promise<SupplierInfo> {
  if (!ref.enterpriseCode && !ref.supplierName) throw new Error("enterpriseCode or supplierName is required");
  const suppliers = await context.discovery.suppliers();
  const matches = suppliers.filter((supplier) =>
    (!ref.enterpriseCode || supplier.enterpriseCode === ref.enterpriseCode) &&
    (!ref.supplierName || supplier.enterpriseName === ref.supplierName));
  if (matches.length !== 1) throw new Error(`Supplier resolution expected one active match, received ${matches.length}`);
  return matches[0]!;
}

async function queryCatalog(context: ToolContext, supplier: SupplierInfo, name: string): Promise<any[]> {
  const response = await context.session.call("/supply/goods/getGoodsList", {
    method: "POST",
    operation: "read",
    body: { enterpriseCode: supplier.enterpriseCode, storeCode: supplier.storeCode, name, pageIndex: 1, pageSize: 100 },
  });
  if (!apiSucceeded(response.json)) throw new Error(`Goods query failed: ${response.json?.info ?? response.json?.status}`);
  return apiRows(response.json);
}

function mergeInput(items: InputItem[]) {
  const merged = new Map<string, any>();
  for (const tuple of items) {
    const [label, amount, unit, options = {}] = tuple as any;
    const saveUnit = options.saveUnit ?? unit;
    const saveAmount = Number(options.saveAmount ?? amount);
    const key = `${label.trim()}::${saveUnit}`;
    const current = merged.get(key) ?? {
      label: label.trim(), requestedAmount: 0, requestedUnit: unit, saveAmount: 0, saveUnit,
      conversion: options.conversion, priceOverride: options.priceOverride, modelSuggestions: [], confirmedGoods: options.confirmedGoods, rememberAlias: options.rememberAlias === true,
    };
    current.requestedAmount += Number(amount);
    current.saveAmount += saveAmount;
    current.modelSuggestions = [...new Set([...current.modelSuggestions, ...(options.modelSuggestions ?? [])])].slice(0, 3);
    if (options.confirmedGoods) current.confirmedGoods = options.confirmedGoods;
    if (options.priceOverride) current.priceOverride = options.priceOverride;
    current.rememberAlias ||= options.rememberAlias === true;
    merged.set(key, current);
  }
  return [...merged.values()];
}

async function resolveGoods(context: ToolContext, supplier: SupplierInfo, profile: TenantProfile, items: InputItem[]) {
  const resolved: any[] = [];
  const missing: any[] = [];
  let profileChanged = false;

  for (const item of mergeInput(items)) {
    const alias = profile.aliases.find((entry) => entry.enterpriseCode === supplier.enterpriseCode && entry.label === item.label && entry.unit === item.saveUnit);
    const confirmed = item.confirmedGoods ?? (alias ? { code: alias.goodsCode, name: alias.goodsName, unit: alias.unit } : undefined);
    const search = confirmed?.name ?? item.label;
    const catalog = await queryCatalog(context, supplier, search);
    let selected = confirmed
      ? catalog.find((goods) => String(goods.code ?? goods.goodsCode) === confirmed.code && goods.name === confirmed.name && goods.unit === confirmed.unit)
      : catalog.find((goods) => goods.name === item.label && goods.unit === item.saveUnit);

    const candidates = [...catalog];
    if (!selected && !confirmed) {
      for (const suggestion of item.modelSuggestions) candidates.push(...await queryCatalog(context, supplier, suggestion));
    }
    const compactCandidates = [...new Map(candidates.map((goods) => [`${goods.code ?? goods.goodsCode}::${goods.unit}`, goods])).values()]
      .filter((goods) => goods.unit === item.saveUnit)
      .slice(0, 10)
      .map((goods) => ({ code: goods.code ?? goods.goodsCode, name: goods.name, unit: goods.unit, specs: goods.specs, price: priceOf(goods) }));

    if (!selected) {
      missing.push({
        label: item.label,
        unit: item.saveUnit,
        reason: confirmed ? "confirmed goods is no longer available" : "exact live match not found",
        decision: "human_required",
        candidates: compactCandidates,
        modelSuggestions: item.modelSuggestions,
      });
      continue;
    }
    const price = item.priceOverride ?? priceOf(selected);
    if (!price || price <= 0) {
      missing.push({ label: item.label, reason: "live price is missing or invalid", decision: "human_required", candidates: compactCandidates });
      continue;
    }
    if (item.rememberAlias && item.confirmedGoods) {
      const existing = profile.aliases.findIndex((entry) => entry.enterpriseCode === supplier.enterpriseCode && entry.label === item.label && entry.unit === item.saveUnit);
      const value = { enterpriseCode: supplier.enterpriseCode, label: item.label, unit: item.saveUnit, goodsCode: String(selected.code ?? selected.goodsCode), goodsName: selected.name };
      if (existing >= 0) profile.aliases[existing] = value; else profile.aliases.push(value);
      profileChanged = true;
    }
    resolved.push({ item, selected, price, source: item.confirmedGoods ? "user_confirmed" : alias ? "local_alias" : "exact_live", candidates: compactCandidates });
  }

  const groups = new Map<string, any[]>();
  for (const row of resolved) {
    const key = `${row.selected.code ?? row.selected.goodsCode}::${row.selected.unit}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const goodsList: any[] = [];
  const mappings: any[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const amount = group.reduce((sum, row) => sum + row.item.saveAmount, 0);
    const prices = [...new Set(group.map((row) => Number(row.price)))];
    if (prices.length !== 1) throw new Error("Conflicting prices were supplied for the same live goods item");
    const price = prices[0]!;
    goodsList.push({
      ...first.selected,
      amount,
      price,
      unitPrice: price,
      totalPrice: Number((amount * price).toFixed(2)),
      currentPrice: false,
      unitPriceIsRealTime: 0,
      description: first.selected.description ?? null,
    });
    mappings.push({
      labels: group.map((row) => row.item.label),
      selectedCode: String(first.selected.code ?? first.selected.goodsCode),
      selectedName: first.selected.name,
      selectedUnit: first.selected.unit,
      selectedPrice: price,
      saveAmount: amount,
      source: group.some((row) => row.source === "user_confirmed") ? "user_confirmed" : group.some((row) => row.source === "local_alias") ? "local_alias" : "exact_live",
      candidates: first.candidates,
    });
  }
  if (profileChanged) await context.vault.save(profile);
  return { goodsList, mappings, missing };
}

function comparePrices(supplier: SupplierInfo, mappings: any[], priceSheet: any) {
  if (!priceSheet) return undefined;
  const comparisons = mappings.map((mapping) => {
    const reference = priceSheet.entries.find((entry: any) => entry.enterpriseCode === supplier.enterpriseCode && entry.unit === mapping.selectedUnit && (entry.goodsCode ? entry.goodsCode === mapping.selectedCode : entry.goodsName === mapping.selectedName));
    if (!reference) return { goodsCode: mapping.selectedCode, status: "missing_reference" };
    const deviationPct = Number((((mapping.selectedPrice - reference.referencePrice) / reference.referencePrice) * 100).toFixed(2));
    return { goodsCode: mapping.selectedCode, goodsName: mapping.selectedName, systemPrice: mapping.selectedPrice, referencePrice: reference.referencePrice, deviationPct, status: Math.abs(deviationPct) > 10 ? "deviation_over_10_percent" : "ok" };
  });
  return { asOf: priceSheet.asOf, comparisons, reviewRequired: comparisons.some((item: any) => item.status !== "ok") };
}

const singleOrderShape = {
  ...supplierShape,
  warehouse: z.string().min(1),
  deliveryDate: z.string().min(1),
  items: z.array(itemSchema).min(1),
};

async function draftList(context: ToolContext) {
  const response = await context.session.call("/supply/order/getOrderList", {
    method: "POST", operation: "read", body: { pageIndex: 1, pageSize: 100, statusList: [0], orderGoodsType: 1, orderSource: 0 },
  });
  if (!apiSucceeded(response.json)) throw new Error(`Draft list failed: ${response.json?.info ?? response.json?.status}`);
  return apiRows(response.json);
}

function sameGoods(detail: any, mappings: any[]): boolean {
  const actual = detail?.orderGoodsList ?? [];
  return actual.length === mappings.length && mappings.every((wanted) => actual.some((item: any) =>
    String(item.code ?? item.goodsCode) === wanted.selectedCode && item.unit === wanted.selectedUnit && Math.abs(Number(item.amount) - Number(wanted.saveAmount)) < 0.0001));
}

export const PURCHASE_TOOLS: ToolDefinition[] = [
  {
    name: "merge_items",
    description: "合并相同用户名称和保存单位的采购明细。",
    schema: { items: z.array(itemSchema).min(1) },
    async handler(args) { return ok({ originalCount: args.items.length, items: mergeInput(args.items) }); },
  },
  {
    name: "match_goods",
    description: "按当前供应商实时目录匹配商品；非完全匹配必须由用户确认。",
    schema: { ...supplierShape, items: z.array(itemSchema).min(1), priceSheet: priceSheetSchema },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const supplier = await resolveSupplier(context, args);
      const result = await resolveGoods(context, supplier, profile, args.items);
      return ok({ supplier, ...result, priceComparison: comparePrices(supplier, result.mappings, args.priceSheet), status: result.missing.length ? "blocked_human_decision" : "ready" });
    },
  },
  {
    name: "precheck_order",
    description: "批量预检采购草稿所需的供应商、仓库、商品和参考价，不执行保存。",
    schema: { orders: z.array(z.object(singleOrderShape)).min(1), priceSheet: priceSheetSchema },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const orders = [];
      for (const order of args.orders) {
        const supplier = await resolveSupplier(context, order);
        const warehouse = findWarehouse(profile, order.warehouse);
        const result = await resolveGoods(context, supplier, profile, order.items);
        const priceComparison = comparePrices(supplier, result.mappings, args.priceSheet);
        orders.push({ supplier, warehouse, deliveryDate: order.deliveryDate, ...result, priceComparison });
      }
      const human = orders.some((order) => order.missing.length);
      const price = orders.some((order) => order.priceComparison?.reviewRequired);
      return ok({ status: human ? "blocked_human_decision" : price ? "blocked_price_review" : "ready", orders });
    },
  },
  {
    name: "save_order",
    description: "保存线上采购草稿并回查验收；不会提交或发起审批。",
    schema: {
      ...singleOrderShape,
      purpose: z.number().int().optional(),
      nutrition: z.number().int().min(0).max(1).optional(),
      priceSheet: priceSheetSchema,
      confirmPriceReview: z.boolean().optional().default(false),
      skipIfExists: z.boolean().optional().default(true),
    },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const supplier = await resolveSupplier(context, args);
      const warehouse = findWarehouse(profile, args.warehouse);
      const result = await resolveGoods(context, supplier, profile, args.items);
      if (result.missing.length) return err("Unresolved goods require explicit user confirmation", result.missing);
      const priceComparison = comparePrices(supplier, result.mappings, args.priceSheet);
      if (priceComparison?.reviewRequired && args.confirmPriceReview !== true) return err("Reference-price review is required", priceComparison);

      const before = await draftList(context);
      const beforeCodes = new Set(before.map((item) => String(item.orderCode)));
      const candidates = before.filter((item) => (item.enterpriseCode === supplier.enterpriseCode || item.enterpriseName === supplier.enterpriseName) && item.warehouseName === warehouse.warehouseName && String(item.deliveryDate).replace("T", " ").slice(0, 19) === args.deliveryDate);
      if (args.skipIfExists !== false) {
        for (const candidate of candidates) {
          const detail = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(candidate.orderCode)}`, { operation: "read" });
          if (sameGoods(detail.json?.data, result.mappings)) return ok({ saved: false, skippedExisting: true, orderCode: candidate.orderCode, verification: { passed: true } });
        }
      }

      const payload = {
        enterpriseCode: supplier.enterpriseCode,
        storeCode: supplier.storeCode,
        buyer: profile.buyer,
        buyerPhone: profile.buyerPhone,
        warehouseId: warehouse.warehouseId,
        warehouseName: warehouse.warehouseName,
        receiver: warehouse.receiver,
        receiverPhone: warehouse.receiverPhone,
        purpose: args.purpose ?? profile.purpose,
        nutrition: args.nutrition ?? warehouse.nutrition,
        deliveryDate: args.deliveryDate,
        remark: warehouse.remark,
        orderSource: 0,
        stallId: 0,
        goodsList: result.goodsList,
      };
      const saved = await context.session.call("/supply/order/saveOrder", { method: "POST", operation: "write", body: payload });
      if (!apiSucceeded(saved.json)) return err("Save order failed", saved.json?.info ?? saved.json?.status);

      let newDraft: any;
      for (let attempt = 0; attempt < 3 && !newDraft; attempt += 1) {
        await sleep(1500 + attempt * 500);
        const after = await draftList(context);
        newDraft = after.find((item) => !beforeCodes.has(String(item.orderCode)) && item.enterpriseCode === supplier.enterpriseCode && item.warehouseName === warehouse.warehouseName && String(item.deliveryDate).replace("T", " ").slice(0, 19) === args.deliveryDate);
      }
      if (!newDraft) return ok({ saved: true, orderCode: null, verification: { passed: false, reason: "new draft was not visible in the list" }, priceComparison });
      const detail = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(newDraft.orderCode)}`, { operation: "read" });
      const verification = {
        passed: Number(detail.json?.data?.status) === 0 && detail.json?.data?.warehouseId == warehouse.warehouseId && detail.json?.data?.receiver === warehouse.receiver && sameGoods(detail.json?.data, result.mappings),
        status: detail.json?.data?.status,
        warehouseName: detail.json?.data?.warehouseName,
        goodsMatched: sameGoods(detail.json?.data, result.mappings),
      };
      return ok({ saved: true, skippedExisting: false, orderCode: newDraft.orderCode, verification, priceComparison });
    },
  },
  {
    name: "delete_order",
    description: "删除误建的 status=0 草稿；必须 confirm:true，删除后回查草稿列表。",
    schema: { orderCode: z.string().min(1), confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.confirm !== true) return ok({ action: "blocked", message: "Set confirm:true to delete a draft." });
      const before = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(args.orderCode)}`, { operation: "read" });
      const detail = before.json?.data;
      if (!detail) return err("Order not found");
      if (Number(detail.status) !== 0) return err("Only status=0 drafts can be deleted");
      const deleted = await context.session.call(`/supply/order/delOrder?orderCode=${encodeURIComponent(args.orderCode)}`, { method: "GET", operation: "write" });
      if (!apiSucceeded(deleted.json)) return err("Draft deletion failed", deleted.json?.info);
      await sleep(1200);
      const after = await draftList(context);
      const stillPresent = after.some((item) => item.orderCode === args.orderCode);
      return ok({ action: "deleted", orderCode: args.orderCode, verification: { passed: !stillPresent, stillPresent } });
    },
  },
];
