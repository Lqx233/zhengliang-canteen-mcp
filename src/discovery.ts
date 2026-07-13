import type { Session } from "./session.js";
import type { SupplierInfo, WarehouseProfile } from "./types.js";

function rows(value: any): any[] {
  const data = value?.data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data)) return data;
  if (Array.isArray(value?.list)) return value.list;
  return [];
}

export class DiscoveryService {
  constructor(private readonly session: Session) {}

  async suppliers(): Promise<SupplierInfo[]> {
    const response = await this.session.call(
      "/basic/supplyAdmin/getSupplierCustomerList?pageIndex=1&pageSize=200&isSemester=true&status=1&type=1",
      { operation: "read" },
    );
    return rows(response.json).map((row) => ({
      enterpriseCode: String(row.code ?? row.enterpriseCode ?? ""),
      enterpriseName: String(row.name ?? row.enterpriseName ?? ""),
      storeCode: String(row.storeCode ?? "000"),
    })).filter((item) => item.enterpriseCode && item.enterpriseName);
  }

  async warehouses(): Promise<WarehouseProfile[]> {
    const candidates: any[] = [];
    for (const [path, body] of [
      ["/supply/warehouse/findWarehouse", { pageIndex: 1, pageSize: 200 }],
      ["/supply/warehouseDisplay/getUserWarehouse", {}],
    ] as const) {
      try {
        const response = await this.session.call(path, { method: "POST", body, operation: "read" });
        candidates.push(...rows(response.json));
      } catch {
        // Accounts do not always expose both warehouse endpoints.
      }
    }
    const unique = new Map<string, WarehouseProfile>();
    for (const row of candidates) {
      const warehouseId = String(row.id ?? row.warehouseId ?? row.code ?? "");
      const warehouseName = String(row.name ?? row.warehouseName ?? "");
      if (!warehouseId || !warehouseName) continue;
      const current = unique.get(warehouseId);
      unique.set(warehouseId, {
        warehouseId,
        warehouseName,
        receiver: String(row.receiver ?? row.acceptance ?? current?.receiver ?? ""),
        receiverPhone: String(row.receiverPhone ?? row.acceptancePhone ?? current?.receiverPhone ?? ""),
        nutrition: Number(row.nutrition ?? current?.nutrition ?? 0) === 1 ? 1 : 0,
        remark: String(row.remark ?? current?.remark ?? warehouseName),
      });
    }
    return [...unique.values()];
  }
}
