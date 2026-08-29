import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, dateBack, err, ok, requireProfile, sleep, today, verifiedWrite } from "./shared.js";

export function staffTemperature(index: number, min = 36.2, max = 37.1): string {
  const steps = Math.max(1, Math.round((max - min) * 10));
  return (min + ((index * 7 + 3) % (steps + 1)) / 10).toFixed(1);
}

function timeSeconds(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

export function staffTime(index: number, total: number, start = "05:30", end = "06:00"): string {
  const startSeconds = timeSeconds(start);
  const endSeconds = timeSeconds(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error("Invalid time range");
  const span = endSeconds - startSeconds;
  const offset = total <= 1 ? 0 : Math.floor((index * Math.max(1, span - 60)) / (total - 1));
  const seconds = startSeconds + offset;
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:00`;
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}

function staffRecords(data: any): any[] {
  const value = data?.recordValue ?? data?.data?.recordValue;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function deviceItems(data: any): any[] {
  const record = data?.recordValue ?? data?.data?.recordValue;
  const parsed = parseJson(record?.value ?? record);
  return Array.isArray(parsed?.deviceDistinctionItemList) ? parsed.deviceDistinctionItemList : [];
}

function wasteValue(data: any): any {
  const record = data?.recordValue ?? data?.data?.recordValue;
  if (Array.isArray(record)) return parseJson(record[0]?.value);
  if (record && typeof record === "object" && "0" in record) return parseJson(record[0]?.value);
  return parseJson(record?.value ?? record);
}

async function staffDetail(context: ToolContext, date: string): Promise<any> {
  const response = await context.session.call(`/hygiene/api/staffInspection/getStaffInspectionLedgerRecord?date=${date}&ledgerName=${encodeURIComponent("人员晨检")}`, { operation: "read" });
  if (!apiSucceeded(response.json) && !response.json?.data) throw new Error(`Morning-check query failed: ${response.json?.info ?? response.json?.status}`);
  return response.json?.data ?? {};
}

async function deviceDetail(context: ToolContext, date: string): Promise<any> {
  const response = await context.session.call(`/hygiene/api/fillInValue/getRecords?date=${date}&ledgerName=${encodeURIComponent("设备清洗消毒")}&stallId=0`, { operation: "read" });
  if (!apiSucceeded(response.json) && !response.json?.data) throw new Error(`Device-ledger query failed: ${response.json?.info ?? response.json?.status}`);
  return response.json?.data ?? {};
}

async function wasteDetail(context: ToolContext, date: string): Promise<any> {
  const response = await context.session.call(`/hygiene/api/wasteDisposal?date=${date}&ledgerName=${encodeURIComponent("废弃物处置")}`, { operation: "read" });
  if (!apiSucceeded(response.json) && !response.json?.data) throw new Error(`Waste-ledger query failed: ${response.json?.info ?? response.json?.status}`);
  return response.json?.data ?? {};
}

async function recentTemplate<T>(targetDate: string, load: (date: string) => Promise<T>, hasData: (data: T) => boolean): Promise<{ date: string; data: T } | null> {
  for (let days = 1; days <= 30; days += 1) {
    const date = dateBack(targetDate, days);
    const data = await load(date);
    if (hasData(data)) return { date, data };
  }
  return null;
}

const LEDGER_ENDPOINTS: Record<string, string> = {
  人员晨检: "/hygiene/api/staffInspection/getStaffInspectionLedgerRecordList",
  人员午检: "/hygiene/api/staffInspection/getStaffInspectionLedgerRecordList",
  食品留样: "/hygiene/api/foodSample/getFoodSampleLedgerRecordList",
  安全周查: "/hygiene/api/safetyInspectionStatistics",
  安全月查: "/hygiene/api/safetyInspectionStatistics",
  仓库检查: "/hygiene/api/warehouseCheckStatistics",
  陪餐评价: "/hygiene/api/accompanyMeal/getAccompanyLedgerRecordList",
  废弃物处置: "/hygiene/api/wasteDisposalLedgerRecord",
};

export const LEDGER_TOOLS: ToolDefinition[] = [
  {
    name: "save_morning_check",
    effect: "remote-write",
    description: "使用最近完整模板保存人员晨检并回查；已有记录默认跳过，重建必须 force:true 和 confirm:true。",
    schema: {
      date: z.string().optional(), checker: z.string().optional(), tempRange: z.tuple([z.number(), z.number()]).optional(), timeRange: z.tuple([z.string(), z.string()]).optional(),
      force: z.boolean().optional(), confirm: z.boolean().optional().default(false),
    },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const date = today(args.date);
      const [min, max] = args.tempRange ?? [36.2, 37.1];
      const [timeStart, timeEnd] = args.timeRange ?? ["05:30", "06:00"];
      if (min < 35 || max > 37.2 || min > max) return err("Temperature range must stay within 35.0-37.2");
      if (timeSeconds(timeStart) >= timeSeconds(timeEnd)) return err("Invalid morning-check time range");
      const existing = await staffDetail(context, date);
      const existingRows = staffRecords(existing);
      if (existingRows.length && !args.force) return ok({ action: "skipped_existing", date, count: existingRows.length });
      if (existingRows.length && args.confirm !== true) return ok({ action: "blocked_confirmation_required", date });
      const template = await recentTemplate(date, (value) => staffDetail(context, value), (data) => staffRecords(data).length > 0);
      if (!template) return err("No complete morning-check template was found in the previous 30 days");
      const templateRows = staffRecords(template.data);
      const records = templateRows.map((record: any, index: number) => {
        const row = {
          ...parseJson(record.value), key: index + 1, attendanceStatus: 1, isVomiting: 0, isDiarrhea: 0, isCough: 0, isInfection: 0,
          decorations: 1, nailsHair: 1, overalls: 1, image: { urlList: [] }, processResult: "正常", remarks: "", temperatureStatus: 1,
          temperature: staffTemperature(index, min, max), employeeId: String(record.employeeId), employeeName: record.employeeName,
          attendanceTime: staffTime(index, templateRows.length, timeStart, timeEnd), peopleName: record.employeeName,
          vomiting: 0, diarrhea: 0, cough: 0, skinWoundOrInfection: 0, wearingJewelry: 1, nailsAndHair: 1, workClothes: 1, attendance: "上班", infection: "否",
        };
        delete (row as any).id;
        return { employeeId: String(record.employeeId), employeeName: record.employeeName, value: JSON.stringify(row) };
      });
      if (existingRows.length) {
        const deleted = await context.session.call("/hygiene/api/staffInspection/delStaffInspectionRecord", { method: "POST", operation: "write", body: { date, ledgerName: "人员晨检" } });
        if (!apiSucceeded(deleted.json)) return err("Existing morning check could not be deleted", deleted.json?.info);
      }
      const checker = args.checker ?? template.data?.checker ?? profile.ledgers.morningChecker;
      const saved = await context.session.call("/hygiene/api/staffInspection/saveStaffInspectionRecord", { method: "POST", operation: "write", body: { date, checker, ledgerName: "人员晨检", recordValue: records } });
      if (!apiSucceeded(saved.json)) return err("Morning check save failed", saved.json?.info);
      await sleep(2200);
      const after = staffRecords(await staffDetail(context, date));
      const parsed = after.map((item) => parseJson(item.value));
      const passed = after.length === records.length && parsed.every((row) => Number(row.temperature) >= min && Number(row.temperature) <= max && String(row.attendanceTime) >= `${timeStart}:00` && String(row.attendanceTime) < `${timeEnd}:00`);
      return verifiedWrite("Morning-check write was accepted but verification failed", { action: "created", date, templateDate: template.date, count: records.length }, { passed });
    },
  },
  {
    name: "save_device_disinfection",
    effect: "remote-write",
    description: "使用最近设备模板保存清洗消毒记录并回查；已有记录默认跳过。",
    schema: { date: z.string().optional(), selectTime: z.string().optional(), duration: z.number().int().positive().optional(), force: z.boolean().optional() },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const date = today(args.date);
      const selectTime = args.selectTime ?? "08:00";
      const duration = args.duration ?? 30;
      const existing = await deviceDetail(context, date);
      if (deviceItems(existing).length) return ok({ action: args.force ? "skipped_no_delete_api" : "skipped_existing", date, count: deviceItems(existing).length });
      const template = await recentTemplate(date, (value) => deviceDetail(context, value), (data) => deviceItems(data).length > 0);
      if (!template) return err("No device-disinfection template was found in the previous 30 days");
      const items = deviceItems(template.data).map((item) => ({
        ...item, methodForDistinction: item.methodForDistinction || "清洗,84消毒,酒精消毒", selectTime, duration,
        executer: profile.ledgers.deviceExecuter, image: { urlList: [] }, remark: item.remark ?? "",
      }));
      const payload = { checker: profile.ledgers.deviceChecker, date, ledgerName: "设备清洗消毒", ledgerNo: null, recordValue: { id: null, value: JSON.stringify({ deviceDistinctionItemList: items }) }, stallId: 0, stallName: "" };
      const saved = await context.session.call("/hygiene/api/fillInValue/saveRecords", { method: "POST", operation: "write", body: payload });
      if (!apiSucceeded(saved.json)) return err("Device-disinfection save failed", saved.json?.info);
      await sleep(2500);
      let after = await deviceDetail(context, date);
      if (!deviceItems(after).length) { await sleep(1800); after = await deviceDetail(context, date); }
      const passed = deviceItems(after).length === items.length && deviceItems(after).every((item) => item.selectTime === selectTime && Number(item.duration) === duration);
      return verifiedWrite("Device-disinfection write was accepted but verification failed", { action: "created", date, templateDate: template.date, count: items.length }, { passed });
    },
  },
  {
    name: "save_waste_disposal",
    effect: "remote-write",
    description: "保存三类废弃物实际数量并回查；快速填报必须先在加密配置中启用。",
    schema: {
      date: z.string().optional(), amounts: z.object({ 餐厨: z.number().nonnegative(), 食材废料: z.number().nonnegative(), 其他: z.number().nonnegative() }).optional(),
      fastFill: z.boolean().optional().default(false), unit: z.string().optional(), disposalTime: z.string().optional(), dinersCount: z.number().int().positive().optional(), force: z.boolean().optional(),
    },
    async handler(args, context) {
      const profile = await requireProfile(context);
      const date = today(args.date);
      const existing = wasteValue(await wasteDetail(context, date));
      if ((existing?.wasteDisposalDtlList ?? []).length) return ok({ action: args.force ? "skipped_no_delete_api" : "skipped_existing", date });
      let amounts = args.amounts;
      if (!amounts && args.fastFill === true && profile.wasteQuickFill?.enabled) {
        amounts = { 餐厨: profile.wasteQuickFill.foodWaste, 食材废料: profile.wasteQuickFill.prepWaste, 其他: profile.wasteQuickFill.otherWaste };
      }
      if (!amounts) return err("Actual amounts are required unless encrypted quick-fill defaults are enabled");
      const unit = args.unit ?? "斤";
      const disposalTime = args.disposalTime ?? "08:30";
      const dinersCount = args.dinersCount ?? profile.ledgers.dinersCount;
      const items = [
        { wasteType: 1, amount: amounts.餐厨, unit, disposalTime, uses: "集中处理", image: { urlList: [] }, remark: "" },
        { wasteType: 2, amount: amounts.食材废料, unit, disposalTime, uses: "集中处理", image: { urlList: [] }, remark: "" },
        { wasteType: 3, amount: amounts.其他, unit, disposalTime, uses: "集中处理", image: { urlList: [] }, remark: "" },
      ];
      const payload = { checker: profile.ledgers.wasteChecker, date, ledgerName: "废弃物处置", recordValue: { id: null, value: JSON.stringify({ disposer: profile.ledgers.wasteDisposer, handler: profile.ledgers.wasteHandler, dinersCount, wasteDisposalDtlList: items }) } };
      const saved = await context.session.call("/hygiene/api/wasteDisposal", { method: "POST", operation: "write", body: payload });
      if (!apiSucceeded(saved.json)) return err("Waste-disposal save failed", saved.json?.info);
      await sleep(2200);
      const after = wasteValue(await wasteDetail(context, date));
      const actual = after?.wasteDisposalDtlList ?? [];
      const passed = actual.length === 3 && actual.every((item: any) => item.unit === unit && item.disposalTime === disposalTime) && Number(after?.dinersCount) === dinersCount;
      return verifiedWrite("Waste-disposal write was accepted but verification failed", { action: "created", date, amounts }, { passed });
    },
  },
  {
    name: "list_ledger_records",
    effect: "read",
    description: "按台账名称和日期范围查询记录。",
    schema: { ledgerName: z.string().min(1), days: z.number().int().positive().optional(), endDate: z.string().optional(), pageIndex: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional() },
    async handler(args, context) {
      const endDate = today(args.endDate);
      const startDate = dateBack(endDate, args.days ?? 30);
      const endpoint = LEDGER_ENDPOINTS[args.ledgerName] ?? "/hygiene/api/fillInValue/getLedgerValueRecordList";
      const query = new URLSearchParams({ pageIndex: String(args.pageIndex ?? 1), pageSize: String(args.pageSize ?? 15), ledgerName: args.ledgerName, startTime: startDate, endTime: endDate });
      const response = await context.session.call(`${endpoint}?${query}`, { operation: "read" });
      if (!apiSucceeded(response.json) && !response.json?.data) return err("Ledger query failed", response.json?.info);
      const records = apiRows(response.json);
      return ok({ ledgerName: args.ledgerName, startDate, endDate, count: records.length, total: response.json?.data?.totalCount ?? response.json?.data?.total ?? records.length, records });
    },
  },
];
