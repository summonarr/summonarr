"use client";

import { useState } from "react";
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
const DEL = (body: string) => ({ method: "DELETE", headers: { "Content-Type": "application/json" }, body });

export function NotificationList({ initialItems, initialTotal }: { initialItems: NotificationListItem[]; initialTotal: number }) {
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const mounted = useHasMounted();

  const anyUnread = items.some((n) => !n.readAt);

  async function markAllRead() {
    setItems((cur) => cur.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    await fetch(withBasePath("/api/notifications"), POST("{}")).catch(() => {});
  }
  async function markOneRead(id: string) {
    setItems((cur) => cur.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    await fetch(withBasePath("/api/notifications"), POST(JSON.stringify({ ids: [id] }))).catch(() => {});
  }
  async function removeOne(id: string) {
    const prev = items;
    setItems((cur) => cur.filter((n) => n.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    const res = await fetch(withBasePath("/api/notifications"), DEL(JSON.stringify({ ids: [id] }))).catch(() => null);
    if (!res || !res.ok) {
      setItems(prev);
      setTotal((t) => t + 1);
    }
  }
  async function clearAll() {
    const prevItems = items;
    const prevTotal = total;
    setItems([]);
    setTotal(0);
    const res = await fetch(withBasePath("/api/notifications"), DEL("{}")).catch(() => null);
    if (!res || !res.ok) {
      setItems(prevItems);
      setTotal(prevTotal);
    }
  }
  async function loadMore() {
    setLoading(true);
    try {
      const next = page + 1;
      const res = await fetch(withBasePath(`/api/notifications?page=${next}`));
      if (res.ok) {
        const data = (await res.json()) as { items: NotificationListItem[]; total: number };
        setItems((cur) => [...cur, ...data.items]);
        setTotal(data.total);
        setPage(next);
      }
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

      {items.length < total && (
        <div className="flex justify-center" style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-4 py-1.5 text-xs text-zinc-200 transition-colors"
          >
            {loading ? "Loading…" : `Load more (${total - items.length})`}
          </button>
        </div>
      )}
    </div>
  );
}
