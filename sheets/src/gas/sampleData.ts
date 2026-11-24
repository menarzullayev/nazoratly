/**
 * "Namuna ma'lumot yuklash": the demo data set. Every row carries the Demo flag ("Demo" column), so "Demo ma'lumotni tozalash"
 * can remove it again without touching real rows, and demo money is left out of the journal. Ids are taken after the
 * existing ones, so the sample can sit next to real data. Refuses to run when demo rows already exist.
 *
 * It shows every capability of the expansion: discounts and a refund, a cash close with a difference, rooms with a schedule
 * conflict and a substitute, a referral and promo codes, marks/exam/report/certificate, a second branch, a guardian link and
 * requests awaiting approval, a pending teacher invitation. A table the workbook does not have yet is skipped, so an older
 * workbook still loads the basic sample. All names, phones and chat ids are invented; no secret appears here.
 */
import { effectiveFee, planCharges } from "../domain/billing";
import { monthStart, prevMonthStart } from "../domain/dates";
import { nextIds } from "../domain/ids";
import { attendanceSummary, averageGrade, certificateNumber, newCertificateCode } from "../domain/results";
import { sha256Hex } from "../domain/sha256";
import type { AttendanceRow, Charge, Enrollment, Group, Student, StudentDiscount, Teacher } from "../domain/types";
import { ensureDefaultBranch } from "./branches";
import { hasDemoRows } from "./demo";
import { append, readIfPresent, today } from "./repo";
import { resetScope } from "./scope";
import {
  ATTENDANCE,
  BRANCHES,
  CASH_CLOSES,
  CERTIFICATES,
  CHARGES,
  DISCOUNT_LINES,
  DISCOUNTS,
  ENROLLMENTS,
  ENTITLEMENTS,
  EXAM_RESULTS,
  EXAMS,
  EXPENSES,
  GROUPS,
  GUARDIAN_LINKS,
  GUARDIAN_REQUESTS,
  LEADS,
  MARKS,
  PAYMENTS,
  PROMO_USES,
  PROMOS,
  REFERRALS,
  REFUNDS,
  REPORTS,
  ROOMS,
  SCHEDULE_CHANGES,
  SOURCE_COSTS,
  STUDENTS,
  TEACHER_INVITES,
  TEACHERS,
  WAITLIST,
  type TableDef,
} from "./schema";

const has = (def: TableDef): boolean => SpreadsheetApp.getActive().getSheetByName(def.sheet) !== null;
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (iso: string): number => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = Monday
/** An invented Telegram chat id for the pending guardian link: it belongs to nobody. */
const DEMO_CHAT = "100200300";

export function loadSampleData(): string {
  if (hasDemoRows()) throw new Error("Demo ma'lumot allaqachon yuklangan. Yangilash uchun 'Namuna ma'lumotni yangilash', olib tashlash uchun 'Demo ma'lumotni tozalash'.");
  const D = { demo: true } as const;
  const ids = (prefix: string, def: TableDef, n: number): string[] => nextIds(prefix, readIfPresent<{ id: string }>(def).map((r) => r.id), n);
  const now = today();
  const cur = monthStart(now);
  const prev1 = prevMonthStart(cur);
  const prev2 = prevMonthStart(prev1);
  const prev3 = prevMonthStart(prev2);
  const prev4 = prevMonthStart(prev3);
  const m = (month: string, day: number): string => `${month.slice(0, 7)}-${String(day).padStart(2, "0")}`;

  // branches: the default one plus "Chilonzor filiali" (rows of that branch follow it, see scope.ts)
  let chilonzor = "";
  if (has(BRANCHES)) {
    ensureDefaultBranch();
    chilonzor = ids("F", BRANCHES, 1)[0]!;
    append(BRANCHES, [{ id: chilonzor, name: "Chilonzor filiali", address: "Chilonzor tumani, Bunyodkor ko'chasi (namuna)", status: "active", isDefault: false, ...D }]);
    resetScope();
  }
  const inBranch = chilonzor ? { branchId: chilonzor } : {};
  const rIds = has(ROOMS) ? ids("X", ROOMS, 3) : ["", "", ""];
  if (has(ROOMS)) append(ROOMS, [{ id: rIds[0]!, name: "A xona", capacity: 12, ...D }, { id: rIds[1]!, name: "B xona", capacity: 10, ...D }, { id: rIds[2]!, name: "Chilonzor: 1-xona", capacity: 8, ...inBranch, ...D }]);

  // The first eight students, two groups and their money are the long-standing core of the sample (other tests and the site's story
  // rely on these numbers); the expansion is added beside it: a third teacher, the Chilonzor branch with two students (the discounts),
  // a finished summer course (the certificate).
  const tIds = ids("T", TEACHERS, 3);
  const gIds = ids("G", GROUPS, 4);
  const teachers: Teacher[] = [
    { id: tIds[0]!, fullName: "Dilnoza Karimova", payModel: "per_lesson", payRate: 90_000, status: "active", ...D },
    { id: tIds[1]!, fullName: "Sardor Aliyev", payModel: "percent", payRate: 40, status: "active", ...D },
    { id: tIds[2]!, fullName: "Malika Yusupova", payModel: "fixed", payRate: 3_500_000, status: "active", ...D },
  ];
  // IELTS and Matematika share room A and overlap 19:00-19:30 on the same days: the schedule check reports the conflict
  const groups: Group[] = [
    { id: gIds[0]!, name: "IELTS 6.5 (kechki)", teacherId: tIds[0]!, monthlyFee: 600_000, status: "active", capacity: 4, schedule: "Du-Chor-Ju 18:00-19:30", roomId: rIds[0]!, ...D },
    { id: gIds[1]!, name: "Matematika 9-sinf", teacherId: tIds[1]!, monthlyFee: 400_000, status: "active", capacity: 5, schedule: "Du-Chor-Ju 19:00-20:30", roomId: rIds[0]!, ...D },
    { id: gIds[2]!, name: "Ingliz tili A1 (Chilonzor)", teacherId: tIds[2]!, monthlyFee: 450_000, status: "active", capacity: 8, schedule: "Se-Pay-Sha 10:00-11:30", roomId: rIds[2]!, ...inBranch, ...D },
    { id: gIds[3]!, name: "Ingliz tili A2 (yozgi kurs)", teacherId: tIds[2]!, monthlyFee: 450_000, status: "finished", schedule: "Se-Pay 15:00-16:30", roomId: rIds[1]!, ...D },
  ];
  const names = ["Aziz Rahimov", "Madina Tursunova", "Jasur Qodirov", "Nigora Ismoilova", "Bobur Saidov", "Lola Xasanova", "Otabek Mirzaev", "Zarina Yusupova"];
  const waiting = ["Kamola Nurmatova", "Davron Sodiqov", "Feruza Olimova"];
  const branchNames = ["Sevinch Omonova", "Rustam Hamidov"];
  const sIds = ids("S", STUDENTS, names.length + waiting.length + branchNames.length);
  const person = (fullName: string, i: number, enrolled: boolean, more: Record<string, unknown> = {}): Student & Record<string, unknown> => ({
    id: sIds[i]!,
    fullName,
    status: enrolled ? "active" : "lead",
    guardianName: `${fullName.split(" ")[0]} ota-onasi`,
    guardianChatId: "",
    consentNotify: false,
    phone: enrolled ? `+99890123${String(4000 + i)}` : "",
    ...more,
    ...D,
  });
  const students = [...names, ...waiting].map((fullName, i) => person(fullName, i, i < names.length));
  const bs = branchNames.map((fullName, k) => person(fullName, names.length + waiting.length + k, true, inBranch));
  const eIds = ids("E", ENROLLMENTS, names.length + 3);
  const enrollments: Enrollment[] = names.map((_, i) => ({
    id: eIds[i]!,
    studentId: sIds[i]!,
    groupId: i % 2 === 0 ? gIds[0]! : gIds[1]!,
    startedOn: `${prev2.slice(0, 7)}-05`,
    endedOn: "",
    discountPercent: i === 3 ? 10 : 0,
    status: "active",
    ...D,
  }));
  const branchEnrollments: Enrollment[] = bs.map((st, k) => ({ id: eIds[names.length + k]!, studentId: st.id, groupId: gIds[2]!, startedOn: m(prev2, 5), endedOn: "", discountPercent: 0, status: "active", ...D }));
  // Rustam also finished the summer course earlier (the certificate below); it bills nothing in the months of the sample
  const finished: Enrollment = { id: eIds[names.length + 2]!, studentId: bs[1]!.id, groupId: gIds[3]!, startedOn: m(prev4, 5), endedOn: m(prev3, 28), discountPercent: 0, status: "finished", ...D };
  append(TEACHERS, teachers);
  append(GROUPS, groups);
  append(STUDENTS, [...students, ...bs]);
  append(ENROLLMENTS, [...enrollments, ...branchEnrollments, finished]);

  // lasting discounts of the two branch students: a scholarship (20%) and a one-month individual discount
  const discounts: StudentDiscount[] = [];
  if (has(DISCOUNTS)) {
    const dIds = ids("D", DISCOUNTS, 2);
    discounts.push(
      { id: dIds[0]!, studentId: bs[0]!.id, enrollmentId: branchEnrollments[0]!.id, kind: "scholarship", percent: 20, amount: 0, payByDay: 0, reason: "Olimpiada g'olibi: stipendiya", validFrom: m(prev2, 1), validTo: "", ...D },
      { id: dIds[1]!, studentId: bs[1]!.id, enrollmentId: branchEnrollments[1]!.id, kind: "individual", percent: 0, amount: 50_000, payByDay: 0, reason: "Oilaviy ahvol: bir oylik chegirma", validFrom: m(prev1, 1), validTo: m(prev1, 28), ...D },
    );
    append(DISCOUNTS, discounts);
  }

  const months = [prev2, prev1, cur];
  let charges: Charge[] = readIfPresent<Charge>(CHARGES);
  const before = charges.length;
  const demoStudents = students.slice(0, names.length);
  for (const month of months) {
    const plan = planCharges({ month, dueDay: 10, enrollments, groups, students: demoStudents, charges });
    const cids = nextIds("C", charges.map((c) => c.id), plan.create.length);
    charges = [...charges, ...plan.create.map((c, i) => ({ id: cids[i]!, studentId: c.studentId, enrollmentId: c.enrollmentId, month: c.month, amount: c.amount, dueDate: c.dueDate, voided: false, note: c.note, ...D }))];
  }
  const lineRows: Record<string, unknown>[] = [];
  for (const month of months) {
    const plan = planCharges({ month, dueDay: 10, enrollments: branchEnrollments, groups, students: bs, charges, discounts });
    const cids = nextIds("C", charges.map((c) => c.id), plan.create.length);
    charges = [...charges, ...plan.create.map((c, i) => ({ id: cids[i]!, studentId: c.studentId, enrollmentId: c.enrollmentId, month: c.month, amount: c.amount, grossAmount: c.grossAmount, earlyDiscount: 0, earlyPayBy: "", dueDate: c.dueDate, voided: false, note: c.note, ...inBranch, ...D }))];
    plan.create.forEach((c, i) => c.discounts.forEach((d) => lineRows.push({ studentId: c.studentId, enrollmentId: c.enrollmentId, chargeId: cids[i]!, month: c.month, kind: d.kind, sourceId: d.sourceId, percent: d.percent, amount: d.amount, reason: d.reason, ...D })));
  }
  const newCharges = charges.slice(before);
  append(CHARGES, newCharges);
  if (lineRows.length && has(DISCOUNT_LINES)) append(DISCOUNT_LINES, lineRows);
  // most pay on time, two are behind
  const payments = demoStudents.flatMap((s, i) => {
    const e = enrollments[i]!;
    const fee = effectiveFee(groups.find((g) => g.id === e.groupId)!, e);
    const paidMonths = i === 1 ? 1 : i === 4 ? 0 : i === 5 ? 2 : 3;
    return Array.from({ length: paidMonths }, (_, k) => ({
      id: "",
      studentId: s.id,
      paidOn: ((d) => (d > now ? now : d))(`${months[k]!.slice(0, 7)}-${String(8 + i).padStart(2, "0")}`),
      amount: fee,
      method: ["Naqd", "Karta", "Payme", "Click"][(i + k) % 4]!,
      voided: false,
      note: "",
      ...D,
    }));
  });
  // the branch students pay what they were billed (after the discounts); Sevinch pays last month twice by mistake (refunded below)
  const billed = (studentId: string, month: string): number => newCharges.find((c) => c.studentId === studentId && c.month === month)?.amount ?? 0;
  const branchPayments = bs.flatMap((st, k) =>
    months.map((month, j) => ({ id: "", studentId: st.id, paidOn: month === cur ? addDays(now, -1 - k) : m(month, 7 + k), amount: billed(st.id, month), method: ["Karta", "Payme", "Click"][(j + k) % 3]!, voided: false, note: "", ...inBranch, ...D })),
  );
  const dup = payments.length + branchPayments.length;
  branchPayments.push({ id: "", studentId: bs[0]!.id, paidOn: m(prev1, 20), amount: billed(bs[0]!.id, prev1), method: "Karta", voided: false, note: "Ikki marta o'tkazilgan (xato)", ...inBranch, ...D });
  const allPayments = [...payments, ...branchPayments];
  const pids = nextIds("P", readIfPresent<{ id: string }>(PAYMENTS).map((p) => p.id), allPayments.length);
  append(PAYMENTS, allPayments.map((p, i) => ({ ...p, id: pids[i]! })));

  const attendance: AttendanceRow[] = [];
  for (const day of [5, 12, 19].map((d) => m(prev1, d))) {
    for (const [i, s] of demoStudents.entries()) {
      const e = enrollments[i]!;
      const status = (i + day.length + Number(day.slice(-1))) % 7 === 0 ? "absent" : (i + Number(day.slice(-1))) % 5 === 0 ? "late" : "present";
      attendance.push({ date: day, groupId: e.groupId, studentId: s.id, status, minutesLate: status === "late" ? 10 : 0, ...D });
    }
  }
  append(ATTENDANCE, attendance);
  // sample expenses (only when the workbook already has the expenses sheet, i.e. after "Boshlang'ich sozlash")
  const xIds = nextIds("X", readIfPresent<{ id: string }>(EXPENSES).map((x) => x.id), months.length * 2);
  const expenseRows = has(EXPENSES)
    ? months
        .flatMap((mo, i) => [
          { id: xIds[i * 2]!, date: m(mo, 3), category: "rent", amount: 3_000_000, note: "Ijara (namuna)", voided: false, ...D },
          { id: xIds[i * 2 + 1]!, date: m(mo, 5), category: "utilities", amount: 450_000, note: "Kommunal (namuna)", voided: false, ...D },
        ])
        .filter((x) => x.date <= now)
    : [];
  append(EXPENSES, expenseRows);
  // leads and the waiting list (these sheets exist after "Boshlang'ich sozlash"; an older workbook simply skips them)
  let extra = "";
  if (has(LEADS)) {
    const lIds = ids("L", LEADS, 4);
    const leads = [["Sherzod Abdullayev", "new", "Instagram"], ["Mohira Ergasheva", "contacted", "Tanish"], ["Anvar Toshpulatov", "trial_scheduled", "Instagram"], ["Dildora Karimova", "lost", "Telegram"]] as const;
    append(LEADS, leads.map(([fullName, stage, source], i) => ({ id: lIds[i]!, fullName, phone: `+99893555${1000 + i}`, source, stage, nextFollowUpOn: "", note: "", createdOn: now, studentId: "", ...D })));
  }
  if (has(WAITLIST)) {
    const wIds = ids("W", WAITLIST, waiting.length);
    append(WAITLIST, waiting.map((_, i) => ({ id: wIds[i]!, groupId: i < 2 ? gIds[0]! : gIds[1]!, studentId: sIds[names.length + i]!, joinedOn: now, status: "waiting", note: "demo", ...D })));
    extra = ` (+${waiting.length} navbatda)`;
  }

  const shown: string[] = [];
  // ---- money: a refund of a double payment, a refund to credit, a cash close with a difference ----------------------------------
  if (has(REFUNDS)) {
    const rf = ids("R", REFUNDS, 2);
    append(REFUNDS, [
      { id: rf[0]!, studentId: bs[0]!.id, date: m(prev1, 22), kind: "wrong_payment", payout: "bank", amount: billed(bs[0]!.id, prev1), chargeReduction: 0, chargeId: "", paymentId: pids[dup]!, packageId: "", leftOn: "", reason: "Karta orqali ikki marta to'langan: ortiqchasi qaytarildi", note: "", ...D },
      { id: rf[1]!, studentId: bs[1]!.id, date: m(prev1, 25), kind: "to_credit", payout: "credit", amount: 100_000, chargeReduction: 0, chargeId: "", paymentId: "", packageId: "", leftOn: "", reason: "Oldindan ortiqcha to'lagan: keyingi hisobga kredit", note: "", ...D },
    ]);
    shown.push("qaytarishlar");
  }
  if (has(CASH_CLOSES)) {
    // demo money never enters the journal: the book balance is the sample's own number and no difference entry exists
    append(CASH_CLOSES, [{ id: ids("M", CASH_CLOSES, 1)[0]!, date: addDays(now, -1), shiftNo: 1, counted: 4_280_000, bookBalance: 4_300_000, difference: -20_000, note: "20 000 so'm kam chiqdi: qaytim xato berilgan, ertasi kassir bilan aniqlashtirildi", journalSeq: 0, entryNo: 0, ...D }]);
    shown.push("kassa smenasi (farq bilan)");
  }

  // ---- schedule: the room conflict is in the groups above; the substitute (free at that hour) is a recorded change ---------------------------------------
  if (has(SCHEDULE_CHANGES)) {
    let lesson = addDays(now, 1);
    while (![1, 3, 5].includes(weekdayOf(lesson))) lesson = addDays(lesson, 1);
    append(SCHEDULE_CHANGES, [{ id: ids("J", SCHEDULE_CHANGES, 1)[0]!, kind: "substitute", groupId: gIds[0]!, date: lesson, start: "18:00", newDate: "", newStart: "", newEnd: "", newRoomId: "", substituteId: tIds[2]!, reason: "Dilnoza Karimova konferensiyada: o'rniga Malika Yusupova", createdOn: now, payEffect: `Dilnoza Karimova ${lesson.slice(0, 7)}: -90000`, ...D }]);
    shown.push("xona to'qnashuvi va o'rinbosar");
  }

  // ---- growth: referrals (one rewarded, one waiting), promo codes, source costs --------------------------------------------------------
  if (has(REFERRALS)) {
    const fIds = ids("F", REFERRALS, 2);
    append(REFERRALS, [
      { id: fIds[0]!, referrerId: bs[0]!.id, invitedId: bs[1]!.id, status: "rewarded", rewardType: "amount", rewardValue: 50_000, condition: "paid", minPaid: 400_000, rewardAmount: 50_000, invitedOn: m(prev2, 3), rewardedOn: m(prev1, 12), note: "Do'sti tavsiya qildi", ...D },
      { id: fIds[1]!, referrerId: bs[1]!.id, invitedId: sIds[names.length]!, status: "pending", rewardType: "amount", rewardValue: 50_000, condition: "enrolled", minPaid: 0, rewardAmount: 0, invitedOn: addDays(now, -3), rewardedOn: "", note: "Navbatdagi Kamola: yozilganda mukofot", ...D },
    ]);
    shown.push("tavsiyalar");
  }
  if (has(ENTITLEMENTS)) {
    const cIds = ids("R", ENTITLEMENTS, 2);
    const credit = { groupId: "", missedOn: "", kind: "credit", expiresOn: addDays(now, 90), status: "open", makeupOn: "", usedOn: "", appliedChargeId: "", lastMakeupOn: "" } as const;
    append(ENTITLEMENTS, [
      { id: cIds[0]!, studentId: bs[0]!.id, amount: 50_000, source: "referral", note: "Tavsiya: Rustam Hamidov", ...credit, ...D },
      { id: cIds[1]!, studentId: bs[1]!.id, amount: 90_000, source: "promo", note: "KUZ20", ...credit, ...D },
    ]);
  }
  if (has(PROMOS)) {
    append(PROMOS, [
      { code: "KUZ20", name: "Kuz aksiyasi: birinchi oy -20%", kind: "percent", value: 20, validFrom: m(prev2, 1), validTo: addDays(now, 45), maxUses: 30, active: true, ...D },
      { code: "DOST100", name: "Do'stga 100 000 so'm", kind: "amount", value: 100_000, validFrom: m(prev2, 1), validTo: "", maxUses: 0, active: true, ...D },
    ]);
    if (has(PROMO_USES)) append(PROMO_USES, [{ code: "KUZ20", studentId: bs[1]!.id, enrollmentId: branchEnrollments[1]!.id, fee: 450_000, amount: 90_000, usedOn: m(prev2, 5), ...D }]);
    shown.push("promo kodlar");
  }
  if (has(SOURCE_COSTS)) {
    append(SOURCE_COSTS, [
      { source: "Instagram", month: prev1, amount: 1_500_000, note: "Reklama (namuna)", ...D },
      { source: "Telegram", month: prev1, amount: 600_000, note: "Kanal reklamasi (namuna)", ...D },
      { source: "Instagram", month: cur, amount: 1_800_000, note: "Reklama (namuna)", ...D },
    ]);
  }

  // ---- results: marks, an exam, reports with their real numbers (two approved, two drafts), a certificate --------------------------------
  if (has(MARKS)) {
    const ielts = [0, 2, 4, 6];
    const grades: Record<number, number[]> = { 0: [5, 5, 4], 2: [4, 4, 5], 4: [3, 4, 4], 6: [5, 4, 5] };
    const notes: Record<number, string> = { 0: "Speaking juda yaxshi, grammatikaga e'tibor kerak", 2: "Tinglab tushunishda o'sish bor", 4: "Uy vazifalarini vaqtida topshirsin", 6: "Faol, lug'at boyligi yaxshi" };
    const marks = ielts.flatMap((i) => [
      ...[5, 12, 19].map((d, k) => ({ scope: "lesson", date: m(prev1, d), groupId: gIds[0]!, studentId: sIds[i]!, grade: grades[i]![k]!, note: k === 2 ? notes[i]! : "", updatedOn: m(prev1, d) })),
      { scope: "month", date: prev1, groupId: gIds[0]!, studentId: sIds[i]!, grade: Math.round(grades[i]!.reduce((a, b) => a + b, 0) / 3), note: notes[i]!, updatedOn: m(prev1, 28) },
    ]);
    append(MARKS, marks.map((r) => ({ ...r, ...D })));
    if (has(EXAMS) && has(EXAM_RESULTS)) {
      const xid = ids("X", EXAMS, 1)[0]!;
      append(EXAMS, [{ id: xid, groupId: gIds[0]!, title: "IELTS mock test №1", heldOn: m(prev1, 26), maxScore: 100, ...D }]);
      const scores = [78, 91, 64, 85];
      append(EXAM_RESULTS, ielts.map((i, k) => ({ examId: xid, studentId: sIds[i]!, score: scores[k]!, note: k === 2 ? "Reading qismi qiyin bo'ldi" : "", ...D })));
    }
    if (has(REPORTS)) {
      const repIds = ids("R", REPORTS, ielts.length);
      append(
        REPORTS,
        ielts.map((i, k) => {
          const att = attendanceSummary(attendance.filter((a) => a.studentId === sIds[i] && a.groupId === gIds[0]).map((a) => a.status));
          const approved = k < 2;
          return { id: repIds[k]!, month: prev1, groupId: gIds[0]!, studentId: sIds[i]!, status: approved ? "approved" : "draft", percent: att.percent === null ? "" : String(att.percent), average: averageGrade(grades[i]!) ?? "", link: "", generatedOn: m(cur, 1), approvedOn: approved ? m(cur, 2) : "", ...D };
        }),
      );
    }
    if (has(CERTIFICATES)) {
      append(CERTIFICATES, [{ number: certificateNumber(Number(prev3.slice(0, 4)), 1), code: newCertificateCode([3, 7, 11, 15, 19, 23, 27, 31, 2, 6, 10, 14]), enrollmentId: finished.id, studentId: bs[1]!.id, groupId: gIds[3]!, courseName: "Ingliz tili A2 (yozgi kurs)", studentName: branchNames[1]!, issuedOn: m(prev3, 29), completedOn: m(prev3, 28), link: "", voided: false, voidReason: "", sentOn: "", ...D }]);
    }
    shown.push("baho, imtihon, hisobot, sertifikat");
  }

  // ---- guardian and teacher requests that wait for a person -------------------------------------------------------------------------------
  if (has(GUARDIAN_REQUESTS)) {
    const qIds = ids("Q", GUARDIAN_REQUESTS, 2);
    append(GUARDIAN_REQUESTS, [
      { id: qIds[0]!, kind: "payment_promise", studentId: sIds[1]!, groupId: "", date: "", entitlementId: "", reason: "Ish haqi 5-kuni tushadi", promiseDate: addDays(now, 3), amount: 400_000, status: "pending", createdOn: now, decidedOn: "", note: "", via: "Telegram", ...D },
      { id: qIds[1]!, kind: "absence_reason", studentId: sIds[4]!, groupId: gIds[0]!, date: addDays(now, -1), entitlementId: "", reason: "Isitmasi bor edi", promiseDate: "", amount: 0, status: "pending", createdOn: now, decidedOn: "", note: "", via: "Telegram", ...D },
    ]);
  }
  if (has(GUARDIAN_LINKS)) {
    append(GUARDIAN_LINKS, [{ id: ids("V", GUARDIAN_LINKS, 1)[0]!, studentId: sIds[2]!, chatId: DEMO_CHAT, name: "Qodirov (namuna)", method: "qr", status: "pending", createdOn: now, decidedOn: "", ...D }]);
    shown.push("vasiy so'rovlari va ulanishi (tasdiq kutmoqda)");
  }
  if (has(TEACHER_INVITES)) {
    // pending, but the code is nobody's: the hash matches no code format, so it can never be redeemed by accident
    append(TEACHER_INVITES, [{ id: ids("U", TEACHER_INVITES, 1)[0]!, teacherId: tIds[1]!, codeHash: sha256Hex("demo-invitation-not-redeemable"), status: "pending", expiresAt: `${addDays(now, 6)}T12:00`, createdOn: now, usedOn: "", ...D }]);
    shown.push("ustoz taklifnomasi");
  }
  const more = shown.length ? ` Qo'shimcha: ${shown.join(", ")}${chilonzor ? ", 2 ta filial" : ""}.` : "";
  return `Namuna: ${names.length} o'quvchi${extra}, ${groups.length} guruh, ${newCharges.length} hisob, ${allPayments.length} to'lov, ${attendance.length} davomat yozuvi.${more} Barcha qatorlar "Demo" belgili: pul yozuvlari jurnalga tushmaydi.`;
}
