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
    // Optimistic clear of BOTH the badge and the rows, then persist. The bell
    // panel paints each row off `readAt`, so zeroing `unread` alone left every
    // row highlighted as unread for up to POLL_MS after the badge had already
    // gone (the two disagreed for a minute). Track the exact rows this call
    // flips so the rollback restores their read state alone — a whole-list
    // snapshot would repaint rows a concurrent reload already replaced.
    // (Mirrors notification-list.tsx's markAllRead.) Event handler, not render,
    // so the timestamp here is fine under guardrail 16.
    const flipped = new Set(items.filter((n) => !n.readAt).map((n) => n.id));
    const prevUnread = unread;
    setUnread(0);
    if (flipped.size > 0) {
      setItems((cur) => {
        const at = new Date().toISOString();
        return cur.map((n) => (flipped.has(n.id) ? { ...n, readAt: at } : n));
      });
    }
    const res = await fetch(withBasePath("/api/notifications"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!res || !res.ok) {
      // Roll back on a clean 4xx/5xx too, not just a thrown/network error, so
      // the panel can't show read locally while the server still has them
      // unread. The next poll reconciles either way.
      setUnread(prevUnread);
      if (flipped.size > 0) {
        setItems((cur) => cur.map((n) => (flipped.has(n.id) ? { ...n, readAt: null } : n)));
      }
      return;
    }
    // Reconcile the badge with the server's answer (a notification that landed
    // between the last poll and this write stays counted).
    try {
      const data = (await res.json()) as { unreadCount?: number };
      if (typeof data.unreadCount === "number") setUnread(data.unreadCount);
    } catch {
      // body unreadable — the optimistic 0 stands until the next poll
    }
  }, [items, unread]);

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
