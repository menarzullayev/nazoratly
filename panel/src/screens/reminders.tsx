/** The review of reminder drafts, shared by debt and lesson-package reminders: a person reads every text, edits it if
 * needed and approves the chosen ones. Nothing is sent that was not chosen here. */

import { useState } from "react";
import type { components } from "@api/schema";
import { useI18n } from "../i18n";
import { ConfirmButton } from "../ui/form";
import { useLoad } from "../ui/hooks";
import { Card, Done, Loaded, Table } from "../ui/kit";

export interface Draft {
  student_id: string;
  student_name: string;
  guardian_name: string;
  text: string;
  /** why this one is due, already translated */
  note: string;
}

export interface Preview {
  drafts: Draft[];
  skipped: components["schemas"]["ReminderSkipOut"][];
}

type Sent = components["schemas"]["ReminderSendOut"];

export function ReminderDrafts({ title, onClose, load: fetchPreview, send }: {
  title: string;
  onClose: () => void;
  load: () => Promise<Preview>;
  send: (messages: components["schemas"]["ReminderMessageIn"][], idempotencyKey: string) => Promise<Sent>;
}) {
  const { t, label } = useI18n();
  const load = useLoad(fetchPreview, []);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<string | null>(null);
  return (
    <Card title={title} actions={<button type="button" onClick={onClose}>{t("common.close")}</button>}>
      <p className="hint">{t("reminders.hint")}</p>
      <p className="hint">{t("reminders.addedAtSend")}</p>
      <Done text={result} />
      <Loaded load={load}>
        {(preview) => {
          const messages = preview.drafts
            .filter((d) => chosen[d.student_id])
            .map((d) => ({ student_id: d.student_id, text: (texts[d.student_id] ?? d.text).trim() }));
          return (
            <>
              {preview.drafts.length === 0 ? <p className="empty">{t("reminders.none")}</p> : null}
              <ul className="drafts">
                {preview.drafts.map((d) => (
                  <li key={d.student_id}>
                    <label className="check">
                      <input type="checkbox" checked={chosen[d.student_id] ?? false} onChange={(e) => setChosen((c) => ({ ...c, [d.student_id]: e.target.checked }))} />
                      <strong>{d.student_name}</strong> → {d.guardian_name} · {d.note}
                    </label>
                    <textarea
                      aria-label={`${t("common.message")}: ${d.student_name}`}
                      rows={4}
                      maxLength={4000}
                      value={texts[d.student_id] ?? d.text}
                      onChange={(e) => setTexts((x) => ({ ...x, [d.student_id]: e.target.value }))}
                    />
                  </li>
                ))}
              </ul>
              {preview.drafts.length ? (
                <div className="actions">
                  <button type="button" onClick={() => setChosen(Object.fromEntries(preview.drafts.map((d) => [d.student_id, true])))}>
                    {t("reminders.chooseAll")}
                  </button>
                  <ConfirmButton
                    label={t("reminders.send", { n: messages.length })}
                    text={t("reminders.sendText", { n: messages.length })}
                    danger={false}
                    disabled={messages.length === 0 || messages.length > 200 || messages.some((m) => !m.text)}
                    run={async (_reason, key) => {
                      const sent = await send(messages, key);
                      setResult(t("reminders.sent", { queued: sent.queued.length, refused: sent.refused.length }));
                      setChosen({});
                      load.reload();
                    }}
                  />
                </div>
              ) : null}
              {preview.skipped.length ? (
                <Table
                  caption={t("reminders.skipped")}
                  rows={preview.skipped}
                  rowKey={(s) => `${s.student_id}-${s.reason}`}
                  columns={[
                    { head: t("reminders.skipped"), cell: (s) => s.student_name },
                    { head: t("reminders.why"), cell: (s) => label("skipReason", s.reason) },
                  ]}
                />
              ) : null}
            </>
          );
        }}
      </Loaded>
    </Card>
  );
}
