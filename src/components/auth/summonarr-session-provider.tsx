"use client";

import * as React from "react";

export interface SummonarrSession {
  user: {
    id: string;
    role: string;
    provider?: string;
    mediaServer?: string | null;
  };
  sessionId?: string;
  expiresAt?: number;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface ContextValue {
  session: SummonarrSession | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<ContextValue | null>(null);

// Parallel session provider for the next-auth replacement work. The
// initialSession prop is populated server-side from the Summonarr session
// cookie (see src/lib/session-server.ts) so consumers don't see a loading
// flash on the first paint when the new cookie is already set.
//
// When initialSession is null we still hit /api/auth/me on mount, because
// that endpoint can backfill the new cookie from an existing next-auth
// session during the migration window. Once PR 5 lands and next-auth is
// gone, that backfill goes away — at which point initialSession=null means
// the user is genuinely unauthenticated and the useEffect is a wasted
// fetch we'll be safe to drop.
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
      const res = await fetch("/api/auth/me", { credentials: "include" });
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
