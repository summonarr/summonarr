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
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
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

// One row of GET /api/notifications, checked on arrival (the bell and the
// /notifications page render these fields).
export const NotificationItemSchema = v.object({
  id: v.string(),
  type: v.string(),
  title: v.string(),
  body: v.string(),
  tmdbId: v.nullable(v.int()),
  mediaType: v.nullable(v.literal("MOVIE", "TV")),
  posterPath: v.nullable(v.string()),
  readAt: v.nullable(v.string()),
  createdAt: v.string(),
});

// A page of GET /api/notifications. `total` and `nextCursor` drive the
// /notifications page's paging; the store reads the first page only.
export const NotificationPageSchema = v.object({
  items: v.array(NotificationItemSchema),
  unreadCount: v.optional(v.number()),
  total: v.optional(v.number()),
  nextCursor: v.optional(v.nullable(v.string())),
});

// The rows in `ids` marked read at `at` (or unread, with null); every other
// row — and a list with nothing to change — is returned as it was.
export function withReadAt(items: NotificationItem[], ids: ReadonlySet<string>, at: string | null): NotificationItem[] {
  if (ids.size === 0) return items;
  return items.map((n) => (ids.has(n.id) ? { ...n, readAt: at } : n));
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
  // markAllRead, resolving true once the server confirmed and false when it
  // refused or didn't answer (the store has rolled its own rows back by then).
  // For a caller with optimistic rows of its own to roll back.
  markAllReadConfirmed: () => Promise<boolean>;
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
  markAllReadConfirmed: async () => false,
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
    // A transient failure just leaves the last-known state.
    const res = await fetchJson(withBasePath("/api/notifications"), {
      init: { credentials: "include" },
      schema: NotificationPageSchema,
    });
    if (!res.ok) {
      failed();
      return;
    }
    if (id !== seq.current) return;
    setItems(res.data.items);
    setUnread(res.data.unreadCount ?? 0);
    setStatus("ready");
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

  const markAllReadConfirmed = useCallback(async (): Promise<boolean> => {
    // Update the screen first ("optimistic"), then tell the server. Clear BOTH
    // the badge count and each row's `readAt` — the bell panel colours rows by
    // `readAt`, so clearing only the count left rows looking unread for up to a
    // minute. We remember exactly which rows we flipped so a failure can undo
    // just those, without disturbing rows a reload has replaced meanwhile.
    // This runs in a click handler, not during render, so calling `new Date()`
    // is fine (guardrail 16).
    const flipped = new Set(items.filter((n) => !n.readAt).map((n) => n.id));
    const prevUnread = unread;
    // Drop every GET already in flight: one served before this write commits
    // would put the rows back to unread.
    const mine = ++seq.current;
    setUnread(0);
    setItems((cur) => withReadAt(cur, flipped, new Date().toISOString()));
    const res = await fetchJson(withBasePath("/api/notifications"), {
      init: jsonInit("POST", {}),
      schema: v.object({ unreadCount: v.optional(v.number()) }),
    });
    // Did a reload start while the write was in flight? Either way it is
    // dropped by the bump below: it may have been served before the write
    // committed.
    const noReloadMeanwhile = seq.current === mine;
    seq.current++;
    // A 2xx whose body can't be read still marked everything: only a refusal
    // or no answer is a failure.
    const confirmed = res.ok || res.kind === "invalid";
    if (!confirmed) {
      // Roll back on a clean 4xx/5xx too, not just a network error, so the
      // panel can't show read locally while the server still has them unread —
      // then re-read the server's truth: the snapshot taken before the write
      // may already be out of date.
      if (noReloadMeanwhile) {
        setUnread(prevUnread);
        setItems((cur) => withReadAt(cur, flipped, null));
      }
      void reload();
      return false;
    }
    setReadAllGen((g) => g + 1);
    // Reconcile the badge with the server's answer (a notification that landed
    // between the last poll and this write stays counted — and is fetched). An
    // unreadable body leaves the optimistic 0 until the next poll.
    const count = res.ok ? res.data.unreadCount : undefined;
    if (count !== undefined) {
      setUnread(count);
      if (count > 0) void reload();
    }
    return true;
  }, [items, unread, reload]);

  const markAllRead = useCallback(async () => {
    await markAllReadConfirmed();
  }, [markAllReadConfirmed]);

  const value = useMemo(
    () => ({ items, unread, status, readAllGen, reload, markAllRead, markAllReadConfirmed }),
    [items, unread, status, readAllGen, reload, markAllRead, markAllReadConfirmed],
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
