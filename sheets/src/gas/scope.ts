/**
 * Branch scope of the person running the script (the Sheets analogue of the API's row-level security).
 *  - the "Xodimlar" tab says who belongs to which branch; a person listed with a branch sees and writes only that branch,
 *    anybody else (the owner, an unlisted editor) is center-wide;
 *  - a center-wide person may narrow the view to one branch (menu: Filiallar > Filialni tanlash), kept per user;
 *  - rows with an empty branch mark belong to the center's default branch (a workbook that predates branches works as
 *    one branch until "Boshlang'ich sozlash" adds the column).
 * The rules are in domain/branches.ts (golden tests). Honest limit: Google Sheets cannot hide cells from somebody who
 * opens the tab directly; the scope applies to the script (menus, reports, actions).
 */
import { resolveScope, stampBranch, type BranchId, type StampMode } from "../domain/branches";
import { decodeRows, type Cell } from "./codec";
import { BRANCHES, BRANCH_MARKED, STAFF, type TableDef } from "./schema";

export const DEFAULT_BRANCH = "F0001"; // the implicit branch of a workbook that has no "Filiallar" rows yet
const VIEW_KEY = "nazoratly.viewBranch";

export interface ScopeInfo {
  email: string;
  /** the branch this person works in (null = the whole center) */
  scope: BranchId | null;
  /** the branch of the person's staff row (null = center-wide) */
  member: BranchId | null;
  defaultId: BranchId;
  /** every known branch id, and the active ones */
  known: BranchId[];
  active: BranchId[];
}

interface BranchRow { id: string; name: string; address: string; status: "active" | "closed"; isDefault: boolean }
interface StaffRow { email: string; role: string; branchId: string }

let cached: ScopeInfo | null = null;
export const resetScope = (): void => {
  cached = null;
};

const fmt = (d: Date): string => Utilities.formatDate(d, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), "yyyy-MM-dd");

/** Reads a tab without any scope (the scope itself is built from these tabs). */
export function rawRead<T>(def: TableDef): T[] {
  const sh = SpreadsheetApp.getActive().getSheetByName(def.sheet);
  if (!sh || sh.getLastRow() < 1) return [];
  return decodeRows<T>(def, sh.getDataRange().getValues() as Cell[][], fmt);
}

export function activeEmail(): string {
  try {
    const u = Session.getActiveUser().getEmail();
    if (u) return u.trim().toLowerCase();
  } catch {
    /* no permission to see the active user: fall through */
  }
  try {
    return Session.getEffectiveUser().getEmail().trim().toLowerCase();
  } catch {
    return "";
  }
}

export function branchRows(): BranchRow[] {
  return rawRead<BranchRow>(BRANCHES);
}

export function currentScope(): ScopeInfo {
  if (cached) return cached;
  const branches = branchRows();
  const live = branches.filter((b) => b.id);
  const defaultId = live.find((b) => b.isDefault && b.status === "active")?.id ?? live.find((b) => b.status === "active")?.id ?? live[0]?.id ?? DEFAULT_BRANCH;
  const known = live.length ? live.map((b) => b.id) : [DEFAULT_BRANCH];
  const active = live.length ? live.filter((b) => b.status === "active").map((b) => b.id) : [DEFAULT_BRANCH];
  const email = activeEmail();
  const staff = rawRead<StaffRow>(STAFF).find((s) => s.email.trim().toLowerCase() === email && email !== "");
  const member = staff && staff.branchId ? staff.branchId : null;
  let requested: string | null = null;
  try {
    requested = PropertiesService.getUserProperties().getProperty(VIEW_KEY) || null;
  } catch {
    requested = null;
  }
  const decided = resolveScope({ memberBranch: member, requested, known });
  cached = { email, scope: decided.error ? member : decided.scope, member, defaultId, known, active };
  return cached;
}

/** For work on the whole center (ledger chain, branch administration): staff of one branch may not do it. */
export function requireCenterWide(what: string): void {
  if (currentScope().member) throw new Error(`${what}: faqat butun markaz xodimlari (filialga biriktirilmaganlar) bajaradi.`);
}

/** Remembers (or with null forgets) the branch a center-wide person looks at. */
export function setViewBranch(id: BranchId | null): void {
  const props = PropertiesService.getUserProperties();
  if (id === null) props.deleteProperty(VIEW_KEY);
  else props.setProperty(VIEW_KEY, id);
  resetScope();
}

// ---- stamping -----------------------------------------------------------------------------------------------------
interface Rule {
  mode: StampMode;
  /** parent tables the mark can follow, in order: [table, key of the parent in this row] */
  parents: [TableDef, string][];
}
const rules = new Map<string, Rule>();
export function registerBranchRule(def: TableDef, rule: Rule): void {
  rules.set(def.sheet, rule);
}
export const isMarked = (def: TableDef): boolean => BRANCH_MARKED.includes(def) || def.cols.some((c) => c.key === "branchId");
export const ruleOf = (def: TableDef): Rule => rules.get(def.sheet) ?? { mode: "context", parents: [] };

/** The branch of a row about to be written: explicit > scope/parent (by the table's mode) > the default branch. */
export function stampOf(def: TableDef, row: Record<string, unknown>, parentBranch: (parent: TableDef, key: string) => string | null): BranchId {
  const info = currentScope();
  const rule = ruleOf(def);
  let parent: string | null = null;
  for (const [table, key] of rule.parents) {
    const id = String(row[key] ?? "");
    if (!id) continue;
    parent = parentBranch(table, id);
    if (parent) break;
  }
  const explicit = typeof row.branchId === "string" && row.branchId !== "" ? row.branchId : null;
  return stampBranch({ explicit, scope: info.scope, parent, default: info.defaultId, mode: rule.mode });
}

// ---- how each marked table gets its branch (the same chain as the database's branch_catalog) ----------------------------
import {
  ATTENDANCE, BILL_PAYMENTS, CERTIFICATES, CHARGES, DISCOUNTS, DISCOUNT_LINES, DOCUMENTS, DRAFTS, ENROLLMENTS, ENTITLEMENTS, EXAMS,
  EXAM_RESULTS, GROUPS, INSTALLMENTS, LEADS, LEAD_LOG, MARKS, PACKAGES, PAYMENTS, PAYROLL, PROMO_USES, REFERRALS, REFUNDS, REPORTS,
  SCHEDULE_CHANGES, STUDENTS, SUPPLIER_BILLS, TEACHERS, WAITLIST,
} from "./schema";

const follow = (def: TableDef, ...parents: [TableDef, string][]): void => registerBranchRule(def, { mode: "parent", parents });
const desk = (def: TableDef, ...parents: [TableDef, string][]): void => registerBranchRule(def, { mode: "context", parents });
desk(LEADS, [STUDENTS, "studentId"]);
follow(ENROLLMENTS, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(ATTENDANCE, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(CHARGES, [ENROLLMENTS, "enrollmentId"], [STUDENTS, "studentId"]);
follow(INSTALLMENTS, [CHARGES, "chargeId"]);
follow(DISCOUNT_LINES, [CHARGES, "chargeId"], [STUDENTS, "studentId"]);
follow(DISCOUNTS, [STUDENTS, "studentId"]);
follow(PACKAGES, [STUDENTS, "studentId"]);
follow(ENTITLEMENTS, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(WAITLIST, [GROUPS, "groupId"]);
follow(SCHEDULE_CHANGES, [GROUPS, "groupId"]);
follow(EXAMS, [GROUPS, "groupId"]);
follow(EXAM_RESULTS, [EXAMS, "examId"]);
follow(MARKS, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(REPORTS, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(CERTIFICATES, [GROUPS, "groupId"], [STUDENTS, "studentId"]);
follow(REFERRALS, [STUDENTS, "referrerId"], [STUDENTS, "invitedId"]);
follow(PROMO_USES, [STUDENTS, "studentId"]);
follow(DRAFTS, [STUDENTS, "studentId"]);
follow(DOCUMENTS, [PAYMENTS, "paymentId"], [STUDENTS, "studentId"]);
follow(PAYROLL, [TEACHERS, "teacherId"]);
follow(LEAD_LOG, [LEADS, "leadId"]);
desk(PAYMENTS, [STUDENTS, "studentId"]);
desk(REFUNDS, [PAYMENTS, "paymentId"], [STUDENTS, "studentId"]);
desk(BILL_PAYMENTS, [SUPPLIER_BILLS, "billId"]);
