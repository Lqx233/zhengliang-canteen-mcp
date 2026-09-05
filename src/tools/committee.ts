import { sameRecords } from "./verification.js";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { apiRows, apiSucceeded, err, ok, sleep, verifiedWrite } from "./shared.js";

const DIET_POSITIONS: Record<string, number> = { 主任: 1, 副主任: 2, 成员: 3 };
const REPRESENTATIVES: Record<string, number> = { 教师代表: 1, 家长代表: 2, 社区代表: 3, 学生代表: 4, 学校代表: 5, 食堂代表: 6, 食安管理员: 7 };
const PARENT_POSITIONS = ["召集人（组长）", "副组长", "成员"];

async function dietTerms(context: ToolContext): Promise<any[]> {
  const response = await context.session.call("/basic/dietCommittee/selDietCommitteeForSchool", { method: "POST", operation: "read", body: { pageIndex: 1, pageSize: 100 } });
  if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Diet committee query failed");
  return apiRows(response.json);
}

async function parentTerms(context: ToolContext): Promise<any[]> {
  const response = await context.session.call("/basic/parentsOversightCommittee/getCommitteePageList?pageIndex=1&pageSize=100", { operation: "read" });
  if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Parent committee query failed");
  return apiRows(response.json);
}

async function parentMembers(context: ToolContext, id: string): Promise<any[]> {
  const response = await context.session.call(`/basic/parentsOversightCommittee/getCommitteeMemberList?committeeId=${encodeURIComponent(id)}`, { operation: "read" });
  if (!apiSucceeded(response.json)) throw new Error(response.json?.info ?? "Parent committee member query failed");
  return Array.isArray(response.json?.data) ? response.json.data : apiRows(response.json);
}

const dietMemberSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), name: z.string().min(1),
  position: z.union([z.number().int().min(1).max(3), z.enum(["主任", "副主任", "成员"])]),
  representType: z.union([z.number().int().min(1).max(7), z.enum(["教师代表", "家长代表", "社区代表", "学生代表", "学校代表", "食堂代表", "食安管理员"])]).optional(),
  gender: z.union([z.number().int().min(1).max(2), z.enum(["男", "女"])]).optional(), phone: z.string().optional(), remark: z.string().optional(),
});
const parentMemberSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), name: z.string().min(1),
  position: z.string().refine((value) => PARENT_POSITIONS.includes(value)), phone: z.string().optional(), remark: z.string().optional(),
});

export const COMMITTEE_TOOLS: ToolDefinition[] = [
  {
    name: "get_committee",
    effect: "read",
    description: "查询膳食委员会或家长监督委员会任期和成员；可读取上届模板。",
    schema: { kind: z.enum(["diet", "parent"]), semester: z.string().optional(), withPrevMembers: z.boolean().optional().default(false) },
    async handler(args, context) {
      if (args.kind === "diet") {
        const terms = (await dietTerms(context)).filter((term) => !args.semester || term.committeeName === args.semester);
        let prevMembers: any[] | undefined;
        if (args.withPrevMembers) {
          const response = await context.session.call("/basic/dietCommittee/getLastSemesterData", { method: "POST", operation: "read", body: {} });
          prevMembers = Array.isArray(response.json?.data) ? response.json.data : [];
        }
        const semesters = await context.session.call("/basic/dietCommittee/selSemesterRange", { method: "POST", operation: "read", body: {} });
        return ok({ kind: "diet", terms, availableSemesters: semesters.json?.data ?? [], prevMembers });
      }
      const terms = (await parentTerms(context)).filter((term) => !args.semester || term.committeeName === args.semester);
      const detailed = [];
      for (const term of terms) detailed.push({ ...term, members: await parentMembers(context, String(term.id)) });
      let prevMembers: any[] | undefined;
      if (args.withPrevMembers) {
        const response = await context.session.call("/basic/parentsOversightCommittee/getCommitteeLastMemberList", { operation: "read" });
        prevMembers = Array.isArray(response.json?.data) ? response.json.data : [];
      }
      const canNew = await context.session.call("/basic/parentsOversightCommittee/getCanNew", { operation: "read" });
      return ok({ kind: "parent", terms: detailed, canNew: Boolean(canNew.json?.data?.canNew), prevMembers });
    },
  },
  {
    name: "save_committee",
    effect: "remote-write",
    description: "保存已有任期的委员会成员；confirm:false 仅预览，confirm:true 才写入并回查。",
    schema: { kind: z.enum(["diet", "parent"]), semester: z.string().optional(), members: z.array(z.unknown()).min(1), committeeId: z.union([z.string(), z.number()]).optional(), confirm: z.boolean().default(false) },
    async handler(args, context) {
      if (args.kind === "diet") {
        const parsed = z.array(dietMemberSchema).safeParse(args.members);
        if (!parsed.success) return err("Diet committee member validation failed", parsed.error.issues);
        if (!args.semester) return err("semester is required for a diet committee save");
        const members = parsed.data.map((member) => ({
          ...member,
          position: typeof member.position === "number" ? member.position : DIET_POSITIONS[member.position],
          representativeType: typeof member.representType === "number" ? member.representType : REPRESENTATIVES[member.representType ?? "家长代表"],
          gender: typeof member.gender === "number" ? member.gender : member.gender === "女" ? 2 : 1,
        }));
        if (args.confirm !== true) return ok({ action: "dry_run", kind: "diet", semester: args.semester, memberCount: members.length, members });
        const term = (await dietTerms(context)).find((item) => item.committeeName === args.semester);
        if (!term) return err("The target term does not exist; create the empty term in the official page first");
        const itemList = members.map((member, index) => ({
          dietCommitteeId: term.id, gender: member.gender, genderName: member.gender === 2 ? "女" : "男", phoneNo: member.phone ?? null,
          representativeType: member.representativeType, positionName: Object.keys(DIET_POSITIONS).find((key) => DIET_POSITIONS[key] === member.position) ?? "成员",
          representativeTypeName: Object.keys(REPRESENTATIVES).find((key) => REPRESENTATIVES[key] === member.representativeType) ?? "家长代表",
          name: member.name, id: member.id ?? null, position: member.position, remarks: member.remark ?? null, key: index + 1, birthDate: null, appointmentDate: null,
        }));
        const saved = await context.session.call("/basic/dietCommittee/updateInfo", { method: "POST", operation: "write", body: { ...term, itemList, key: 1 } });
        if (!apiSucceeded(saved.json)) return err("Diet committee save failed", saved.json?.info);
        await sleep(1800);
        let after: any;
        let passed = false;
        try {
          after = (await dietTerms(context)).find((item) => String(item.id) === String(term.id));
          const expected = itemList.map(({ name, position, representativeType, gender, phoneNo, remarks }) => ({ name, position, representativeType, gender, phoneNo, remarks }));
          passed = sameRecords(after?.itemList ?? [], expected);
        } catch { /* Report an accepted but unverified write. */ }
        return verifiedWrite("Diet committee write was accepted but verification failed", { action: "saved", kind: "diet" }, { passed, memberCount: after?.itemList?.length ?? 0 });
      }

      const parsed = z.array(parentMemberSchema).safeParse(args.members);
      if (!parsed.success) return err("Parent committee member validation failed", parsed.error.issues);
      if (parsed.data.length < 7) return err("A parent committee requires at least seven members");
      if (!parsed.data.some((member) => member.position === "召集人（组长）")) return err("A parent committee requires a leader");
      if (args.confirm !== true) return ok({ action: "dry_run", kind: "parent", semester: args.semester, memberCount: parsed.data.length, members: parsed.data });
      const terms = await parentTerms(context);
      const term = terms.find((item) => args.committeeId !== undefined ? String(item.id) === String(args.committeeId) : item.committeeName === args.semester);
      if (!term) return err("The target term does not exist; create it in the official page first");
      const existing = await parentMembers(context, String(term.id));
      const numericId = existing[0]?.committeeId ?? Number(term.id);
      const members = parsed.data.map((member, index) => {
        const matched = existing.find((item) => String(item.id) === String(member.id)) ?? existing.find((item) => item.name === member.name);
        return { id: member.id ?? matched?.id ?? null, committeeId: matched?.committeeId ?? numericId, name: member.name, phone: member.phone ?? "", position: member.position, remark: member.remark ?? "", key: index + 1 };
      });
      const committeeName = term.committeeName ?? args.semester;
      const payload = {
        ...term,
        positionA: members.filter((item) => item.position === "召集人（组长）").map((item) => item.name).join(""),
        positionB: members.filter((item) => item.position === "副组长").map((item) => item.name).join(""),
        positionC: members.filter((item) => item.position === "成员").map((item) => item.name).join("、"),
        key: 1, members, startTime: term.startDate ?? "", endTime: term.endDate ?? "", semesterString: committeeName,
        committeeId: numericId, isSemester: true, year: term.year ?? Number(String(committeeName).match(/(\d{4})/)?.[1] ?? new Date().getFullYear()),
        startDate: term.startDate ?? "", endDate: term.endDate ?? "", semesterType: term.semesterType ?? 2,
      };
      const saved = await context.session.call("/basic/parentsOversightCommittee/saveCommittee", { method: "POST", operation: "write", body: payload });
      if (!apiSucceeded(saved.json)) return err("Parent committee save failed", saved.json?.info);
      await sleep(1800);
      let after: any[] = [];
      let passed = false;
      try {
        after = await parentMembers(context, String(term.id));
        passed = sameRecords(after, members.map(({ id, committeeId, name, position, phone, remark }) => ({
          ...(id === null ? {} : { id }), committeeId, name, position, phone, remark,
        })));
      } catch { /* Report an accepted but unverified write. */ }
      return verifiedWrite("Parent committee write was accepted but verification failed", { action: "saved", kind: "parent" }, { passed, memberCount: after.length });
    },
  },
];
