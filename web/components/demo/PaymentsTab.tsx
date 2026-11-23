"use client";

import { useState } from "react";
import { addPayment, debtOf, openCharges } from "@/demo/engine";
import { formatSom } from "@domain/reminders";
import type { TabProps } from "./Demo";

const METHODS = ["cash", "card", "transfer"] as const;

export function PaymentsTab({ d, state, setState, show }: TabProps) {
  const [studentId, setStudentId] = useState("S0005");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("cash");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const debt = debtOf(state, studentId);
  const open = openCharges(state, studentId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(amount.replace(/[\s,]/g, ""));
    const r = addPayment(state, studentId, n, method);
    if (r.error) {
      setMsg({ kind: "error", text: d.payments.invalid });
      return;
    }
    setState(r.state);
    setAmount("");
    setMsg({ kind: "ok", text: d.payments.done });
  };

  return (
    <div>
      <h3 className="text-lg font-semibold">{d.payments.title}</h3>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end" noValidate>
        <label className="grid gap-1 text-sm text-mute">
          {d.student}
          <select value={studentId} onChange={(e) => { setStudentId(e.target.value); setMsg(null); }} className="rounded-lg border border-line bg-bg px-3 py-2 text-fg">
            {state.students.map((s) => (
              <option key={s.id} value={s.id}>
                {show(s.fullName)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-mute">
          {d.payments.amount}
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={msg?.kind === "error"}
            aria-describedby="pay-msg"
            placeholder="600 000"
            className="rounded-lg border border-line bg-bg px-3 py-2 text-fg"
          />
        </label>
        <label className="grid gap-1 text-sm text-mute">
          {d.payments.method}
          <select value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])} className="rounded-lg border border-line bg-bg px-3 py-2 text-fg">
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {d.payments[m]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink">
          {d.payments.record}
        </button>
      </form>
      <p id="pay-msg" role={msg?.kind === "error" ? "alert" : "status"} className={`mt-2 min-h-6 text-sm ${msg?.kind === "error" ? "text-red-400" : "text-accent"}`}>
        {msg?.text}
      </p>

      <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl border border-line p-3">
          <dt className="text-xs text-mute">{d.payments.outstanding}</dt>
          <dd className="text-lg font-semibold">{formatSom(debt.outstanding)}</dd>
        </div>
        <div className="rounded-xl border border-line p-3">
          <dt className="text-xs text-mute">{d.payments.overdue}</dt>
          <dd className="text-lg font-semibold">{formatSom(debt.overdue)}</dd>
        </div>
        <div className="rounded-xl border border-line p-3">
          <dt className="text-xs text-mute">{d.payments.credit}</dt>
          <dd className="text-lg font-semibold">{formatSom(debt.credit)}</dd>
        </div>
      </dl>

      <h4 className="mt-5 text-sm font-semibold text-mute">{d.payments.charges}</h4>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-mute">{d.payments.none}</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-mute">
              <th className="py-1 font-medium">{d.payments.month}</th>
              <th className="py-1 text-right font-medium">{d.payments.outstanding}</th>
              <th className="py-1 text-right font-medium">{d.payments.due}</th>
            </tr>
          </thead>
          <tbody>
            {open.map((c) => (
              <tr key={c.month} className="border-t border-line">
                <td className="py-1.5">{c.month.slice(0, 7)}</td>
                <td className="py-1.5 text-right">{formatSom(c.outstanding)}</td>
                <td className="py-1.5 text-right">{c.dueDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
