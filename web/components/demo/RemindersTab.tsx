"use client";

import { useState } from "react";
import { approve, messageFor, prepareReminders } from "@/demo/engine";
import { renderRich } from "@/lib/richRender";
import { Bubble, PhoneMock } from "../PhoneMock";
import type { TabProps } from "./Demo";

export function RemindersTab({ d, state, setState, show, brand }: TabProps & { brand: string }) {
  const [prepared, setPrepared] = useState(false);
  const nameOf = (id: string) => show(state.students.find((s) => s.id === id)!.fullName);
  const sentDrafts = state.drafts.filter((x) => x.status === "sent");
  const lastSent = sentDrafts[sentDrafts.length - 1];
  const html = lastSent ? messageFor(state, lastSent.id) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div>
        <h3 className="text-lg font-semibold">{d.reminders.title}</h3>
        <p className="mt-1 text-sm text-mute">{d.reminders.hint}</p>
        <button
          type="button"
          onClick={() => {
            setState(prepareReminders(state));
            setPrepared(true);
          }}
          className="mt-3 rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink"
        >
          {d.reminders.prepare}
        </button>

        <div role="status" aria-live="polite">
          {prepared && state.drafts.length === 0 && state.skipped.length === 0 && <p className="mt-3 text-sm text-mute">{d.reminders.none}</p>}
        </div>

        <ul className="mt-3 space-y-3">
          {state.drafts.map((x) => (
            <li key={x.id} className="rounded-xl border border-line p-3">
              <p className="text-sm font-semibold">
                {d.reminders.draft}: {nameOf(x.studentId)}
              </p>
              <p className="mt-1 text-sm text-mute">{show(x.text)}</p>
              {x.status === "pending" ? (
                <button type="button" onClick={() => setState(approve(state, x.id))} className="mt-2 rounded-lg border border-accent px-3 py-1.5 text-sm font-semibold text-accent">
                  {d.reminders.approve}
                </button>
              ) : (
                <p className="mt-2 text-sm font-semibold text-accent">{d.reminders.sent}</p>
              )}
            </li>
          ))}
        </ul>

        {state.skipped.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-mute">
            {state.skipped.map((x) => (
              <li key={x.studentId}>
                {d.reminders.skipped}: {nameOf(x.studentId)} ({(d.reminders.reasons as Record<string, string>)[x.reason] ?? x.reason})
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-2 text-center text-sm text-mute">{d.reminders.preview}</p>
        <PhoneMock title={brand}>
          {html ? <Bubble>{renderRich(show(html))}</Bubble> : <p className="pt-10 text-center text-mute" aria-hidden="true">…</p>}
        </PhoneMock>
      </div>
    </div>
  );
}
