"use client";

import { useState } from "react";
import { payrollOf } from "@/demo/engine";
import { formatSom } from "@domain/reminders";
import type { TabProps } from "./Demo";

export function PayrollTab({ d, state, show, teacherId: fixedTeacherId }: TabProps & { teacherId?: string }) {
  const [chosenId, setTeacherId] = useState(state.teachers[0]!.id);
  const teacherId = fixedTeacherId ?? chosenId;
  const teacher = state.teachers.find((t) => t.id === teacherId)!;
  const p = payrollOf(state, teacherId);

  return (
    <div>
      <h3 className="text-lg font-semibold">{d.payroll.title}</h3>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {fixedTeacherId ? (
          <span className="font-medium">{show(teacher.fullName)}</span>
        ) : (
          <>
            <label className="text-sm text-mute" htmlFor="pay-teacher">
              {d.payroll.teacher}
            </label>
            <select id="pay-teacher" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2">
              {state.teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {show(t.fullName)}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="text-sm text-mute">
          {d.payroll.model[teacher.payModel]}: {teacher.payModel === "percent" ? `${teacher.payRate}%` : formatSom(teacher.payRate)}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl border border-line p-3">
          <dt className="text-xs text-mute">{d.payroll.lessons}</dt>
          <dd className="text-lg font-semibold">{p.heldLessons}</dd>
        </div>
        <div className="rounded-xl border border-line p-3">
          <dt className="text-xs text-mute">{d.payroll.collected}</dt>
          <dd className="text-lg font-semibold">{formatSom(p.collectedTuition)}</dd>
        </div>
        <div className="rounded-xl border border-accent p-3">
          <dt className="text-xs text-mute">{d.payroll.total}</dt>
          <dd aria-live="polite" className="text-lg font-semibold text-accent">
            {formatSom(p.total)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
