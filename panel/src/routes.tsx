/** Every staff screen: its address, its menu entry and what a person needs to see it. The menu and the address guard
 * read the same list, so a screen the menu hides also refuses to open by address. The server enforces the real rules. */

import type { ReactElement } from "react";
import type { Key } from "./i18n/core";
import { AccountPage } from "./screens/account";
import { CoursesPage, GuardiansPage, RoomsPage, TeachersPage } from "./screens/academics";
import { CalendarPage, NoticesPage, ScheduleChecksPage } from "./screens/calendar";
import { DashboardPage } from "./screens/dashboard";
import { ChargesPage, DebtorsPage, ExpensesPage, PaymentPage, PaymentsPage, ReportsPage } from "./screens/finance";
import { GroupPage, GroupsPage } from "./screens/groups";
import { ImportPage } from "./screens/import";
import { AbsencesPage, LessonPage, LessonsPage } from "./screens/lessons";
import { BranchesPage, OrganizationPage, StaffPage } from "./screens/org";
import { ScanPage } from "./screens/scan";
import { StudentPage, StudentsPage } from "./screens/students";
import { NotificationsPage, TeacherGroupsPage, TeacherHomePage, TeacherLessonsPage, TeacherMessagesPage, TeacherPayPage } from "./screens/teacher";

export type Section = "work" | "mine" | "study" | "money" | "center";

export interface Screen {
  path: string;
  title: Key;
  element: () => ReactElement;
  /** every one of these permissions */
  needs?: string[];
  /** only for this role: the /v1/teacher routes answer only to a signed-in teacher */
  role?: "teacher";
  menu?: Section;
}

export const SCREENS: Screen[] = [
  { path: "/dashboard", title: "nav.dashboard", element: () => <DashboardPage />, needs: ["reports:read"], menu: "work" },
  { path: "/teacher", title: "nav.teacherHome", element: () => <TeacherHomePage />, role: "teacher", menu: "mine" },
  { path: "/teacher/lessons", title: "teacher.myLessons", element: () => <TeacherLessonsPage />, role: "teacher", menu: "mine" },
  { path: "/teacher/groups", title: "nav.myGroups", element: () => <TeacherGroupsPage />, role: "teacher", menu: "mine" },
  { path: "/teacher/pay", title: "nav.myPay", element: () => <TeacherPayPage />, role: "teacher", menu: "mine" },
  { path: "/teacher/messages", title: "nav.myMessages", element: () => <TeacherMessagesPage />, role: "teacher", menu: "mine" },
  { path: "/calendar", title: "nav.calendar", element: () => <CalendarPage />, needs: ["academics:read"], menu: "work" },
  { path: "/scan", title: "nav.scan", element: () => <ScanPage />, needs: ["attendance:write", "academics:read"], menu: "work" },
  { path: "/notifications", title: "nav.notifications", element: () => <NotificationsPage />, needs: ["org:read"], menu: "work" },

  { path: "/students", title: "nav.students", element: () => <StudentsPage />, needs: ["students:read"], menu: "study" },
  { path: "/students/:id", title: "common.student", element: () => <StudentPage />, needs: ["students:read"] },
  { path: "/guardians", title: "nav.guardians", element: () => <GuardiansPage />, needs: ["students:read"], menu: "study" },
  { path: "/groups", title: "nav.groups", element: () => <GroupsPage />, needs: ["academics:read"], menu: "study" },
  { path: "/groups/:id", title: "common.group", element: () => <GroupPage />, needs: ["academics:read"] },
  { path: "/courses", title: "nav.courses", element: () => <CoursesPage />, needs: ["academics:read"], menu: "study" },
  { path: "/teachers", title: "nav.teachers", element: () => <TeachersPage />, needs: ["academics:read"], menu: "study" },
  { path: "/rooms", title: "nav.rooms", element: () => <RoomsPage />, needs: ["academics:read"], menu: "study" },
  { path: "/lessons", title: "nav.lessons", element: () => <LessonsPage />, needs: ["academics:read"], menu: "study" },
  { path: "/lessons/:id", title: "lessons.one", element: () => <LessonPage />, needs: ["academics:read"] },
  { path: "/absences", title: "nav.absences", element: () => <AbsencesPage />, needs: ["attendance:read", "students:read"], menu: "study" },
  { path: "/schedule-checks", title: "nav.scheduleChecks", element: () => <ScheduleChecksPage />, needs: ["academics:write"], menu: "study" },
  { path: "/notices", title: "nav.notices", element: () => <NoticesPage />, needs: ["academics:write"], menu: "study" },

  { path: "/charges", title: "nav.charges", element: () => <ChargesPage />, needs: ["finance:read"], menu: "money" },
  { path: "/payments", title: "nav.payments", element: () => <PaymentsPage />, needs: ["finance:read"], menu: "money" },
  { path: "/payments/:id", title: "finance.payment", element: () => <PaymentPage />, needs: ["finance:read"] },
  { path: "/debtors", title: "nav.debtors", element: () => <DebtorsPage />, needs: ["finance:read"], menu: "money" },
  { path: "/expenses", title: "nav.expenses", element: () => <ExpensesPage />, needs: ["finance:read"], menu: "money" },
  { path: "/reports", title: "nav.reports", element: () => <ReportsPage />, needs: ["reports:read"], menu: "money" },

  { path: "/organization", title: "nav.organization", element: () => <OrganizationPage />, needs: ["org:read"], menu: "center" },
  { path: "/branches", title: "nav.branches", element: () => <BranchesPage />, needs: ["org:read"], menu: "center" },
  { path: "/staff", title: "nav.staff", element: () => <StaffPage />, needs: ["staff:read"], menu: "center" },
  { path: "/import", title: "nav.import", element: () => <ImportPage />, needs: ["students:write", "academics:write"], menu: "center" },
  { path: "/account", title: "nav.account", element: () => <AccountPage /> },
];

export const mayOpen = (screen: Screen, can: (...p: string[]) => boolean, role: string): boolean =>
  (!screen.role || screen.role === role) && can(...(screen.needs ?? []));

/** Where "/" leads: the dashboard, a teacher's own page, or the first screen the person may open. */
export function homePath(can: (...p: string[]) => boolean, role: string): string {
  const first = SCREENS.find((s) => s.menu && mayOpen(s, can, role));
  return first?.path ?? "/account";
}
