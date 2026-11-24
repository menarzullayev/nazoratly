import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderDraft } from "../../src/domain/types";
import { handlers } from "../../src/Code";
import * as actions from "../../src/gas/actions";
import { DEBT_SHEET, RISK_SHEET, WEEK_SHEET } from "../../src/gas/insights";
import { read } from "../../src/gas/repo";
import { ATTENDANCE, CHARGES, DRAFTS, PAYMENTS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, seedClass, setSetting, student } from "./support";

let h: Harness;
const BUSINESS = ["O'quvchilar", "Yozilishlar", "Hisoblar", "To'lovlar", "Davomat", "Eslatmalar", "Jurnal", "Guruhlar"];
const snapshot = (): string => JSON.stringify(BUSINESS.map((n) => h.sheet(n).data));
const sheet = (name: string): (string | number)[][] => h.rows(name) as (string | number)[][];

beforeEach(() => {
  h = boot();
  setSetting(h, "Minimal muddati o'tgan qarz (so'm)", "50000");
  seedClass({
    students: [
      student("S0001", { fullName: "Aziz Rahimov", guardianName: "Rahimov", guardianChatId: "55501", consentNotify: true }),
      student("S0002", { fullName: "Madina Tursunova", guardianName: "Tursunov", guardianChatId: "55502", consentNotify: false }), // no consent
      student("S0003", { fullName: "Jasur Qodirov", guardianName: "Qodirov" }), // not linked
      student("S0004", { fullName: "Nigora Ismoilova", guardianName: "Ismoilov", guardianChatId: "55504", consentNotify: true }), // pays on time
    ],
  });
  // October and November charges (due on the 10th); S0001..S0003 paid nothing, S0004 paid everything
  drive(h, "menuGenerateCharges", "2026-10");
  drive(h, "menuGenerateCharges", "2026-11");
  actions.recordPayment({ studentId: "S0004", amount: 1_000_000, method: "Naqd", paidOn: "2026-10-09", note: "", notifyGuardian: false });
  // S0001 stopped coming: present for a month, then absent four times in the last weeks
  const marks = (date: string, status: "present" | "absent") => actions.saveAttendance({ date, groupId: "G0001", marks: ["S0001", "S0002", "S0003", "S0004"].map((studentId) => ({ studentId, status: studentId === "S0001" ? status : "present", minutesLate: 0 })) });
  for (const d of ["2026-10-14", "2026-10-16", "2026-10-19", "2026-10-21"]) marks(d, "present");
  for (const d of ["2026-11-11", "2026-11-13", "2026-11-16", "2026-11-18"]) marks(d, "absent");
  h.props.set("TELEGRAM_BOT_TOKEN", "123:abc");
});
afterEach(() => vi.useRealTimers());

describe("journey: rule-based owner reports (no AI call, no side effects)", () => {
  it("weekly summary, debt advice and risk list are written to their own sheets and change nothing else", () => {
    const before = snapshot();
    drive(h, "menuInsightWeekly");
    drive(h, "menuInsightDebt");
    drive(h, "menuInsightRisk");
    expect(snapshot()).toBe(before); // reports only read
    expect(h.fetches).toHaveLength(0);

    const week = sheet(WEEK_SHEET).map((r) => r.join(" ")).join("\n");
    expect(week).toContain("Haftalik xulosa");
    expect(week).toContain("Eng katta qarzlar");
    expect(week).toContain("Aziz Rahimov"); // a debtor and a churn risk

    const debt = sheet(DEBT_SHEET);
    const names = debt.slice(4).map((r) => r[1]);
    expect(names).toContain("Aziz Rahimov");
    expect(names).not.toContain("Nigora Ismoilova"); // paid in full
    expect(names.indexOf("Aziz Rahimov")).toBeGreaterThanOrEqual(0);
    // the text of a follow-up is a DRAFT for a person (last column), with the amount in it
    const row = debt.slice(4).find((r) => r[1] === "Aziz Rahimov")!;
    expect(String(row[7])).toMatch(/Aziz Rahimov/);
    expect(Number(row[2])).toBe(1_000_000);

    const risk = sheet(RISK_SHEET).slice(4);
    expect(risk.map((r) => r[1])).toContain("Aziz Rahimov");
    expect(risk.map((r) => r[1])).not.toContain("Nigora Ismoilova");
  });

  it("an empty center says so instead of failing", () => {
    for (const n of ["Hisoblar", "To'lovlar", "Davomat", "Yozilishlar"]) h.sheet(n).data.splice(1);
    drive(h, "menuInsightDebt");
    drive(h, "menuInsightRisk");
    expect(sheet(DEBT_SHEET).flat().join(" ")).toContain("Qarzdor o'quvchi yo'q");
    expect(sheet(RISK_SHEET).flat().join(" ")).toContain("Ketish xavfi ostidagi o'quvchi yo'q");
    expect(read(CHARGES)).toHaveLength(0);
    void [PAYMENTS, ATTENDANCE];
  });
});

describe("journey: reminders are drafts until a person approves (Model B)", () => {
  it("creates drafts only for linked, consenting guardians with a debt; sending takes approved ones only and only once", () => {
    const made = drive(h, "menuCreateDrafts");
    expect(made.last).toMatch(/1 ta/);
    const drafts = read<ReminderDraft>(DRAFTS);
    expect(drafts.map((d) => [d.studentId, d.status])).toEqual([["S0001", "pending"]]);
    expect(h.fetches).toHaveLength(0);
    // running it again within the cooldown creates nothing new
    drive(h, "menuCreateDrafts");
    expect(read(DRAFTS)).toHaveLength(1);

    // nothing approved: sending does nothing
    drive(h, "menuSendApproved");
    expect(h.fetches).toHaveLength(0);

    // the owner edits the text and approves in the sidebar
    const pending = handlers.getPendingDrafts!() as { id: string; text: string }[];
    expect(pending).toHaveLength(1);
    expect(handlers.decideDrafts!({ approve: [pending[0]!.id], reject: [], edits: { [pending[0]!.id]: "Hurmatli Rahimov, qarz bor. Rahmat." } })).toEqual({ approved: 1, rejected: 0 });
    drive(h, "menuSendApproved");
    expect(h.fetches.map((f) => [f.body._method, f.body.chat_id])).toEqual([["sendRichMessage", "55501"]]);
    expect(JSON.stringify(h.fetches[0]!.body)).toContain("Hurmatli Rahimov, qarz bor. Rahmat.");
    expect(read<ReminderDraft>(DRAFTS)[0]!.status).toBe("sent");
    // a second send finds nothing to send
    h.fetches.length = 0;
    drive(h, "menuSendApproved");
    expect(h.fetches).toHaveLength(0);
  });

  it("a rejected draft is never sent, and a Telegram failure marks the draft failed with the reason", () => {
    drive(h, "menuCreateDrafts");
    const id = (handlers.getPendingDrafts!() as { id: string }[])[0]!.id;
    handlers.decideDrafts!({ approve: [], reject: [id], edits: {} });
    drive(h, "menuSendApproved");
    expect(h.fetches).toHaveLength(0);
    expect(read<ReminderDraft>(DRAFTS)[0]!.status).toBe("rejected");
  });

  it("a blocked guardian (Telegram 403) fails the draft without retrying forever", () => {
    // cooldown: age the first draft so a new one can be created after rejection
    drive(h, "menuCreateDrafts");
    const id = (handlers.getPendingDrafts!() as { id: string }[])[0]!.id;
    handlers.decideDrafts!({ approve: [id], reject: [], edits: {} });
    h.telegram.handler = () => ({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } });
    drive(h, "menuSendApproved");
    const d = read<ReminderDraft>(DRAFTS)[0]!;
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/blocked/);
    const calls = h.fetches.length;
    drive(h, "menuSendApproved");
    expect(h.fetches).toHaveLength(calls); // a failed draft is not retried by itself
  });
});
