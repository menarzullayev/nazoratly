import { useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { useI18n } from "./i18n";
import { mayOpen, homePath, SCREENS, type Section } from "./routes";
import { ChooseCenterPage, LanguageSelect, LoginPage, RegisterPage, ResetPage } from "./screens/auth";
import { unsupportedBrowser } from "./session/browser";
import { useSession, useStaff } from "./session/context";
import { ErrorNote, Forbidden } from "./ui/kit";

const SECTIONS: Section[] = ["work", "mine", "study", "money", "books", "center"];

function BranchChooser() {
  const { t } = useI18n();
  const { me, branches, branch } = useStaff();
  const { chooseBranch } = useSession();
  const locked = me.branch_id;
  if (!locked && branches.length < 2) return null;
  return (
    <label className="branch">
      <span className="sr-only">{t("common.branch")}</span>
      <select value={locked ?? branch ?? ""} disabled={Boolean(locked)} onChange={(e) => chooseBranch(e.target.value || null)} data-testid="branch">
        {locked ? null : <option value="">{t("common.allBranches")}</option>}
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell() {
  const { t, label } = useI18n();
  const { me, org, branch, can } = useStaff();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const visible = SCREENS.filter((s) => s.menu && mayOpen(s, can, org.role));
  return (
    <div className="shell">
      <a className="skip" href="#main">
        {t("common.skip")}
      </a>
      <header className="top">
        <button type="button" className="menu-button" aria-expanded={open} aria-controls="menu" onClick={() => setOpen((v) => !v)}>
          {t("common.menu")}
        </button>
        <Link to="/" className="brand">
          nazoratly
        </Link>
        <Link to="/account" className="who">
          <strong>{org.name}</strong>
          <span>
            {me.full_name} · {label("role", org.role)}
          </span>
        </Link>
        <BranchChooser />
        <LanguageSelect />
      </header>
      <nav id="menu" className={open ? "menu menu-open" : "menu"} aria-label={t("common.menu")}>
        {SECTIONS.map((section) => {
          const items = visible.filter((s) => s.menu === section);
          if (!items.length) return null;
          return (
            <div key={section}>
              <p className="menu-title">{label("section", section)}</p>
              <ul>
                {items.map((s) => (
                  <li key={s.path}>
                    <NavLink to={s.path} end>
                      {t(s.title)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {/* a change of center or branch rebuilds the screen: nothing loaded for the old one stays visible */}
      <main id="main" key={`${org.id}:${branch ?? ""}`}>
        <Routes>
          <Route path="/" element={<Navigate to={homePath(can, org.role)} replace />} />
          {SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={mayOpen(s, can, org.role) ? s.element() : <Forbidden />} />
          ))}
          <Route path="*" element={<p role="alert">{t("common.noSuchPage")}</p>} />
        </Routes>
      </main>
    </div>
  );
}

function Gate() {
  const { t } = useI18n();
  const { state, reload } = useSession();
  const location = useLocation();
  if (location.pathname === "/reset") return <ResetPage />;
  if (state.status === "loading") return <p className="muted center" role="status">{t("common.loading")}</p>;
  if (state.status === "failed") {
    return (
      <main className="outside">
        <ErrorNote error={state.error} retry={() => void reload()} />
      </main>
    );
  }
  if (state.status === "anonymous") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (!state.me.org) return <ChooseCenterPage />;
  if (location.pathname === "/login" || location.pathname === "/register") return <Navigate to="/" replace />;
  return <Shell />;
}

export function App() {
  const { t } = useI18n();
  if (unsupportedBrowser) {
    return (
      <p className="note note-error" role="alert">
        {t("common.oldBrowser")}
      </p>
    );
  }
  return (
    <BrowserRouter basename="/app">
      <Gate />
    </BrowserRouter>
  );
}
