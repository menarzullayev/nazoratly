/** A plain list of records with add, edit and delete: guardians, courses, teachers, rooms, branches. Editing starts
 * from a fresh copy of the record when the API can give one. */

import { useState, type ReactNode } from "react";
import type { Key } from "../i18n/core";
import { useI18n } from "../i18n";
import { ConfirmButton, Dialog, Form, FormButton, type Body, type Field } from "../ui/form";
import { useLoad, type Load } from "../ui/hooks";
import { Loaded, Page, PAGE_SIZE, Pager, Table, type Column } from "../ui/kit";

export interface PageOf<R> {
  items: R[];
  has_more: boolean;
}

export interface ResourceProps<R extends { id: string }> {
  heading: Key;
  deps?: unknown[];
  list: (offset: number, limit: number) => Promise<PageOf<R>>;
  columns: Column<R>[];
  name: (row: R) => string;
  filters?: ReactNode;
  create?: { label: Key; fields: Field[]; initial?: Record<string, unknown>; submit: (body: Body, key: string) => Promise<unknown> };
  edit?: {
    fields: (row: R) => Field[];
    get?: (id: string) => Promise<R>;
    submit: (row: R, body: Body) => Promise<unknown>;
  };
  remove?: { text: Key; run: (row: R) => Promise<unknown> };
  rowActions?: (row: R, reload: () => void) => ReactNode;
}

function EditDialog<R extends { id: string }>({ row, edit, title, onClose, done }: {
  row: R;
  edit: NonNullable<ResourceProps<R>["edit"]>;
  title: string;
  onClose: () => void;
  done: () => void;
}) {
  const { t } = useI18n();
  const fresh: Load<R> = useLoad(() => (edit.get ? edit.get(row.id) : Promise.resolve(row)), [row.id]);
  return (
    <Dialog title={title} onClose={onClose}>
      <Loaded load={fresh}>
        {(record) => (
          <Form
            patch
            fields={edit.fields(record)}
            initial={record as Record<string, unknown>}
            submitLabel={t("common.save")}
            onCancel={onClose}
            submit={async (body) => {
              await edit.submit(record, body);
              done();
              onClose();
            }}
          />
        )}
      </Loaded>
    </Dialog>
  );
}

export function Resource<R extends { id: string }>({ heading, deps = [], list, columns, name, filters, create, edit, remove, rowActions }: ResourceProps<R>) {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<R | null>(null);
  const depKey = JSON.stringify(deps);
  const [seen, setSeen] = useState(depKey);
  if (seen !== depKey) {
    setSeen(depKey);
    setOffset(0); // a changed filter starts from the first page
  }
  const load = useLoad(() => list(offset, PAGE_SIZE), [offset, depKey]);
  const actions: Column<R>[] =
    edit || remove || rowActions
      ? [
          {
            head: t("common.actions"),
            cell: (row) => (
              <div className="row-actions">
                {rowActions?.(row, load.reload)}
                {edit ? (
                  <button type="button" onClick={() => setEditing(row)}>
                    {t("common.edit")}
                  </button>
                ) : null}
                {remove ? (
                  <ConfirmButton
                    label={t("common.delete")}
                    text={t(remove.text, { name: name(row) })}
                    done={load.reload}
                    run={async () => {
                      await remove.run(row);
                    }}
                  />
                ) : null}
              </div>
            ),
          },
        ]
      : [];
  return (
    <Page
      title={t(heading)}
      actions={
        create ? (
          <FormButton
            label={t(create.label)}
            className="primary"
            fields={create.fields}
            initial={create.initial}
            submit={async (body, key) => {
              await create.submit(body, key);
              load.reload();
            }}
          />
        ) : null
      }
    >
      {filters ? <div className="filters">{filters}</div> : null}
      <Loaded load={load}>
        {(page) => (
          <>
            <Table caption={t(heading)} rows={page.items} rowKey={(r) => r.id} columns={[...columns, ...actions]} />
            <Pager offset={offset} hasMore={page.has_more} onChange={setOffset} />
          </>
        )}
      </Loaded>
      {editing && edit ? <EditDialog row={editing} edit={edit} title={name(editing)} onClose={() => setEditing(null)} done={load.reload} /> : null}
    </Page>
  );
}
