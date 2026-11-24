import { vi } from "vitest";
import { handlers } from "../../src/Code";
import { read } from "../../src/gas/repo";
import { SETTINGS_SHEET, STUDENTS, GROUPS, ENROLLMENTS, TEACHERS } from "../../src/gas/schema";
import { append } from "../../src/gas/repo";
import { setupWorkbook } from "../../src/gas/setup";
import type { Enrollment, Group, Student, Teacher } from "../../src/domain/types";
import { installHarness, type Harness } from "../harness";

export const NOW = "2026-11-23T08:00:00Z"; // Monday 2026-11-23 (Tashkent noon)
export const TODAY = "2026-11-23";

/** A fresh in-memory workbook, "Boshlang'ich sozlash" run, clock fixed. */
export function boot(now = NOW): Harness {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const h = installHarness();
  setupWorkbook();
  return h;
}

export interface Run { alerts: { title: string; message: string }[]; last: string; all: string }

/**
 * What the owner does: click a menu item. `answers` are the prompt boxes in order; YES/NO confirmations (ui.alert) are
 * answered through h.answers (default YES). Returns the dialogs that appeared. Errors are shown as dialogs by guard().
 */
export function drive(h: Harness, fn: string, ...answers: string[]): Run {
  const handler = handlers[fn];
  if (typeof handler !== "function") throw new Error(`no menu handler ${fn}`);
  const before = h.alerts.length;
  h.prompts.splice(0, h.prompts.length, ...answers);
  handler();
  const left = h.prompts.length;
  h.prompts.length = 0;
  if (left) throw new Error(`${fn}: ${left} prepared answer(s) were never asked for (prompt order changed?)`);
  const alerts = h.alerts.slice(before);
  return { alerts, last: alerts.at(-1)?.message ?? "", all: alerts.map((a) => a.message).join("\n") };
}

export function setSetting(h: Harness, label: string, value: string): void {
  const row = h.sheets.get(SETTINGS_SHEET)!.data.find((r) => r[0] === label);
  if (!row) throw new Error(`no setting "${label}"`);
  row[1] = value;
}

let counter = 0;
export const teacher = (extra: Partial<Teacher> = {}): Teacher => ({ id: "T0001", fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active", ...extra });
export const group = (extra: Partial<Group> = {}): Group => ({ id: "G0001", name: "IELTS", teacherId: "T0001", monthlyFee: 500_000, status: "active", ...extra });
export const student = (id: string, extra: Partial<Student> = {}): Student => ({ id, fullName: `Student ${id}`, status: "active", guardianName: "", guardianChatId: "", consentNotify: false, ...extra });
export const enrollment = (id: string, studentId: string, extra: Partial<Enrollment> = {}): Enrollment => ({ id, studentId, groupId: "G0001", startedOn: "2026-09-01", endedOn: "", discountPercent: 0, status: "active", ...extra });

/** The owner typing rows into the sheets by hand (there is no "add student" menu: the sheet is the form). */
export function seedClass(opts: { students: Student[]; groups?: Group[]; enrollments?: Enrollment[]; teachers?: Teacher[] }): void {
  append(TEACHERS, opts.teachers ?? [teacher()]);
  append(GROUPS, opts.groups ?? [group()]);
  append(STUDENTS, opts.students);
  append(ENROLLMENTS, opts.enrollments ?? opts.students.map((s, i) => enrollment(`E${String(i + 1).padStart(4, "0")}`, s.id)));
  counter++;
}
export const rows = <T>(def: Parameters<typeof read>[0]): T[] => read<T>(def);
void counter;
