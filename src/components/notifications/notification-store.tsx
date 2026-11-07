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
import { reloadsInbox } from "./inbox-live-events";

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

// "loading" until the first fetch answers; "ready" once any fetch has
// succeeded; "error" when nothing has ever loaded and the last attempt failed.
// A failure AFTER a success leaves "ready" alone — the last-known list is
// still the best thing to show, and the poll will reconcile. The bell reads
// this so an in-flight or failed first load is not painted as "No
// notifications yet." (a user with unread items saw an empty list).
export type NotificationStoreStatus = "loading" | "ready" | "error";

interface NotificationStore {
  items: NotificationItem[];
  unread: number;
  status: NotificationStoreStatus;
  // Bumped each time the server confirms a markAllRead. The /notifications
  // page keeps its own (paged) copy of the list, longer than `items`, and marks
  // every loaded row read when this changes.
  readAllGen: number;
  reload: () => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationStore>({
  items: [],
  unread: 0,
  // No provider mounted ⇒ nothing will ever load; "ready" keeps a stray
  // consumer from showing a spinner forever.
  status: "ready",
  readAllGen: 0,
  reload: async () => {},
  markAllRead: async () => {},
});

const POLL_MS = 60_000;

export function NotificationStoreProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<NotificationStoreStatus>("loading");
  const [readAllGen, setReadAllGen] = useState(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request sequence. Reloads overlap (poll, tab focus, live events, every
  // list mutation) and can answer out of order; only the LATEST one may write
  // state, so an older, slower GET never overwrites a newer answer. markAllRead
  // bumps it too, so a GET served before its write committed can't put the
  // rows back to unread.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    // Only a store that has never loaded flips to "error"; once "ready" it
    // stays "ready" through transient failures (see NotificationStoreStatus).
    const failed = () => {
      if (id === seq.current) setStatus((s) => (s === "ready" ? s : "error"));
    };
    try {
      const res = await fetch(withBasePath("/api/notifications"), {
        credentials: "include",
      });
      if (!res.ok) {
        failed();
        return;
      }
      const data = (await res.json()) as {
        items?: NotificationItem[];
        unreadCount?: number;
      };
      if (id !== seq.current) return;
      setItems(data.items ?? []);
      setUnread(data.unreadCount ?? 0);
      setStatus("ready");
    } catch {
      // best-effort — a transient failure just leaves the last-known state
      failed();
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
  // events, so re-fetch on them for a near-instant badge instead of waiting up
  // to POLL_MS. An admin or request/issue manager receives these events for
  // EVERY user, so reloadsInbox only takes the ones the server marks as this
  // viewer's own (`own`). The poll above stays as the missed-event safety net.
  // Bursts (a sync flipping several requests at once) coalesce into one
  // refetch. The event list lives in inbox-live-events.ts.
  useLiveEvents((event) => {
    if (reloadsInbox(event)) {
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
    // Drop every GET already in flight: one served before this write commits
    // would put the rows back to unread.
    const mine = ++seq.current;
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
    // Did a reload start while the write was in flight? Either way it is
    // dropped by the bump below: it may have been served before the write
    // committed.
    const noReloadMeanwhile = seq.current === mine;
    seq.current++;
    if (!res || !res.ok) {
      // Roll back on a clean 4xx/5xx too, not just a thrown/network error, so
      // the panel can't show read locally while the server still has them
      // unread — then re-read the server's truth: the snapshot taken before the
      // write may already be out of date.
      if (noReloadMeanwhile) {
        setUnread(prevUnread);
        if (flipped.size > 0) {
          setItems((cur) => cur.map((n) => (flipped.has(n.id) ? { ...n, readAt: null } : n)));
        }
      }
      void reload();
      return;
    }
    setReadAllGen((g) => g + 1);
    // Reconcile the badge with the server's answer (a notification that landed
    // between the last poll and this write stays counted — and is fetched).
    try {
      const data = (await res.json()) as { unreadCount?: number };
      if (typeof data.unreadCount === "number") {
        setUnread(data.unreadCount);
        if (data.unreadCount > 0) void reload();
      }
    } catch {
      // body unreadable — the optimistic 0 stands until the next poll
    }
  }, [items, unread, reload]);

  const value = useMemo(
    () => ({ items, unread, status, readAllGen, reload, markAllRead }),
    [items, unread, status, readAllGen, reload, markAllRead],
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
