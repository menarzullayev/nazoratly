/** Plain data model shared by the pure domain logic and the Apps Script adapters. Dates are ISO strings (YYYY-MM-DD). */
export type ISODate = string;

export interface Student {
  id: string;
  fullName: string;
  status: "lead" | "active" | "paused" | "left";
  guardianName: string;
  guardianChatId: string; // Telegram chat id, empty until the guardian linked the bot
  consentNotify: boolean; // guardian agreed to Telegram notifications
}

export interface Group {
  id: string;
  name: string;
  teacherId: string;
  monthlyFee: number; // so'm, integer
  schedule?: string; // weekly schedule text, e.g. "Du-Chor-Ju 18:00"
  status: "planned" | "active" | "finished" | "cancelled";
}

export interface Enrollment {
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
}

export interface Charge {
  id: string;
  studentId: string;
  enrollmentId: string;
  month: ISODate; // first day of the billed month
  amount: number;
  dueDate: ISODate;
  voided: boolean;
  note: string;
}

export interface Payment {
  id: string;
  studentId: string;
  paidOn: ISODate;
  amount: number;
  method: string;
  voided: boolean;
  note: string;
}

export interface AttendanceRow {
  date: ISODate;
  groupId: string;
  studentId: string;
  status: "present" | "absent" | "late" | "excused";
  minutesLate: number;
}

export interface Teacher {
  id: string;
  fullName: string;
  payModel: "fixed" | "per_lesson" | "percent";
  payRate: number; // so'm per month / per lesson, or percent
  status: "active" | "inactive";
}

export interface ReminderDraft {
  id: string;
  studentId: string;
  createdOn: ISODate;
  text: string;
  status: "pending" | "approved" | "sent" | "rejected" | "failed";
  error: string;
}

export type LeadStage = "new" | "contacted" | "trial_scheduled" | "trial_attended" | "enrolled" | "lost";

export interface Lead {
  id: string;
  fullName: string;
  phone: string;
  source: string; // free text, "" when unknown
  stage: LeadStage;
  nextFollowUpOn: ISODate | "";
  note: string;
  createdOn: ISODate;
  studentId: string; // set when the lead was turned into a trial
}

export interface LeadLogRow {
  leadId: string;
  date: ISODate;
  kind: "call" | "message" | "meeting" | "trial" | "note";
  summary: string;
  nextFollowUpOn: ISODate | "";
}
