"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Bell, Film, Tv2 } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLiveEvents } from "@/hooks/use-live-events";
import { notificationHref, timeAgo } from "@/lib/notification-links";

interface NotificationItem {
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

const POLL_MS = 60_000;

export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useHasMounted();

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/notifications"), { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: NotificationItem[]; unreadCount: number };
      setItems(data.items ?? []);
      setUnread(data.unreadCount ?? 0);
    } catch {
      // best-effort — a transient failure just leaves the last-known state
    }
  }, []);

  useEffect(() => {
    void load();
    // The interval keeps ticking in hidden tabs (simplest correct shape), but
    // the fetch is skipped there — a background tab doesn't need a fresh badge.
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, POLL_MS);
    // Refresh immediately when the tab becomes visible again so a returning
    // user isn't up to POLL_MS stale.
    function onVisibility() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // Real-time: the server writes an in-app notification alongside these SSE events
  // (scoped to this user server-side), so re-fetch on them for a near-instant badge
  // instead of waiting up to POLL_MS. The 60s poll above stays as the missed-event
  // safety net. Bursts (a sync flipping several requests at once) coalesce into one refetch.
  useLiveEvents((event) => {
    if (
      event.type === "request:updated" ||
      event.type === "issue:updated" ||
      event.type === "issuemessage:created"
    ) {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), 400);
    }
  });

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    // Opening marks everything read: optimistic clear, then persist.
    if (next && unread > 0) {
      setUnread(0);
      try {
        await fetch(withBasePath("/api/notifications"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {
        // ignore — the badge re-appears on the next poll if the write failed
      }
    }
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative inline-flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
        style={{ width: 32, height: 32, color: "var(--ds-fg-muted)" }}
      >
        <Bell style={{ width: 18, height: 18 }} />
        {mounted && unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              minWidth: 15,
              height: 15,
              padding: "0 3px",
              borderRadius: 8,
              background: "var(--ds-accent)",
              color: "var(--ds-accent-contrast, #fff)",
              fontSize: 9.5,
              fontWeight: 700,
              lineHeight: "15px",
              textAlign: "center",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          className="absolute right-0 mt-2 overflow-hidden"
          style={{
            width: 340,
            maxWidth: "calc(100vw - 24px)",
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            boxShadow: "var(--ds-shadow-lg)",
            zIndex: 50,
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: "10px 12px", borderBottom: "1px solid var(--ds-border)" }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)" }}>Notifications</span>
          </div>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {items.length === 0 ? (
              <div className="ds-mono" style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                No notifications yet.
              </div>
            ) : (
              items.map((n) => {
                const poster = posterUrl(n.posterPath, "w342");
                return (
                  <Link
                    key={n.id}
                    href={notificationHref(n)}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex gap-2.5 transition-colors"
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--ds-border)",
                      background: n.readAt ? "transparent" : "var(--ds-bg-2)",
                    }}
                  >
                    <div
                      className="relative shrink-0 overflow-hidden"
                      style={{ width: 34, height: 51, borderRadius: 4, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)" }}
                    >
                      {poster ? (
                        <Image src={poster} alt="" fill className="object-cover" sizes="34px" />
                      ) : (
                        <div className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                          {n.mediaType === "TV" ? <Tv2 style={{ width: 14, height: 14 }} /> : <Film style={{ width: 14, height: 14 }} />}
                        </div>
                      )}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ds-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {n.title}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", lineHeight: 1.35, marginTop: 1 }}>{n.body}</div>
                      <div className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-subtle)", marginTop: 3 }}>
                        {mounted ? timeAgo(n.createdAt) : ""}
                      </div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            role="menuitem"
            className="block text-center transition-colors"
            style={{ padding: "9px 12px", borderTop: "1px solid var(--ds-border)", fontSize: 12, fontWeight: 500, color: "var(--ds-accent)" }}
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}
