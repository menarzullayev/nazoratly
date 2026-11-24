import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceRow, Entitlement, Student } from "../../src/domain/types";
import { qrLinkRequest } from "../../src/gas/guardian";
import { read, updateById } from "../../src/gas/repo";
import { ATTENDANCE, ENTITLEMENTS, GUARDIAN_LINKS, GUARDIAN_REQUESTS, STUDENTS } from "../../src/gas/schema";
import type { Harness } from "../harness";
import { boot, drive, enrollment, group, seedClass, student } from "./support";

let h: Harness;
beforeEach(() => {
  h = boot();
  seedClass({
    students: [student("S0001", { fullName: "Aziz", guardianName: "Rahimov", phone: "+998901234567" } as never), student("S0002", { fullName: "Madina", guardianName: "Tursunov" })],
    groups: [group({ schedule: "Du-Chor-Ju 18:00-19:30" }), group({ id: "G0002", name: "Matematika", schedule: "Se-Pay 17:00-18:30" })],
    enrollments: [enrollment("E0001", "S0001"), enrollment("E0002", "S0002")],
  });
});
afterEach(() => vi.useRealTimers());

type Req = { id: string; kind: string; status: string; studentId: string; note: string };
const requests = (): Req[] => read<Req>(GUARDIAN_REQUESTS);

describe("journey: guardian requests, owner side", () => {
  it("absence reported in advance: pending changes nothing, approval marks the lesson excused and opens a make-up right", () => {
    const rec = drive(h, "menuGuardianAbsence", "S0001", "G0001", "2026-11-25", "Isitma");
    expect(rec.alerts).toEqual([]);
    expect(requests().map((r) => [r.id, r.kind, r.status])).toEqual([["Q0001", "absence_reason", "pending"]]);
    expect(read(ATTENDANCE)).toEqual([]); // the request alone changes nothing
    // a second request for the same lesson is refused while the first waits
    expect(drive(h, "menuGuardianAbsence", "S0001", "G0001", "2026-11-25", "Yana").last).toMatch(/allaqachon kiritilgan/);

    drive(h, "menuGuardianApprove", "Q0001");
    expect(requests()[0]!.status).toBe("approved");
    expect(read<AttendanceRow>(ATTENDANCE).map((a) => [a.studentId, a.date, a.status])).toEqual([["S0001", "2026-11-25", "excused"]]);
    expect(read<Entitlement>(ENTITLEMENTS).filter((e) => e.studentId === "S0001").map((e) => [e.kind, e.status])).toEqual([["makeup", "open"]]);
    // deciding again is refused
    expect(drive(h, "menuGuardianApprove", "Q0001").last).toMatch(/allaqachon: approved/);
    expect(drive(h, "menuGuardianReject", "Q0001", "").last).toMatch(/allaqachon: approved/);
    expect(drive(h, "menuGuardianApprove", "Q0099").last).toMatch(/topilmadi/);
  });

  it("an absence for today or the past, a stranger's group, or without a reason is refused", () => {
    expect(drive(h, "menuGuardianAbsence", "S0001", "G0001", "2026-11-23", "Isitma").last).toContain("Dars kuni yoki");
    expect(drive(h, "menuGuardianAbsence", "S0001", "G0002", "2026-11-26", "Isitma").last).toContain("bu guruhda emas"); // not enrolled there
    expect(drive(h, "menuGuardianAbsence", "S0001", "G0001", "2026-11-25", " ").last).toContain("Sababni yozing");
    expect(requests()).toEqual([]);
  });

  it("rejecting keeps the reason and leaves the attendance alone", () => {
    drive(h, "menuGuardianAbsence", "S0002", "G0001", "2026-11-27", "Sayohat");
    drive(h, "menuGuardianReject", "Q0001", "Dars imtihon kuni");
    expect(requests().map((r) => [r.status, r.note])).toEqual([["rejected", "Dars imtihon kuni"]]);
    expect(read(ATTENDANCE)).toEqual([]);
  });

  it("payment promise needs a debt, a future date within the limit, and only one active promise", () => {
    expect(drive(h, "menuGuardianPromise", "S0001", "2026-11-30", "").last).toContain("Qarz yo'q"); // no debt yet: refused
    expect(requests()).toEqual([]);
    drive(h, "menuGenerateCharges", "2026-11");
    expect(drive(h, "menuGuardianPromise", "S0001", "2026-11-20", "").last).toContain("Sana o'tib ketgan"); // past date
    expect(drive(h, "menuGuardianPromise", "S0001", "2027-03-01", "").last).toContain("Sana juda uzoq"); // beyond 14 days
    drive(h, "menuGuardianPromise", "S0001", "2026-11-30", "200 000");
    expect(requests().map((r) => [r.kind, r.status])).toEqual([["payment_promise", "pending"]]);
    expect(drive(h, "menuGuardianPromise", "S0001", "2026-12-01", "").last).toContain("Kutilayotgan yoki amaldagi"); // one at a time
    drive(h, "menuGuardianApprove", "Q0001");
    expect(requests()[0]!.status).toBe("approved");
    // a promise does not pay anything
    expect(drive(h, "menuDebtors").alerts).toEqual([]);
  });
});

describe("journey: guardian links, owner side", () => {
  it("a QR-card link request waits for the owner; approving links the chat, rejecting leaves it unlinked", () => {
    drive(h, "menuQrIssue");
    const code = read<Student & { qrCode?: string }>(STUDENTS).find((s) => s.id === "S0001")!.qrCode!;
    expect(code).toBeTruthy();
    expect(qrLinkRequest("777001", "Ota", code)).toBe("pending");
    expect(qrLinkRequest("777001", "Ota", code)).toBe("pending"); // idempotent: still one request
    expect(qrLinkRequest("777002", "Notanish", "NOSUCHCODE")).toBe("unknown");
    expect(read<{ id: string; status: string; method: string }>(GUARDIAN_LINKS).map((l) => [l.id, l.method, l.status])).toEqual([["V0001", "qr", "pending"]]);
    expect(read<Student>(STUDENTS).find((s) => s.id === "S0001")!.guardianChatId).toBe("");

    drive(h, "menuGuardianLinkApprove", "V0001");
    expect(read<Student>(STUDENTS).find((s) => s.id === "S0001")!.guardianChatId).toBe("777001");
    expect(drive(h, "menuGuardianLinkApprove", "V0001").last).toMatch(/allaqachon: approved/);

    qrLinkRequest("777009", "Boshqa", code); // another chat on the same student
    const second = read<{ id: string; status: string }>(GUARDIAN_LINKS).find((l) => l.status === "pending")!;
    expect(drive(h, "menuGuardianLinkApprove", second.id).last).toMatch(/boshqa Telegram hisobiga ulangan/);
    drive(h, "menuGuardianLinkReject", second.id);
    expect(read<{ id: string; status: string }>(GUARDIAN_LINKS).find((l) => l.id === second.id)!.status).toBe("rejected");
    expect(read<Student>(STUDENTS).find((s) => s.id === "S0001")!.guardianChatId).toBe("777001");
  });

  it("manual link validates the chat id, refuses a chat used by another family, and consent is still the guardian's", () => {
    expect(drive(h, "menuGuardianLinkManual", "S0002", "abc").last).toMatch(/raqamlardan/);
    drive(h, "menuGuardianLinkManual", "S0002", "888001");
    const s = read<Student>(STUDENTS).find((x) => x.id === "S0002")!;
    expect([s.guardianChatId, s.consentNotify]).toEqual(["888001", false]); // linked, but no consent yet: nothing may be sent
    expect(drive(h, "menuGuardianLinkManual", "S0001", "888001").last).toMatch(/boshqa vasiyga/);
    expect(drive(h, "menuGuardianLinkManual", "S0002", "888002").last).toMatch(/boshqa Telegram hisobiga ulangan/);
    updateById(STUDENTS, "id", "S0002", { guardianChatId: "" });
    expect(h.fetches).toHaveLength(0);
  });
});
