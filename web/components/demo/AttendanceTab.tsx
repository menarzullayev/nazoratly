"use client";

import { useState } from "react";
import { DEMO_TODAY, markAttendance, type AttendanceStatus } from "@/demo/engine";
import type { TabProps } from "./Demo";

const STATUSES: AttendanceStatus[] = ["present", "late", "absent"];

export function AttendanceTab({ d, state, setState, show }: TabProps) {
  const [groupId, setGroupId] = useState(state.groups[0]!.id);
  const roster = state.enrollments.filter((e) => e.groupId === groupId).map((e) => state.students.find((s) => s.id === e.studentId)!);
  const today = state.attendance.filter((a) => a.date === DEMO_TODAY && a.groupId === groupId);
  const statusOf = (studentId: string) => today.find((a) => a.studentId === studentId)?.status;
  const count = (st: AttendanceStatus) => today.filter((a) => a.status === st).length;

  return (
    <div>
      <h3 className="text-lg font-semibold">{d.attendance.title}</h3>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm text-mute" htmlFor="att-group">
          {d.attendance.group}
        </label>
        <select id="att-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2">
          {state.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {show(g.name)}
            </option>
          ))}
        </select>
        <p role="status" className="text-sm text-mute">
          {d.attendance.counts}: {d.attendance.present} {count("present")} · {d.attendance.late} {count("late")} · {d.attendance.absent} {count("absent")}
        </p>
      </div>
      <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
        {roster.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <span className="min-w-0 break-words font-medium">{show(s.fullName)}</span>
            <div role="group" aria-label={`${d.student}: ${show(s.fullName)}`} className="flex gap-1.5">
              {STATUSES.map((st) => (
                <button
                  key={st}
                  type="button"
                  aria-pressed={statusOf(s.id) === st}
                  onClick={() => setState(markAttendance(state, DEMO_TODAY, groupId, s.id, st))}
                  className="rounded-md border border-line px-2.5 py-1 text-sm text-mute aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-ink"
                >
                  {d.attendance[st]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
