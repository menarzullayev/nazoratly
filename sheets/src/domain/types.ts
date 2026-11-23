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
  status: "planned" | "active" | "finished" | "cancelled";
}

export interface Enrollment {
  id: string;
  studentId: string;
  groupId: string;
  startedOn: ISODate;
  endedOn: ISODate | "";
  discountPercent: number;
  status: "active" | "frozen" | "finished";
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
