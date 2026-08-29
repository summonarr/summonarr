"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { withBasePath } from "@/lib/base-path";
import { useLiveEvents } from "@/hooks/use-live-events";

// ONE notifications poll for the whole app.
//
// The desktop bell (<NotificationBell>, inside the lg-only <Header>) and the
// mobile nav's badge (<NotificationsLink>, inside the lg:hidden <MobileNav>)
// both render the same data, and BOTH are mounted at every viewport — the
// breakpoint hiding one of them is CSS, not React, so the hidden one still runs
// its effects. They each fetched /api/notifications independently, so every
// page produced two identical GETs, and at 1372px one of them was for a
// component nobody could see. The same doubling applied to the visibility
// refresh and to the SSE-triggered reload.
//
// Owning the state here collapses that to one fetch, one interval, one SSE
// subscription. Deliberately a context, not a state library (guardrail 9).

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  posterPath: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationStore {
  items: NotificationItem[];
  unread: number;
  reload: () => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationStore>({
  items: [],
  unread: 0,
  reload: async () => {},
  markAllRead: async () => {},
});

const POLL_MS = 60_000;

export function NotificationStoreProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/notifications"), {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        items?: NotificationItem[];
        unreadCount?: number;
      };
      setItems(data.items ?? []);
      setUnread(data.unreadCount ?? 0);
    } catch {
      // best-effort — a transient failure just leaves the last-known state
    }
  }, []);

  useEffect(() => {
    void reload();
    // The interval keeps ticking in hidden tabs (simplest correct shape), but
    // the fetch is skipped there — a background tab doesn't need a fresh badge.
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void reload();
    }, POLL_MS);
    // Refresh immediately when the tab becomes visible again so a returning
    // user isn't up to POLL_MS stale.
    function onVisibility() {
      if (document.visibilityState === "visible") void reload();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);

  // Real-time: the server writes an in-app notification alongside these SSE
  // events (scoped to this user server-side), so re-fetch on them for a
  // near-instant badge instead of waiting up to POLL_MS. The poll above stays
  // as the missed-event safety net. Bursts (a sync flipping several requests at
  // once) coalesce into one refetch.
  useLiveEvents((event) => {
    if (
      event.type === "request:updated" ||
      event.type === "issue:updated" ||
      event.type === "issuemessage:created"
    ) {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void reload(), 400);
    }
  });

  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  const markAllRead = useCallback(async () => {
    // Optimistic clear, then persist. If the write fails the badge comes back
    // on the next poll.
    setUnread(0);
    try {
      await fetch(withBasePath("/api/notifications"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(
    () => ({ items, unread, reload, markAllRead }),
    [items, unread, reload, markAllRead],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationStore {
  return useContext(NotificationContext);
}
