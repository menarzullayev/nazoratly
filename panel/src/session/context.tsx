/** Who is signed in, what they may do (the list comes from /v1/me: the panel keeps no copy of the role matrix) and the
 * center and branch they are working in. Hiding things is only a convenience; the server enforces every rule. */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { components } from "@api/schema";
import { api, setBranch, unwrap } from "../api/client";
import { ApiFailure } from "../api/errors";
import { todayIn } from "../lib/format";
import { readPref, writePref } from "../lib/prefs";
import { session } from "./browser";

export type Me = components["schemas"]["nazoratly__routers__auth__MeOut"];
export type Organization = components["schemas"]["OrganizationOut"];
export type Branch = components["schemas"]["BranchOut"];

export interface Signed {
  me: Me;
  organization: Organization | null;
  branches: Branch[];
}

type State = { status: "loading" } | { status: "anonymous" } | { status: "failed"; error: ApiFailure } | ({ status: "ready" } & Signed);

interface SessionValue {
  state: State;
  branch: string | null; // the chosen X-Branch (null = all)
  chooseBranch: (id: string | null) => void;
  /** Reloads /v1/me, the center and its branches (after sign-in, a switch, or a change to them). */
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const Context = createContext<SessionValue | null>(null);

async function load(): Promise<Signed> {
  const me = await unwrap(api.GET("/v1/me"));
  if (!me.org || !me.permissions.includes("org:read")) return { me, organization: null, branches: [] };
  const [organization, branches] = await Promise.all([
    unwrap(api.GET("/v1/organization")),
    unwrap(api.GET("/v1/branches", { params: { query: { limit: 200 } } })),
  ]);
  return { me, organization, branches: branches.items };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [branch, setBranchState] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      if (!session.current) await session.refresh(readPref("org"));
      const orgId = session.current?.org?.id ?? null;
      writePref("org", orgId);
      const remembered = orgId ? readPref(`branch.${orgId}`) : null;
      setBranch(null);
      const signed = await load();
      if (mine !== generation.current) return;
      const chosen = !signed.me.branch_id && signed.branches.some((b) => b.id === remembered) ? remembered : null;
      setBranch(chosen);
      setBranchState(chosen);
      setState({ status: "ready", ...signed });
    } catch (error) {
      if (mine !== generation.current) return;
      const failure = error instanceof ApiFailure ? error : new ApiFailure(0, "unknown", String(error), null);
      setState(failure.status === 401 || failure.status === 403 ? { status: "anonymous" } : { status: "failed", error: failure });
    }
  }, []);

  useEffect(() => {
    session.onSignedOut = () => {
      generation.current++;
      setBranch(null);
      setState({ status: "anonymous" });
    };
    session.onChanged = () => {
      setState({ status: "loading" }); // another tab moved to another center: nothing of the old one may stay on screen
      void reload();
    };
    void reload();
  }, [reload]);

  const chooseBranch = useCallback(
    (id: string | null) => {
      setBranch(id);
      setBranchState(id);
      const orgId = session.current?.org?.id;
      if (orgId) writePref(`branch.${orgId}`, id);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await session.logout();
    } finally {
      generation.current++;
      setBranch(null);
      setState({ status: "anonymous" });
    }
  }, []);

  const value = useMemo(() => ({ state, branch, chooseBranch, reload, logout }), [state, branch, chooseBranch, reload, logout]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}

/** For screens behind the sign-in gate. */
export function useStaff() {
  const { state, branch } = useSession();
  if (state.status !== "ready" || !state.me.org) throw new Error("not signed in to a center");
  const permissions = new Set(state.me.permissions);
  const timeZone = state.organization?.timezone ?? "Asia/Tashkent";
  return {
    me: state.me,
    org: state.me.org,
    organization: state.organization,
    branches: state.branches,
    branch,
    /** The branch the person works in: their own restriction, else the chosen view. */
    scopeBranch: state.me.branch_id ?? branch,
    can: (...needed: string[]): boolean => needed.every((p) => permissions.has(p)),
    timeZone,
    today: todayIn(timeZone),
  };
}
