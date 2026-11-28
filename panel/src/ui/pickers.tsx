/** Choosing a record from the center: short lists as options, students and guardians by searching. */

import { useId, useState } from "react";
import { api, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { useDebounced, useLoad } from "./hooks";
import type { Option } from "./form";

const ALL = { limit: 200 };

export function useCourses(enabled = true) {
  return useLoad(async () => (enabled ? (await unwrap(api.GET("/v1/courses", { params: { query: ALL } }))).items : []), [enabled]);
}
export function useTeachers(enabled = true) {
  return useLoad(async () => (enabled ? (await unwrap(api.GET("/v1/teachers", { params: { query: ALL } }))).items : []), [enabled]);
}
export function useRooms(enabled = true) {
  return useLoad(async () => (enabled ? (await unwrap(api.GET("/v1/rooms", { params: { query: ALL } }))).items : []), [enabled]);
}
export function useGroups(enabled = true) {
  return useLoad(async () => (enabled ? (await unwrap(api.GET("/v1/groups", { params: { query: ALL } }))).items : []), [enabled]);
}

export const options = <R extends { id: string }>(rows: R[] | undefined, label: (row: R) => string): Option[] =>
  (rows ?? []).map((row) => ({ value: row.id, label: label(row) }));

export interface Picked {
  id: string;
  name: string;
}

/** A search box that offers matches; the chosen record is shown with a button to change it. */
function SearchPicker({ label, value, onPick, search }: { label: string; value: Picked | null; onPick: (v: Picked | null) => void; search: (q: string) => Promise<Picked[]> }) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState("");
  const slow = useDebounced(text.trim());
  const found = useLoad(async () => (slow.length >= 2 ? search(slow) : []), [slow]);
  if (value) {
    return (
      <div className="field">
        <span className="label">{label}</span>
        <p className="picked">
          <span>{value.name}</span>{" "}
          <button type="button" onClick={() => onPick(null)}>
            {t("common.change")}
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="search" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("common.searchHint")} />
      {slow.length >= 2 && found.data ? (
        found.data.length ? (
          <ul className="matches">
            {found.data.map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => onPick(row)}>
                  {row.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t("common.nothingFound")}</p>
        )
      ) : null}
    </div>
  );
}

export function StudentPicker({ value, onPick, label }: { value: Picked | null; onPick: (v: Picked | null) => void; label?: string }) {
  const { t } = useI18n();
  return (
    <SearchPicker
      label={label ?? t("common.student")}
      value={value}
      onPick={onPick}
      search={async (q) =>
        (await unwrap(api.GET("/v1/students", { params: { query: { q, limit: 10 } } }))).items.map((s) => ({ id: s.id, name: s.full_name }))
      }
    />
  );
}

export function GuardianPicker({ value, onPick }: { value: Picked | null; onPick: (v: Picked | null) => void }) {
  const { t } = useI18n();
  return (
    <SearchPicker
      label={t("common.guardian")}
      value={value}
      onPick={onPick}
      search={async (q) =>
        (await unwrap(api.GET("/v1/guardians", { params: { query: { q, limit: 10 } } }))).items.map((g) => ({
          id: g.id,
          name: g.phone ? `${g.full_name} · ${g.phone}` : g.full_name,
        }))
      }
    />
  );
}
