"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Film, Tv2, Check, X } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { notificationHref, timeAgo } from "@/lib/notification-links";
import { EmptyState } from "@/components/ui/empty-state";

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
  const mounted = useHasMounted();
  // Bumped by any list-wiping op (clearAll). An in-flight removeOne records the
  // generation at start and skips its whole-list rollback if it changed — else a
  // failed single-delete could restore a stale list a successful clear-all
  // already wiped server-side. (Pattern mirrors watch-history-list's filterGen.)
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
    const prev = items;
    setItems((cur) => cur.filter((n) => n.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    // Selection via query param — DELETE bodies are stripped by some proxies.
    const res = await fetch(withBasePath(`/api/notifications?ids=${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => null);
    if ((!res || !res.ok) && gen === listGen.current) {
      // A clear-all landed while this was in flight — don't resurrect the list.
      setItems(prev);
      setTotal((t) => t + 1);
    }
  }
  async function clearAll() {
    listGen.current += 1;
    const prevItems = items;
    const prevTotal = total;
    setItems([]);
    setTotal(0);
    setHasMore(false);
    // Explicit clear-all signal (never "empty body means all").
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
        setError("Couldn't load more. Tap to retry.");
      }
    } catch {
      // `if (res.ok)` with no else meant a failed page load did nothing at all:
      // the spinner stopped, the list was unchanged, and "Load more" sat there
      // looking like it had simply reached the end.
      setError("Couldn't load more. Tap to retry.");
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return <EmptyState>No notifications yet. Request updates (approved / available / declined) will show up here.</EmptyState>;
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-3" style={{ marginBottom: 10 }}>
        {anyUnread && (
          <button type="button" onClick={markAllRead} className="text-xs text-zinc-400 hover:text-zinc-200 underline">
            Mark all read
          </button>
        )}
        <button type="button" onClick={clearAll} className="text-xs text-zinc-500 hover:text-zinc-300 underline">
          Clear all
        </button>
      </div>

      <div className="flex flex-col" style={{ gap: 8 }}>
        {items.map((n) => {
          const poster = posterUrl(n.posterPath, "w342");
          return (
            <div
              key={n.id}
              className="flex gap-3 items-start"
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: n.readAt ? "var(--ds-bg-1)" : "var(--ds-bg-2)",
                border: "1px solid var(--ds-border)",
              }}
            >
              <Link href={notificationHref(n)} className="relative shrink-0 overflow-hidden" style={{ width: 40, height: 60, borderRadius: 4, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)" }}>
                {poster ? (
                  <Image src={poster} alt="" fill className="object-cover" sizes="40px" />
                ) : (
                  <span className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                    {n.mediaType === "TV" ? <Tv2 style={{ width: 16, height: 16 }} /> : <Film style={{ width: 16, height: 16 }} />}
                  </span>
                )}
              </Link>
              <Link href={notificationHref(n)} className="min-w-0 flex-1">
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)" }}>{n.title}</div>
                <div style={{ fontSize: 12, color: "var(--ds-fg-muted)", lineHeight: 1.4, marginTop: 1 }}>{n.body}</div>
                <div className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 3 }}>{mounted ? timeAgo(n.createdAt) : ""}</div>
              </Link>
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                {!n.readAt && (
                  <button type="button" onClick={() => markOneRead(n.id)} aria-label="Mark read" title="Mark read" style={{ color: "var(--ds-accent)", cursor: "pointer" }}>
                    <Check style={{ width: 15, height: 15 }} />
                  </button>
                )}
                <button type="button" onClick={() => removeOne(n.id)} aria-label="Remove notification" title="Remove" style={{ color: "var(--ds-fg-subtle)", cursor: "pointer" }}>
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
