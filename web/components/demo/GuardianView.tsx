"use client";

import { useState } from "react";
import { consentingStudents, guardianBalance, guardianInbox } from "@/demo/engine";
import { renderRich } from "@/lib/richRender";
import { Bubble, PhoneMock } from "../PhoneMock";
import type { TabProps } from "./Demo";

/** What a guardian sees: the bot chat of their own child only. Only guardians who consented can be messaged at all. */
export function GuardianView({ d, state, show, brand }: Omit<TabProps, "setState"> & { brand: string }) {
  const linked = consentingStudents(state);
  const [studentId, setStudentId] = useState(linked[0]!.id);
  const inbox = guardianInbox(state, studentId);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
      <div>
        <p className="text-sm text-mute">{d.roles.guardianHint}</p>
        <label className="mt-3 grid max-w-xs gap-1 text-sm text-mute">
          {d.roles.child}
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2 text-fg">
            {linked.map((s) => (
              <option key={s.id} value={s.id}>
                {show(s.fullName)}
              </option>
            ))}
          </select>
        </label>
        {inbox.length === 0 && <p className="mt-3 text-sm text-mute">{d.roles.empty}</p>}
      </div>
      <div>
        <p className="mb-2 text-center text-sm text-mute">{d.reminders.preview}</p>
        <PhoneMock title={brand}>
          <Bubble>{d.roles.command}</Bubble>
          <Bubble>{renderRich(show(guardianBalance(state, studentId)))}</Bubble>
          {inbox.map((html, i) => (
            <Bubble key={i}>{renderRich(show(html))}</Bubble>
          ))}
        </PhoneMock>
      </div>
    </div>
  );
}
