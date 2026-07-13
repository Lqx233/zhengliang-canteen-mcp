import { z } from "zod";
import type { TenantProfile, WarehouseProfile } from "../types.js";

const warehouseSchema = z.object({
  warehouseId: z.string().min(1),
  warehouseName: z.string().min(1),
  receiver: z.string().min(1),
  receiverPhone: z.string().min(1),
  nutrition: z.number().int().min(0).max(1),
  remark: z.string().min(1),
});

export const tenantProfileSchema = z.object({
  version: z.literal(1),
  buyer: z.string().min(1),
  buyerPhone: z.string().min(1),
  purpose: z.number().int().nonnegative(),
  warehouses: z.array(warehouseSchema).min(1),
  ledgers: z.object({
    morningChecker: z.string().min(1),
    deviceChecker: z.string().min(1),
    deviceExecuter: z.string().min(1),
    wasteChecker: z.string().min(1),
    wasteDisposer: z.string().min(1),
    wasteHandler: z.string().min(1),
    dinersCount: z.number().int().positive(),
  }),
  wasteQuickFill: z.object({
    enabled: z.boolean(),
    foodWaste: z.number().nonnegative(),
    prepWaste: z.number().nonnegative(),
    otherWaste: z.number().nonnegative(),
  }).optional(),
  aliases: z.array(z.object({
    enterpriseCode: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().min(1),
    goodsCode: z.string().min(1),
    goodsName: z.string().min(1),
  })).default([]),
});

export function parseTenantProfile(value: unknown): TenantProfile {
  return tenantProfileSchema.parse(value) as TenantProfile;
}

export function findWarehouse(profile: TenantProfile, name: string): WarehouseProfile {
  const warehouse = profile.warehouses.find((item) => item.warehouseName === name || item.warehouseId === name);
  if (!warehouse) throw new Error(`Warehouse is not configured: ${name}`);
  return warehouse;
}
