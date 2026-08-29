"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Bell, Film, Tv2 } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useNotifications } from "@/components/notifications/notification-store";
import { notificationHref, timeAgo } from "@/lib/notification-links";

export function NotificationBell() {
  // Fetching, polling and the SSE reload all live in NotificationStoreProvider
  // ((app)/layout.tsx). This component used to own them, and so did the mobile
  // nav's badge — both are mounted at every viewport (the breakpoints are CSS,
  // not React), so every page load issued two identical GET /api/notifications.
  // See the note on the store.
  const { items, unread, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const mounted = useHasMounted();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    // Move focus into the panel on open so keyboard users land inside it (was
    // relying on Tab reaching the links after the trigger).
    (panelRef.current?.querySelector<HTMLElement>("a[href], button") ?? panelRef.current)?.focus();
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus(); // return focus to the bell on dismiss
      }
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
    // Opening marks everything read.
    if (next && unread > 0) await markAllRead();
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
          tabIndex={-1}
          className="absolute right-0 mt-2 overflow-hidden outline-none"
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
