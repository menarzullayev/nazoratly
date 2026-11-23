import { describe, expect, it } from "vitest";
import {
  DEMO_TODAY,
  addPayment,
  approve,
  consentingStudents,
  debtOf,
  guardianBalance,
  guardianInbox,
  teacherGroups,
  markAttendance,
  messageFor,
  openCharges,
  payrollOf,
  prepareReminders,
  seedState,
  type DemoState,
} from "@/demo/engine";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const fresh = (): DemoState => deepFreeze(seedState());

describe("seed", () => {
  it("matches the sheet's sample data", () => {
    const s = fresh();
    expect(DEMO_TODAY).toBe("2026-11-23");
    expect(s.students).toHaveLength(8);
    expect(debtOf(s, "S0005").outstanding).toBe(1_800_000);
    expect(debtOf(s, "S0005").overdue).toBe(1_800_000);
    expect(debtOf(s, "S0002").outstanding).toBe(800_000);
    expect(debtOf(s, "S0006").outstanding).toBe(400_000);
    expect(debtOf(s, "S0001").outstanding).toBe(0);
    expect(debtOf(s, "S0004").outstanding).toBe(0); // 10% discount student paid 3 x 360 000
  });
});

describe("payments", () => {
  it("clears the oldest charge first (FIFO)", () => {
    const s = fresh();
    const r = addPayment(s, "S0005", 600_000, "cash");
    expect(r.error).toBeUndefined();
    expect(debtOf(r.state, "S0005").outstanding).toBe(1_200_000);
    const open = openCharges(r.state, "S0005");
    expect(open).toHaveLength(2);
    expect(open[0]!.month).toBe("2026-10-01"); // September is cleared
  });

  it("an overpayment becomes credit, never negative debt", () => {
    const r = addPayment(fresh(), "S0005", 2_000_000, "card");
    const d = debtOf(r.state, "S0005");
    expect(d.outstanding).toBe(0);
    expect(d.credit).toBe(200_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e12])("rejects %s and leaves the state untouched", (amount) => {
    const s = fresh();
    const r = addPayment(s, "S0005", amount, "cash");
    expect(r.error).toBe("invalid_amount");
    expect(r.state).toBe(s);
  });

  it("rejects an unknown student", () => {
    const s = fresh();
    expect(addPayment(s, "S9999", 1000, "cash").error).toBe("invalid_amount");
  });
});

describe("attendance and payroll", () => {
  it("upserts one row per student and day", () => {
    let s = fresh();
    s = markAttendance(s, DEMO_TODAY, "G0001", "S0001", "absent");
    s = markAttendance(s, DEMO_TODAY, "G0001", "S0001", "present");
    const rows = s.attendance.filter((a) => a.date === DEMO_TODAY && a.studentId === "S0001");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("present");
  });

  it("a per-lesson teacher earns rate x held lessons; marking today adds a lesson", () => {
    const s = fresh();
    expect(payrollOf(s, "T0001").total).toBe(3 * 90_000);
    const s2 = markAttendance(s, DEMO_TODAY, "G0001", "S0001", "present");
    expect(payrollOf(s2, "T0001").total).toBe(4 * 90_000);
    expect(payrollOf(s2, "T0001").heldLessons).toBe(4);
  });

  it("a percent teacher earns a share of the tuition collected this month", () => {
    const p = payrollOf(fresh(), "T0002");
    expect(p.collectedTuition).toBe(760_000);
    expect(p.total).toBe(304_000);
  });
});

describe("reminders", () => {
  it("drafts only for debtors with consent and explains every skip", () => {
    const s = prepareReminders(fresh());
    expect(s.drafts.map((d) => d.studentId).sort()).toEqual(["S0002", "S0005"]);
    expect(s.skipped).toEqual([{ studentId: "S0006", reason: "no_consent" }]);
  });

  it("approval renders the rich message with the name and the total", () => {
    let s = prepareReminders(fresh());
    const draft = s.drafts.find((d) => d.studentId === "S0005")!;
    s = approve(s, draft.id);
    const html = messageFor(s, draft.id)!;
    expect(html).toContain("Bobur Saidov");
    expect(html).toContain("Jami qoldiq: 1 800 000");
    expect(s.drafts.find((d) => d.id === draft.id)!.status).toBe("sent");
  });

  it("a message exists only after approval", () => {
    const s = prepareReminders(fresh());
    expect(messageFor(s, s.drafts[0]!.id)).toBeNull();
  });

  it("does not re-draft a student that was just reminded (cooldown)", () => {
    let s = prepareReminders(fresh());
    s = approve(s, s.drafts.find((d) => d.studentId === "S0005")!.id);
    const again = prepareReminders(s);
    expect(again.skipped.some((x) => x.studentId === "S0005" && x.reason === "cooldown")).toBe(true);
  });
});

describe("roles", () => {
  it("a teacher sees only the groups they lead", () => {
    const s = fresh();
    expect(teacherGroups(s, "T0001").map((g) => g.id)).toEqual(["G0001"]);
    expect(teacherGroups(s, "T0002").map((g) => g.id)).toEqual(["G0002"]);
    expect(teacherGroups(s, "T9999")).toEqual([]);
  });

  it("only guardians who linked the bot and consented can be messaged", () => {
    expect(consentingStudents(fresh()).map((x) => x.id)).toEqual(["S0002", "S0005"]);
  });

  it("the guardian balance shows the child own debt and nobody else", () => {
    const s = fresh();
    const html = guardianBalance(s, "S0005");
    expect(html).toContain("Bobur Saidov");
    expect(html).toContain("1 800 000");
    expect(html).not.toContain("Madina Tursunova");
    expect(guardianBalance(s, "S0001")).toContain("Qarz yo'q");
    expect(guardianBalance(s, "nope")).toContain("topilmadi");
  });

  it("the balance follows a payment", () => {
    const paid = addPayment(fresh(), "S0005", 600_000, "cash").state;
    expect(guardianBalance(paid, "S0005")).toContain("1 200 000");
  });

  it("the guardian inbox holds only reminders the owner approved for that child", () => {
    let s = prepareReminders(fresh());
    expect(guardianInbox(s, "S0005")).toEqual([]);
    s = approve(s, s.drafts.find((d) => d.studentId === "S0005")!.id);
    expect(guardianInbox(s, "S0005")).toHaveLength(1);
    expect(guardianInbox(s, "S0005")[0]).toContain("Jami qoldiq");
    expect(guardianInbox(s, "S0002")).toEqual([]);
  });
});
