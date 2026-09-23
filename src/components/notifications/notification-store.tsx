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
// The desktop bell (<NotificationBell>) and the mobile nav's badge
// (<NotificationsLink>) show the same data, and BOTH are mounted at every screen
// size — CSS hides one, but its React effects still run. When each fetched on
// its own, every page made two identical requests (and two timers, two live
// event listeners).
//
// Keeping the state here means one fetch, one timer and one live-event
// listener for both. It's a plain React context on purpose, not a state
// library (guardrail 9).

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
    // Update the screen first ("optimistic"), then tell the server. Clear BOTH
    // the badge count and each row's `readAt` — the bell panel colours rows by
    // `readAt`, so clearing only the count left rows looking unread for up to a
    // minute. We remember exactly which rows we flipped so a failure can undo
    // just those, without disturbing rows a reload has replaced meanwhile.
    // (Same as notification-list.tsx's markAllRead.) This runs in a click
    // handler, not during render, so calling `new Date()` is fine (guardrail 16).
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
