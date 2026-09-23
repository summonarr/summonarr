"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Film, Tv2, Check, X, Bell, Trash2 } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { notificationHref, timeAgo } from "@/lib/notification-links";
import { EmptyState } from "@/components/ui/design";

export interface NotificationListItem {
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

const POST = (body: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });

export function NotificationList({ initialItems, initialTotal }: { initialItems: NotificationListItem[]; initialTotal: number }) {
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [hasMore, setHasMore] = useState(initialItems.length < initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step "Clear all": the first click swaps the link for a confirm + Cancel
  // pair (mirrors vote-actions' dismiss) — it deletes every notification.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const mounted = useHasMounted();
  // A counter bumped every time the whole list is wiped (clearAll). removeOne
  // notes the value when it starts; if it changed by the time its delete fails,
  // it skips putting the row back — otherwise a failed single delete could
  // resurrect a row that a successful clear-all already removed on the server.
  // (Same pattern as watch-history-list's filterGen.)
  const listGen = useRef(0);

  const anyUnread = items.some((n) => !n.readAt);

  async function markAllRead() {
    // Track the exact rows this call flips so the rollback can restore their read
    // state alone: a whole-list snapshot repaints rows a concurrent remove or
    // clear-all already deleted server-side.
    const flipped = new Set(items.filter((n) => !n.readAt).map((n) => n.id));
    setItems((cur) => {
      const at = new Date().toISOString();
      return cur.map((n) => (flipped.has(n.id) ? { ...n, readAt: at } : n));
    });
    const res = await fetch(withBasePath("/api/notifications"), POST("{}")).catch(() => null);
    // Roll back on a clean 4xx/5xx too (not just a thrown/network error) so the
    // list can't show read locally while the server still has them unread.
    if (!res || !res.ok) setItems((cur) => cur.map((n) => (flipped.has(n.id) ? { ...n, readAt: null } : n)));
  }
  async function markOneRead(id: string) {
    const flipped = items.some((n) => n.id === id && !n.readAt);
    if (flipped) setItems((cur) => cur.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    const res = await fetch(withBasePath("/api/notifications"), POST(JSON.stringify({ ids: [id] }))).catch(() => null);
    if ((!res || !res.ok) && flipped) setItems((cur) => cur.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
  }
  async function removeOne(id: string) {
    const gen = listGen.current;
    // Restore only THIS row on failure. A whole-list snapshot resurrected any
    // other row removed (successfully, server-side) while this delete was in
    // flight — the same reason markAllRead tracks its own rows.
    const index = items.findIndex((n) => n.id === id);
    if (index === -1) return;
    const removed = items[index];
    setItems((cur) => cur.filter((n) => n.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    // Selection via query param — DELETE bodies are stripped by some proxies.
    const res = await fetch(withBasePath(`/api/notifications?ids=${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => null);
    // If gen changed, a clear-all happened meanwhile — don't bring the row back.
    if ((!res || !res.ok) && gen === listGen.current) {
      setItems((cur) => {
        if (cur.some((n) => n.id === id)) return cur;
        const next = [...cur];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      setTotal((t) => t + 1);
    }
  }
  async function clearAll() {
    setConfirmingClear(false);
    listGen.current += 1;
    const prevItems = items;
    const prevTotal = total;
    setItems([]);
    setTotal(0);
    setHasMore(false);
    // Ask for "delete all" explicitly with ?all=1 (an empty request never means "all").
    const res = await fetch(withBasePath("/api/notifications?all=1"), { method: "DELETE" }).catch(() => null);
    if (!res || !res.ok) {
      setItems(prevItems);
      setTotal(prevTotal);
      setHasMore(prevItems.length < prevTotal);
    }
  }
  async function loadMore() {
    setLoading(true);
    setError(null);
    try {
      const last = items[items.length - 1];
      const q = last ? `?cursor=${encodeURIComponent(`${last.createdAt}|${last.id}`)}` : "";
      const res = await fetch(withBasePath(`/api/notifications${q}`));
      if (res.ok) {
        const data = (await res.json()) as { items: NotificationListItem[]; total: number; nextCursor: string | null };
        // De-dup by id — a row could have shifted into an already-loaded page as
        // new notifications arrived since the last fetch.
        setItems((cur) => {
          const seen = new Set(cur.map((n) => n.id));
          return [...cur, ...data.items.filter((n) => !seen.has(n.id))];
        });
        setTotal(data.total);
        setHasMore(data.nextCursor != null);
      } else {
        setError("Couldn't load more. Tap Load more to retry.");
      }
    } catch {
      // Always show an error on failure — otherwise a failed load looks the
      // same as having nothing more to load.
      setError("Couldn't load more. Tap Load more to retry.");
    } finally {
      setLoading(false);
    }
  }

  // Only show the empty state when there is nothing left to load either. After
  // removing every loaded row one by one, older notifications may still exist
  // on the server, and the "Load more" button below must stay reachable.
  if (items.length === 0 && !hasMore) {
    return (
      <EmptyState
        icon={Bell}
        title="No notifications yet"
        description="Request updates (approved, available, declined) and replies will show up here."
        cta={{ href: "/requests", label: "View your requests" }}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-3 flex-wrap" style={{ marginBottom: 10 }}>
        {anyUnread && (
          <button type="button" onClick={markAllRead} className="text-xs text-zinc-400 hover:text-zinc-200 underline">
            Mark all read
          </button>
        )}
        {confirmingClear ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={clearAll}
              autoFocus
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Clear all?
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              className="text-xs px-2 py-1.5 text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingClear(true)} className="text-xs text-zinc-500 hover:text-zinc-300 underline">
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-col" style={{ gap: 8 }}>
        {items.map((n) => {
          const poster = posterUrl(n.posterPath, "w342");
          return (
            <div
              key={n.id}
              className={`flex items-start transition-colors border border-[var(--ds-border)] hover:bg-[var(--ds-bg-3)] ${
                n.readAt ? "bg-[var(--ds-bg-1)]" : "bg-[var(--ds-bg-2)]"
              }`}
              style={{ gap: 14, padding: 14, borderRadius: 8 }}
            >
              <Link href={notificationHref(n)} className="flex items-start flex-1 min-w-0 group" style={{ gap: 14 }}>
                <span
                  className="relative shrink-0 overflow-hidden"
                  style={{ width: 44, height: 66, borderRadius: 4, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)" }}
                >
                  {poster ? (
                    <Image src={poster} alt="" fill className="object-cover" sizes="44px" />
                  ) : (
                    <span className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                      {n.mediaType === "TV" ? <Tv2 style={{ width: 16, height: 16 }} /> : <Film style={{ width: 16, height: 16 }} />}
                    </span>
                  )}
                </span>
                <span className="block min-w-0 flex-1">
                  <span
                    className="block font-medium transition-colors group-hover:text-[var(--ds-accent-text)]"
                    style={{ fontSize: 14, color: "var(--ds-fg)" }}
                  >
                    {n.title}
                  </span>
                  <span className="block" style={{ fontSize: 12, color: "var(--ds-fg-muted)", lineHeight: 1.4, marginTop: 2 }}>{n.body}</span>
                  <span className="ds-mono block" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 3 }}>{mounted ? timeAgo(n.createdAt) : ""}</span>
                </span>
              </Link>
              <div className="flex flex-col items-center shrink-0" style={{ gap: 2, margin: "-6px -6px 0 0" }}>
                {!n.readAt && (
                  <button
                    type="button"
                    onClick={() => markOneRead(n.id)}
                    aria-label="Mark read"
                    title="Mark read"
                    className="ds-hover-tint inline-flex items-center justify-center"
                    style={{ width: 32, height: 32, borderRadius: 6, color: "var(--ds-accent-text)" }}
                  >
                    <Check style={{ width: 15, height: 15 }} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeOne(n.id)}
                  aria-label="Remove notification"
                  title="Remove"
                  className="ds-hover-tint inline-flex items-center justify-center"
                  style={{ width: 32, height: 32, borderRadius: 6, color: "var(--ds-fg-subtle)" }}
                >
                  <X style={{ width: 15, height: 15 }} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex flex-col items-center gap-1.5" style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-4 py-1.5 text-xs text-zinc-200 transition-colors"
          >
            {loading ? "Loading…" : `Load more (${total - items.length})`}
          </button>
          {error && (
            <span role="alert" aria-live="assertive" className="text-xs text-red-400">{error}</span>
          )}
        </div>
      )}
    </div>
  );
}
