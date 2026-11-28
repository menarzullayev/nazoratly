/** The shared states every screen uses: loading, empty, error, forbidden, paging, notices. All user data is rendered as
 * text. */

import { useEffect, useId, type ReactNode } from "react";
import { Link } from "react-router";
import type { ApiFailure } from "../api/errors";
import { useI18n, type T } from "../i18n";
import { hasKey } from "../i18n/core";
import type { Load } from "./hooks";

export function errorText(t: T, error: ApiFailure): string {
  const key = `error.${error.code}`;
  return hasKey(key) ? t(key) : t("error.unknown");
}

// For these codes the translated line is general; the server's (English) sentence says which rule was broken.
const WITH_DETAIL = new Set(["conflict", "unprocessable", "not_found"]);

export function ErrorNote({ error, retry }: { error: ApiFailure; retry?: () => void }) {
  const { t } = useI18n();
  const unknown = !hasKey(`error.${error.code}`);
  return (
    <div className="note note-error" role="alert" data-code={error.code}>
      <p>{errorText(t, error)}</p>
      {WITH_DETAIL.has(error.code) && error.detail ? <p className="detail">{t("error.serverSays", { text: error.detail })}</p> : null}
      {(unknown || error.status >= 500) && error.requestId ? <p className="detail">{t("error.requestId", { id: error.requestId })}</p> : null}
      {retry ? (
        <button type="button" onClick={retry}>
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function Forbidden() {
  const { t } = useI18n();
  return (
    <div className="note note-error" role="alert" data-testid="forbidden">
      <p>{t("common.forbidden")}</p>
    </div>
  );
}

/** Shows `children` with the loaded data, otherwise the loading, forbidden or error state. */
export function Loaded<D>({ load, children }: { load: Load<D>; children: (data: D) => ReactNode }) {
  const { t } = useI18n();
  if (load.error) return load.error.status === 403 ? <Forbidden /> : <ErrorNote error={load.error} retry={load.reload} />;
  if (load.data === undefined) return <p className="muted" role="status">{t("common.loading")}</p>;
  return <div aria-busy={load.loading}>{children(load.data)}</div>;
}

export function Page({ title, actions, back, children }: { title: string; actions?: ReactNode; back?: { to: string; label: string }; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · nazoratly`;
  }, [title]);
  return (
    <>
      {back ? (
        <p className="back">
          <Link to={back.to}>← {back.label}</Link>
        </p>
      ) : null}
      <header className="page-head">
        <h1>{title}</h1>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </>
  );
}

export interface Column<R> {
  head: string;
  cell: (row: R) => ReactNode;
  className?: string;
}

export function Table<R>({ rows, columns, rowKey, empty, caption }: { rows: R[]; columns: Column<R>[]; rowKey: (row: R) => string; empty?: string; caption: string }) {
  const { t } = useI18n();
  if (rows.length === 0) return <p className="empty">{empty ?? t("common.empty")}</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col">
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c, i) => (
                <td key={i} data-label={c.head} className={c.className}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const PAGE_SIZE = 25;

export function Pager({ offset, hasMore, onChange }: { offset: number; hasMore: boolean; onChange: (offset: number) => void }) {
  const { t } = useI18n();
  if (offset === 0 && !hasMore) return null;
  return (
    <nav className="pager" aria-label={t("common.pages")}>
      <button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>
        {t("common.previous")}
      </button>
      <span>{t("common.page", { n: Math.floor(offset / PAGE_SIZE) + 1 })}</span>
      <button type="button" disabled={!hasMore} onClick={() => onChange(offset + PAGE_SIZE)}>
        {t("common.next")}
      </button>
    </nav>
  );
}

export function Badge({ tone = "plain", children }: { tone?: "plain" | "good" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <header className="card-head">
        <h2 id={id}>{title}</h2>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Name–value pairs of one record. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value === null || value === undefined || value === "" ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Done({ text }: { text: string | null }) {
  return (
    <p className="done" role="status">
      {text}
    </p>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: { id: K; label: string }[]; value: K; onChange: (id: K) => void; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" aria-pressed={tab.id === value} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
