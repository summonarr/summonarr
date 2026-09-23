"use client";

import * as React from "react";
import { withBasePath } from "@/lib/base-path";

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

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface ContextValue {
  session: SummonarrSession | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<ContextValue | null>(null);

// The root layout reads the session cookie on the server (see
// src/lib/session-server.ts) and passes it in as initialSession, so the page
// doesn't flash a "loading" state on first paint. If it's null we still ask
// /api/auth/me once on mount, in case a session exists that the server read missed.
export function SummonarrSessionProvider({
  initialSession,
  children,
}: {
  initialSession: SummonarrSession | null;
  children: React.ReactNode;
}) {
  const [session, setSession] = React.useState<SummonarrSession | null>(
    initialSession,
  );
  const [status, setStatus] = React.useState<SessionStatus>(
    initialSession ? "authenticated" : "loading",
  );

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/auth/me"), { credentials: "include" });
      if (res.ok) {
        const body = (await res.json()) as { session: SummonarrSession | null };
        setSession(body.session);
        setStatus(body.session ? "authenticated" : "unauthenticated");
      } else {
        setSession(null);
        setStatus("unauthenticated");
      }
    } catch {
      // Network error — keep whatever session we had rather than dropping
      // the user to unauthenticated on a transient blip.
      setStatus(session ? "authenticated" : "unauthenticated");
    }
  }, [session]);

  React.useEffect(() => {
    if (initialSession == null) void refresh();
    // Only run on mount; subsequent updates happen via refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo(
    () => ({ session, status, refresh }),
    [session, status, refresh],
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
