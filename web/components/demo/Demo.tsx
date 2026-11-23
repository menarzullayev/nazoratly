"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { seedState, type DemoState } from "@/demo/engine";
import type { Dict } from "@/i18n/get";
import type { Locale } from "@/i18n/locales";
import { convert } from "@/lib/translit";
import { AttendanceTab } from "./AttendanceTab";
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

/** Demo copy (names, group titles, the guardian message) is Uzbek; show it in the reader's Uzbek script. */
function showFor(locale: Locale): Show {
  return locale === "uz-cyrl" ? (s) => convert(s, "cyrl") : locale === "uz-new" ? (s) => convert(s, "new") : (s) => s;
}

export function Demo({ demo, brand, locale }: { demo: Dict["demo"]; brand: string; locale: Locale }) {
  const [state, setState] = useState<DemoState>(() => seedState());
  const [tab, setTab] = useState<Tab>("attendance");
  const uid = useId();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ attendance: null, payments: null, reminders: null, payroll: null });
  const show = showFor(locale);

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length]!;
    setTab(next);
    refs.current[next]?.focus();
  };

  const props: TabProps = { d: demo, state, setState, show };
  return (
    <div className="rounded-2xl border border-line bg-bg2 p-4 sm:p-6">
      <div role="tablist" aria-label={demo.title} className="flex flex-wrap gap-2">
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              refs.current[t] = el;
            }}
            id={`${uid}-tab-${t}`}
            role="tab"
            type="button"
            aria-selected={tab === t}
            aria-controls={`${uid}-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onKey(e, i)}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-mute aria-selected:border-accent aria-selected:text-fg"
          >
            {demo.tabs[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0} className="mt-5">
        {tab === "attendance" && <AttendanceTab {...props} />}
        {tab === "payments" && <PaymentsTab {...props} />}
        {tab === "reminders" && <RemindersTab {...props} brand={brand} />}
        {tab === "payroll" && <PayrollTab {...props} />}
      </div>
    </div>
  );
}
