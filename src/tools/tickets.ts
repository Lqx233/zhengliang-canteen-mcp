import { responseSucceeded } from "../api.js";
import { sameRecords } from "./verification.js";
import { z } from "zod";
import type { ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok, sleep, verifiedWrite } from "./shared.js";

function needsTicket(order: any): boolean {
  return [4, 5].includes(Number(order.status)) && Number(order.ticketTotal ?? 0) === 0;
}

async function resolveTicketTarget(args: any, context: any): Promise<{ queryTicketId: number; queryTicketType: number; orderCode?: string }> {
  if (args.queryTicketId !== undefined) return { queryTicketId: args.queryTicketId, queryTicketType: args.queryTicketType ?? 1 };
  if (!args.orderCode) throw new Error("orderCode or queryTicketId is required");
  const response = await context.session.call(`/supply/order/getOrder?orderCode=${encodeURIComponent(args.orderCode)}`, { operation: "read" });
  const detail = response.json?.data;
  if (!apiSucceeded(response.json) || !detail) throw new Error("Order could not be resolved");
  return { queryTicketId: Number(detail.queryTicketId ?? detail.id), queryTicketType: Number(detail.queryTicketType ?? detail.orderVariety ?? 1), orderCode: args.orderCode };
}

function flattenCertificates(data: any): any[] {
  return [
    ...(Array.isArray(data?.certificateList) ? data.certificateList : []),
    ...(Array.isArray(data?.categoryList) ? data.categoryList : []).flatMap((category: any) =>
      (Array.isArray(category.certificateList) ? category.certificateList : []).map((item: any) => ({ ...item, groupName: item.groupName ?? category.groupName, allType: item.allType ?? category.allType }))),
  ];
}

function certificateIdentity(item: any): string | null {
  for (const key of ["id", "certificateId", "fileId", "url"]) {
    if (item?.[key] !== undefined && item?.[key] !== null && String(item[key])) return `${key}:${String(item[key])}`;
  }
  return null;
}

export const TICKET_TOOLS: ToolDefinition[] = [
  {
    name: "scan_missing_tickets",
    effect: "read",
    description: "扫描指定日期范围内已配送/已完成订单，列出 ticketTotal=0 的缺证订单。",
    schema: {
      startDate: z.string().min(1), endDate: z.string().min(1), statusList: z.array(z.number().int()).optional(), pageSize: z.number().int().positive().max(200).optional(),
      includeExempt: z.boolean().optional(), excludeEnterpriseCodes: z.array(z.string()).optional(),
    },
    async handler(args, context) {
      const statusList = args.statusList ?? [4, 5];
      const pageSize = args.pageSize ?? 100;
      const excluded = new Set(args.excludeEnterpriseCodes ?? []);
      const orders: any[] = [];
      for (let pageIndex = 1; ; pageIndex += 1) {
        const response = await context.session.call("/supply/order/getOrderList", {
          method: "POST", operation: "read",
          body: { pageIndex, pageSize, statusList, stallQuery: 0, startTime: args.startDate, endTime: args.endDate, orderGoodsType: 1, orderSource: 0 },
        });
        if (!apiSucceeded(response.json)) return err("Order scan failed", response.json?.info);
        const list = apiRows(response.json);
        orders.push(...list);
        const total = Number(response.json?.data?.totalCount ?? response.json?.data?.total ?? 0);
        if (list.length < pageSize || (total > 0 && orders.length >= total)) break;
        await sleep(150);
      }
      const scanned = orders.filter((order) => !excluded.has(String(order.enterpriseCode))).map((order) => ({
        orderCode: order.orderCode, enterpriseCode: order.enterpriseCode, enterpriseName: order.enterpriseName, warehouseName: order.warehouseName,
        deliveryDate: String(order.deliveryDate ?? "").slice(0, 10), status: order.status, ticketTotal: order.ticketTotal ?? 0,
        queryTicketId: order.queryTicketId ?? order.id, queryTicketType: order.queryTicketType ?? order.orderVariety ?? 1, missingTicket: needsTicket(order),
      }));
      const missing = scanned.filter((order) => order.missingTicket);
      const bySupplier = new Map<string, any>();
      for (const order of missing) {
        const key = String(order.enterpriseCode ?? order.enterpriseName);
        const value = bySupplier.get(key) ?? { enterpriseCode: order.enterpriseCode, enterpriseName: order.enterpriseName, missingOrderCount: 0, dates: new Set<string>() };
        value.missingOrderCount += 1;
        value.dates.add(order.deliveryDate);
        bySupplier.set(key, value);
      }
      return ok({ scannedCount: scanned.length, missingCount: missing.length, missing, summaryBySupplier: [...bySupplier.values()].map((value) => ({ ...value, dates: [...value.dates] })) });
    },
  },
  {
    name: "get_order_ticket",
    effect: "read",
    description: "按 orderCode 或 queryTicketId 查询订单票证和合格证。",
    schema: { orderCode: z.string().optional(), queryTicketId: z.number().int().optional(), queryTicketType: z.number().int().optional() },
    async handler(args, context) {
      const target = await resolveTicketTarget(args, context);
      const response = await context.session.call(`/supply/order/getTicket/old?queryTicketId=${target.queryTicketId}&queryTicketType=${target.queryTicketType}`, { operation: "read" });
      if (!apiSucceeded(response.json)) return err("Ticket query failed", response.json?.info);
      const data = response.json?.data ?? {};
      const certificates = flattenCertificates(data);
      const withImage = certificates.filter((item) => Boolean(item.url) || (Array.isArray(item.idList) && item.idList.length) || (Array.isArray(item.fileList) && item.fileList.length));
      return ok({ ...target, ticketTotal: data.ticketTotal ?? certificates.length, certificateCount: certificates.length, certificateWithImageCount: withImage.length, invoiceCount: Array.isArray(data.invoiceList) ? data.invoiceList.length : 0, certificateList: certificates, invoiceList: data.invoiceList ?? [] });
    },
  },
  {
    name: "update_order_ticket",
    effect: "remote-write",
    description: "更新订单票证；必须 confirm:true，并在写入后回查。",
    schema: { orderCode: z.string().optional(), queryTicketId: z.number().int().optional(), queryTicketType: z.number().int().optional(), certificateList: z.array(z.unknown()).optional(), confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.confirm !== true) return ok({ action: "blocked", message: "Set confirm:true to update ticket data." });
      const target = await resolveTicketTarget(args, context);
      const path = `/supply/order/getTicket/old?queryTicketId=${target.queryTicketId}&queryTicketType=${target.queryTicketType}`;
      const before = await context.session.call(path, { operation: "read" });
      if (!apiSucceeded(before.json)) return err("Existing ticket query failed", before.json?.info);
      const existing = before.json?.data ?? {};
      const payload = {
        isIdentical: existing.isIdentical,
        orderType: existing.orderType ?? target.queryTicketType,
        invoiceList: existing.invoiceList ?? [],
        certificateList: args.certificateList ?? flattenCertificates(existing),
        id: existing.id ?? target.queryTicketId,
        updateTime: existing.updateTime,
      };
      const saved = await context.session.call("/supply/order/updOrderTicket/old", { method: "POST", operation: "write", body: payload });
      if (!apiSucceeded(saved.json)) return err("Ticket update failed", saved.json?.info);
      await sleep(1800);
      let passed = false;
      let certificateCount = 0;
      try {
        const after = await context.session.call(path, { operation: "read" });
        const certificates = flattenCertificates(after.json?.data ?? {});
        certificateCount = certificates.length;
        passed = responseSucceeded(after) && sameRecords(certificates, payload.certificateList) &&
          sameRecords(after.json?.data?.invoiceList ?? [], payload.invoiceList);
      } catch { /* Report an accepted but unverified write. */ }
      return verifiedWrite("Ticket update was accepted but verification failed", { action: "updated", ...target }, { passed, certificateCount });
    },
  },
];
