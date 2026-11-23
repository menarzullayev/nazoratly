"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { seedState, type DemoState } from "@/demo/engine";
import type { Dict } from "@/i18n/get";
import type { Locale } from "@/i18n/locales";
import { convert } from "@/lib/translit";
import { AttendanceTab } from "./AttendanceTab";
import { GuardianView } from "./GuardianView";
import { PaymentsTab } from "./PaymentsTab";
import { PayrollTab } from "./PayrollTab";
import { RemindersTab } from "./RemindersTab";

export type Show = (s: string) => string;
export interface TabProps {
  d: Dict["demo"];
  state: DemoState;
  setState: (next: DemoState) => void;
  show: Show;
}

const TABS = ["attendance", "payments", "reminders", "payroll"] as const;
type Tab = (typeof TABS)[number];
const ROLES = ["owner", "teacher", "guardian"] as const;
type Role = (typeof ROLES)[number];
/** The owner sees everything; a teacher only attendance and payroll of their own groups; a guardian only the bot. */
const TABS_OF: Record<Role, readonly Tab[]> = { owner: TABS, teacher: ["attendance", "payroll"], guardian: [] };

/** Demo copy (names, group titles, the guardian message) is Uzbek; show it in the reader's Uzbek script. */
function showFor(locale: Locale): Show {
  return locale === "uz-cyrl" ? (s) => convert(s, "cyrl") : locale === "uz-new" ? (s) => convert(s, "new") : (s) => s;
}

export function Demo({ demo, brand, locale }: { demo: Dict["demo"]; brand: string; locale: Locale }) {
  const [state, setState] = useState<DemoState>(() => seedState());
  const [role, setRole] = useState<Role>("owner");
  const [teacherId, setTeacherId] = useState(() => seedState().teachers[0]!.id);
  const [tab, setTab] = useState<Tab>("attendance");
  const uid = useId();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ attendance: null, payments: null, reminders: null, payroll: null });
  const roleRefs = useRef<Record<Role, HTMLButtonElement | null>>({ owner: null, teacher: null, guardian: null });
  const show = showFor(locale);
  const tabs = TABS_OF[role];
  const activeTab: Tab = tabs.includes(tab) ? tab : (tabs[0] ?? "attendance");

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length]!;
    setTab(next);
    refs.current[next]?.focus();
  };

  const onRoleKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = ROLES[(i + step + ROLES.length) % ROLES.length]!;
    setRole(next);
    roleRefs.current[next]?.focus();
  };

  const props: TabProps = { d: demo, state, setState, show };
  const asTeacher = role === "teacher" ? teacherId : undefined;
  return (
    <div className="rounded-2xl border border-line bg-bg2 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span id={`${uid}-roles`} className="text-sm text-mute">
          {demo.roles.label}
        </span>
        <div role="radiogroup" aria-labelledby={`${uid}-roles`} className="flex flex-wrap gap-2">
          {ROLES.map((r, i) => (
            <button
              key={r}
              ref={(el) => {
                roleRefs.current[r] = el;
              }}
              role="radio"
              type="button"
              aria-checked={role === r}
              tabIndex={role === r ? 0 : -1}
              onClick={() => setRole(r)}
              onKeyDown={(e) => onRoleKey(e, i)}
              className="rounded-full border border-line px-4 py-1.5 text-sm font-medium text-mute aria-checked:border-accent aria-checked:bg-accent aria-checked:text-accent-ink"
            >
              {demo.roles[r]}
            </button>
          ))}
        </div>
      </div>

      {role === "teacher" && (
        <div className="mt-4 grid max-w-md gap-2">
          <p className="text-sm text-mute">{demo.roles.teacherHint}</p>
          <label className="grid gap-1 text-sm text-mute">
            {demo.payroll.teacher}
            <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2 text-fg">
              {state.teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {show(t.fullName)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {tabs.length > 0 ? (
        <>
          <div role="tablist" aria-label={demo.title} className="mt-5 flex flex-wrap gap-2">
            {tabs.map((t, i) => (
              <button
                key={t}
                ref={(el) => {
                  refs.current[t] = el;
                }}
                id={`${uid}-tab-${t}`}
                role="tab"
                type="button"
                aria-selected={activeTab === t}
                aria-controls={`${uid}-panel-${t}`}
                tabIndex={activeTab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e) => onKey(e, i)}
                className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-mute aria-selected:border-accent aria-selected:text-fg"
              >
                {demo.tabs[t]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${uid}-panel-${activeTab}`} aria-labelledby={`${uid}-tab-${activeTab}`} tabIndex={0} className="mt-5">
            {activeTab === "attendance" && <AttendanceTab key={`${role}-${teacherId}`} {...props} teacherId={asTeacher} />}
            {activeTab === "payments" && <PaymentsTab {...props} />}
            {activeTab === "reminders" && <RemindersTab {...props} brand={brand} />}
            {activeTab === "payroll" && <PayrollTab {...props} teacherId={asTeacher} />}
          </div>
        </>
      ) : (
        <div className="mt-5">
          <GuardianView {...props} brand={brand} />
        </div>
      )}
    </div>
  );
}
