/** Plain data model shared by the pure domain logic and the Apps Script adapters. Dates are ISO strings (YYYY-MM-DD). */
export type ISODate = string;

export interface Student {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  fullName: string;
  status: "lead" | "active" | "paused" | "left";
  guardianName: string;
  guardianChatId: string; // Telegram chat id, empty until the guardian linked the bot
  consentNotify: boolean; // guardian agreed to Telegram notifications
  qrCode?: string; // attendance QR code (NZQ1-...), empty until the card was issued
  demo?: boolean; // sample row
}

export interface Group {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  name: string;
  teacherId: string;
  monthlyFee: number; // so'm, integer
  schedule?: string; // weekly schedule text, e.g. "Du-Chor-Ju 18:00"
  status: "planned" | "active" | "finished" | "cancelled";
  billingMode?: "monthly" | "package"; // "" in the sheet reads as monthly
  packageLessons?: number; // lessons in one package (package-billed groups)
  packagePrice?: number; // so'm for one package (package-billed groups)
  capacity?: number; // most students (trials count); empty = unlimited
  roomId?: string; // the room the group's lessons are held in (Xonalar sheet); empty = none
  demo?: boolean;
}

export interface Enrollment {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  groupId: string;
  startedOn: ISODate;
  endedOn: ISODate | "";
  discountPercent: number;
  status: "trial" | "active" | "frozen" | "finished";
  /** Set when a trial was accepted; months up to and including this month are not billed by the monthly run. */
  acceptedOn?: ISODate | "";
  firstMonthMode?: "full" | "prorated" | "free_until_next" | "";
  /** A trial that was dropped: its lessons were free and stay free. */
  droppedTrial?: boolean;
  demo?: boolean;
}

export interface Charge {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  enrollmentId: string;
  month: ISODate; // first day of the billed month
  amount: number;
  dueDate: ISODate;
  voided: boolean;
  note: string;
  grossAmount?: number; // fee before the lasting discounts (empty on older charges)
  earlyDiscount?: number; // so'm off when paid by earlyPayBy (0 = no offer)
  earlyPayBy?: ISODate | "";
  demo?: boolean;
}

export interface Payment {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  paidOn: ISODate;
  amount: number;
  method: string;
  voided: boolean;
  note: string;
  demo?: boolean;
}

export interface AttendanceRow {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  date: ISODate;
  groupId: string;
  studentId: string;
  status: "present" | "absent" | "late" | "excused";
  minutesLate: number;
  demo?: boolean;
}

export interface Teacher {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  fullName: string;
  payModel: "fixed" | "per_lesson" | "percent";
  payRate: number; // so'm per month / per lesson, or percent
  status: "active" | "inactive";
  demo?: boolean;
}

export interface ReminderDraft {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  createdOn: ISODate;
  text: string;
  status: "pending" | "approved" | "sent" | "rejected" | "failed";
  error: string;
}

export type LeadStage = "new" | "contacted" | "trial_scheduled" | "trial_attended" | "enrolled" | "lost";

export interface Lead {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  fullName: string;
  phone: string;
  source: string; // free text, "" when unknown
  stage: LeadStage;
  nextFollowUpOn: ISODate | "";
  note: string;
  createdOn: ISODate;
  studentId: string; // set when the lead was turned into a trial
  demo?: boolean;
}

export interface LeadLogRow {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  leadId: string;
  date: ISODate;
  kind: "call" | "message" | "meeting" | "trial" | "note";
  summary: string;
  nextFollowUpOn: ISODate | "";
}

export interface Entitlement {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  groupId: string;
  missedOn: ISODate;
  kind: "makeup" | "credit";
  amount: number;
  expiresOn: ISODate;
  status: "open" | "scheduled" | "used" | "cancelled";
  makeupOn: ISODate | "";
  usedOn: ISODate | "";
  appliedChargeId: string;
  lastMakeupOn: ISODate | "";
  /** where a credit comes from: an excused lesson (default), a referral reward or a promo code */
  source?: "absence" | "referral" | "promo";
  note?: string;
}

/** One invitation of a student by another; keeps the rule it was made under. */
export interface Referral {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  referrerId: string;
  invitedId: string;
  status: "pending" | "rewarded" | "cancelled";
  rewardType: "amount" | "percent" | "free_lesson";
  rewardValue: number;
  condition: "enrolled" | "paid";
  minPaid: number;
  rewardAmount: number;
  invitedOn: ISODate;
  rewardedOn: ISODate | "";
  note: string;
}

export interface Promo {
  code: string;
  name: string;
  kind: "percent" | "amount";
  value: number;
  validFrom: ISODate;
  validTo: ISODate | "";
  maxUses: number; // 0 = unlimited
  active: boolean;
}

export interface PromoUse {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  code: string;
  studentId: string;
  enrollmentId: string;
  fee: number;
  amount: number;
  usedOn: ISODate;
}

export interface SourceCostRow {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  source: string;
  month: ISODate;
  amount: number;
  note: string;
}

/** One dated part of a payment plan: a charge split into installments (sheet "To'lov rejalari"). */
export interface Installment {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  chargeId: string;
  seq: number;
  dueDate: ISODate;
  amount: number;
}

/** A lesson package sold to an enrollment (sheet "Abonementlar"): a charge plus lessons and an expiry. */
export interface Package {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  enrollmentId: string;
  chargeId: string;
  lessons: number;
  price: number;
  purchasedOn: ISODate;
  expiresOn: ISODate;
}

/** An operating expense (sheet "Xarajatlar"). Teacher pay is NOT recorded here: it comes from the payroll sheet. */
export interface Expense {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  date: ISODate;
  category: "rent" | "utilities" | "salary" | "marketing" | "equipment" | "tax" | "other";
  amount: number;
  note: string;
  voided: boolean;
  paidFrom?: "cash" | "bank"; // where the money left from (default cash)
  billId?: string; // set when the expense accrues a supplier bill
  demo?: boolean;
}

export interface WaitlistRow {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  groupId: string;
  studentId: string;
  joinedOn: ISODate;
  status: "waiting" | "enrolled" | "removed";
  note: string;
  demo?: boolean;
}

/** A lasting discount rule of one student (sheet "Chegirmalar"). The family discount is automatic (center settings). */
export interface StudentDiscount {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  enrollmentId: string; // "" = every tuition charge of the student
  kind: "individual" | "scholarship" | "early_pay";
  percent: number; // 0 = not a percent rule
  amount: number; // so'm off ONE charge; 0 = not an amount rule
  payByDay: number; // early_pay: the day of the billed month the money must arrive by
  reason: string;
  validFrom: ISODate;
  validTo: ISODate | ""; // "" = until ended
  demo?: boolean;
}

/** What a lasting discount took off one enrollment's month (sheet "Chegirma qatorlari"). */
export interface DiscountLineRow {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  studentId: string;
  enrollmentId: string;
  chargeId: string; // "" for a month that was completely free (no charge)
  month: ISODate;
  kind: "family" | "individual" | "scholarship" | "early_pay";
  sourceId: string; // the Chegirmalar rule, "" for the family discount
  percent: number;
  amount: number;
  reason: string;
  demo?: boolean;
}

/** A refund (sheet "Qaytarishlar"); append-only. */
export interface Refund {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  studentId: string;
  date: ISODate;
  kind: "wrong_payment" | "leaving" | "package_remainder" | "to_credit";
  payout: "cash" | "bank" | "credit";
  amount: number; // money that left (cash/bank) or became credit
  chargeReduction: number; // how much the tuition charge shrank
  chargeId: string;
  paymentId: string;
  packageId: string;
  leftOn: ISODate | "";
  reason: string;
  note: string;
  demo?: boolean;
}

/** A daily cash close (sheet "Kassa smenalari"); append-only. */
export interface CashClose {
  /** branch mark (Filial ID); empty = the default branch. Set by the adapter, never by domain code */
  branchId?: string;
  id: string;
  date: ISODate;
  shiftNo: number;
  counted: number;
  bookBalance: number;
  difference: number;
  note: string;
  journalSeq: number; // last journal line number when the close was made
  entryNo: number; // the journal entry that booked the difference (0 = none)
}
