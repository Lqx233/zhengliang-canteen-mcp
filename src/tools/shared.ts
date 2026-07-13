import type { z } from "zod";
import type { DiscoveryService } from "../discovery.js";
import type { ProfileWizard } from "../config/wizard.js";
import type { ProfileVault } from "../config/vault.js";
import type { Session } from "../session.js";
import type { TenantProfile, ToolResult } from "../types.js";

export interface ToolContext {
  session: Session;
  vault: ProfileVault;
  wizard: ProfileWizard;
  discovery: DiscoveryService;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (args: any, context: ToolContext) => Promise<ToolResult>;
}

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function err(message: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, details }, null, 2) }],
    isError: true,
  };
}

export function apiSucceeded(json: any): boolean {
  return json?.status === 0 || json?.status === "0" || json?.success === true;
}

export function apiRows(json: any): any[] {
  const data = json?.data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data)) return data;
  if (Array.isArray(json?.list)) return json.list;
  return [];
}

export async function requireProfile(context: ToolContext): Promise<TenantProfile> {
  const profile = await context.vault.load();
  if (!profile) throw new Error("Tenant profile is not configured. Run open_profile_setup first.");
  return profile;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function today(value?: string): string {
  if (value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must use YYYY-MM-DD");
    return value;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dateBack(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}
