"use client";

import * as React from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { MeSchema, sessionAfterRead, type SessionState, type SessionStatus } from "./session-read";

export interface SummonarrSession {
  user: {
    id: string;
    role: string;
    // The user's permission flags packed into one number (a "bitmask"), sent as
    // a decimal string. Lets the nav and UI honour MANAGE_* grants for users
    // who aren't ADMIN or ISSUE_ADMIN.
    permissions?: string;
    email?: string | null;
    name?: string | null;
    provider?: string;
    mediaServer?: string | null;
  };
  // sessionId is left out on purpose: nothing in the browser reads it. Server
  // code that needs it calls auth(), which still has every claim.
  expiresAt?: number;
}

export type { SessionStatus };

interface ContextValue {
  session: SummonarrSession | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
}

type State = SessionState<SummonarrSession>;

const Ctx = React.createContext<ContextValue | null>(null);

// What the provider holds when the server read `initial`: a session is
// authenticated; none is "loading" until /api/auth/me has been asked.
function seeded(initial: SummonarrSession | null): State {
  return { session: initial, status: initial ? "authenticated" : "loading" };
}

// The prop's content, so a re-render that hands an identical session (every
// RSC render builds a new object) changes nothing.
const sessionKey = (s: SummonarrSession | null) => JSON.stringify(s);

// The root layout reads the session cookie on the server (see
// src/lib/session-server.ts) and passes it in as initialSession, so the page
// doesn't flash a "loading" state on first paint. If it's null we ask
// /api/auth/me, in case a session exists that the server read missed.
//
// A later render of the layout (router.refresh() after a role or permission
// change, a re-signed cookie) hands a NEWER initialSession: it replaces what
// the provider holds, so the nav and permission checks never keep the old
// claims until a full reload.
export function SummonarrSessionProvider({
  initialSession,
  children,
}: {
  initialSession: SummonarrSession | null;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<State>(() => seeded(initialSession));
  const [renderedKey, setRenderedKey] = React.useState(() => sessionKey(initialSession));
  const initialKey = sessionKey(initialSession);
  if (renderedKey !== initialKey) {
    setRenderedKey(initialKey);
    // A server-read session is the newer truth; a null one is checked with
    // /api/auth/me below, keeping what is shown until it answers.
    if (initialSession) setState({ session: initialSession, status: "authenticated" });
  }

  // Only the newest refresh may write: an older one landing late can't
  // overwrite a newer answer.
  const seqRef = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const seq = ++seqRef.current;
    const res = await fetchJson(withBasePath("/api/auth/me"), { schema: MeSchema, init: { credentials: "include" } });
    if (seq !== seqRef.current) return;
    // Signed out only on a 401/403; no answer or a 5xx keeps what is shown.
    setState((prev) => sessionAfterRead(prev, res));
  }, []);

  // Ask /api/auth/me whenever the server read found no session — on mount,
  // and on a later render that brings a null one.
  React.useEffect(() => {
    if (initialKey === "null") void refresh();
  }, [initialKey, refresh]);

  const value = React.useMemo(
    () => ({ session: state.session, status: state.status, refresh }),
    [state, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSummonarrSession(): ContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useSummonarrSession must be used inside <SummonarrSessionProvider>",
    );
  }
  return ctx;
}
