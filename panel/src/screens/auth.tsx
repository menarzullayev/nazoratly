/** Before the staff screens: sign in, register a center, set a new password from an operator's link, choose a center. */

import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { LOCALES, NATIVE_NAME, type Locale } from "../i18n/core";
import { session } from "../session/browser";
import { useSession } from "../session/context";
import { Form, type Field } from "../ui/form";
import { useAction } from "../ui/hooks";
import { ErrorNote, Page } from "../ui/kit";

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select className="language" aria-label={t("common.language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {NATIVE_NAME[l]}
        </option>
      ))}
    </select>
  );
}

function Outside({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="outside" id="main">
      <div className="outside-head">
        <span className="brand">nazoratly</span>
        <LanguageSelect />
      </div>
      <Page title={title}>{children}</Page>
    </main>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { reload } = useSession();
  const fields: Field[] = [
    { name: "identifier", label: t("auth.identifier"), required: true, autoComplete: "username", maxLength: 254 },
    { name: "password", label: t("auth.password"), type: "password", required: true, autoComplete: "current-password", maxLength: 128 },
  ];
  return (
    <Outside title={t("auth.signInTitle")}>
      <Form
        fields={fields}
        submitLabel={t("auth.signIn")}
        submit={async (body) => {
          await session.login({ identifier: String(body.identifier), password: String(body.password) });
          await reload();
        }}
      />
      <p>
        <Link to="/register">{t("auth.toRegister")}</Link>
      </p>
      <p className="hint">{t("auth.forgot")}</p>
    </Outside>
  );
}

export function RegisterPage() {
  const { t } = useI18n();
  const { reload } = useSession();
  const navigate = useNavigate();
  const fields: Field[] = [
    { name: "center_name", label: t("auth.centerName"), required: true, maxLength: 200 },
    { name: "full_name", label: t("common.fullName"), required: true, maxLength: 200, autoComplete: "name" },
    { name: "email", label: t("common.email"), type: "email", autoComplete: "email", hint: t("auth.emailOrPhone") },
    { name: "phone", label: t("common.phone"), type: "tel", autoComplete: "tel", hint: t("common.phoneHint") },
    { name: "password", label: t("auth.password"), type: "password", required: true, minLength: 10, maxLength: 128, autoComplete: "new-password", hint: t("auth.passwordHint") },
  ];
  return (
    <Outside title={t("auth.registerTitle")}>
      <Form
        fields={fields}
        submitLabel={t("auth.register")}
        submit={async (body) => {
          await session.register(body as never);
          navigate("/", { replace: true });
          await reload();
        }}
      />
      <p>
        <Link to="/login">{t("auth.toLogin")}</Link>
      </p>
    </Outside>
  );
}

/** The code arrives in the URL fragment: browsers never send a fragment to a server, and it is removed from the address
 * bar and the history as soon as it has been read. */
function takeCode(): string {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("code") ?? "";
  if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
  return code;
}

let carried = ""; // survives React remounting the page (development double effects, a language change)

export function ResetPage() {
  const { t } = useI18n();
  const { reload } = useSession();
  const [code] = useState(() => (carried = takeCode() || carried));
  const [done, setDone] = useState(false);
  const fields: Field[] = [
    { name: "new_password", label: t("auth.newPassword"), type: "password", required: true, minLength: 10, maxLength: 128, autoComplete: "new-password", hint: t("auth.passwordHint") },
    { name: "repeat", label: t("auth.repeatPassword"), type: "password", required: true, maxLength: 128, autoComplete: "new-password" },
  ];
  const [mismatch, setMismatch] = useState(false);
  return (
    <Outside title={t("auth.resetTitle")}>
      {done ? (
        <>
          <p role="status" className="done">{t("auth.resetDone")}</p>
          <p>
            <Link to="/login">{t("auth.toLogin")}</Link>
          </p>
        </>
      ) : !code ? (
        <p className="note note-error" role="alert">{t("auth.resetNoCode")}</p>
      ) : (
        <Form
          fields={fields}
          submitLabel={t("auth.setPassword")}
          extra={mismatch ? <p className="field-error" role="alert">{t("auth.mismatch")}</p> : null}
          submit={async (body, _key, values) => {
            if (values.new_password !== values.repeat) {
              setMismatch(true);
              return;
            }
            setMismatch(false);
            await unwrap(api.POST("/v1/auth/reset", { body: { code, new_password: String(body.new_password) } }));
            carried = "";
            session.forget();
            setDone(true);
            await reload();
          }}
        />
      )}
    </Outside>
  );
}

/** Centers the account belongs to (to enter one) and invitations waiting for an answer. */
export function CenterList({ onEntered }: { onEntered?: () => void }) {
  const { t, label } = useI18n();
  const { state, reload } = useSession();
  const action = useAction();
  if (state.status !== "ready") return null;
  const { me } = state;
  if (me.organizations.length === 0) return <p className="empty">{t("center.none")}</p>;
  return (
    <>
      {action.error ? <ErrorNote error={action.error} /> : null}
      <ul className="centers">
        {me.organizations.map((o) => (
          <li key={o.id}>
            <span>
              <strong>{o.name}</strong> · {label("role", o.role)}
            </span>
            {o.membership_status === "invited" ? (
              <button
                type="button"
                className="primary"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    await unwrap(api.POST("/v1/me/invitations/{org_id}/accept", { params: { path: { org_id: o.id } } }));
                    await reload();
                  })
                }
              >
                {t("center.accept")}
              </button>
            ) : me.org?.id === o.id ? (
              <span className="badge badge-good">{t("center.current")}</span>
            ) : (
              <button
                type="button"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    await session.switchOrg(o.id);
                    await reload();
                    onEntered?.();
                  })
                }
              >
                {t("center.enter")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function ChooseCenterPage() {
  const { t } = useI18n();
  const { logout } = useSession();
  return (
    <Outside title={t("center.title")}>
      <CenterList />
      <p>
        <button type="button" onClick={() => void logout()}>
          {t("auth.signOut")}
        </button>
      </p>
    </Outside>
  );
}
