export interface ApiResponse<T = unknown> {
  httpStatus: number;
  json: T;
}

export interface SupplierInfo {
  enterpriseCode: string;
  enterpriseName: string;
  storeCode: string;
}

export interface WarehouseProfile {
  warehouseId: string;
  warehouseName: string;
  receiver: string;
  receiverPhone: string;
  nutrition: number;
  remark: string;
}

export interface TenantProfile {
  version: 1;
  buyer: string;
  buyerPhone: string;
  purpose: number;
  warehouses: WarehouseProfile[];
  ledgers: {
    morningChecker: string;
    deviceChecker: string;
    deviceExecuter: string;
    wasteChecker: string;
    wasteDisposer: string;
    wasteHandler: string;
    dinersCount: number;
  };
  wasteQuickFill?: {
    enabled: boolean;
    foodWaste: number;
    prepWaste: number;
    otherWaste: number;
  };
  aliases: Array<{
    enterpriseCode: string;
    label: string;
    unit: string;
    goodsCode: string;
    goodsName: string;
  }>;
}

export type OperationKind = "read" | "write";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  operation?: OperationKind;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
