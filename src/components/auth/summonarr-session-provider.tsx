"use client";

import * as React from "react";
import { withBasePath } from "@/lib/base-path";

export interface SummonarrSession {
  user: {
    id: string;
    role: string;
    // Decimal string (from session claim) for permission bitmask. Enables nav
    // and UI to respect MANAGE_* grants without requiring ADMIN/ISSUE_ADMIN role.
    permissions?: string;
    email?: string | null;
    name?: string | null;
    provider?: string;
    mediaServer?: string | null;
  };
  // sessionId intentionally omitted from the client shape: no client consumer
  // reads it. Server components that need it use auth() which still carries
  // the full claims.
  expiresAt?: number;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface ContextValue {
  session: SummonarrSession | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<ContextValue | null>(null);

// initialSession is populated server-side from the Summonarr session cookie
// (see src/lib/session-server.ts) so consumers don't see a loading flash on
// first paint. When it's null we still hit /api/auth/me on mount to backfill
// the session in case one exists that the server-side read didn't surface.
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
