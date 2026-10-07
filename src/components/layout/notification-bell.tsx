"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Bell, Film, Tv2 } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useNotifications } from "@/components/notifications/notification-store";
import { notificationHref } from "@/lib/notification-links";
import { notificationBody } from "@/components/notifications/notification-list";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export function NotificationBell() {
  // Fetching, polling and live (SSE) reloads all happen in the shared
  // NotificationStoreProvider ((app)/layout.tsx). This bell and the mobile
  // nav's badge are both on every page, so sharing one store avoids fetching
  // /api/notifications twice.
  const { items, unread, status, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  // Opening marks everything read (optimistically, before the panel paints),
  // so the unread tint keys off the ids that were unread AT OPEN, not readAt.
  const [unreadAtOpen, setUnreadAtOpen] = useState<ReadonlySet<string>>(() => new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    // Move focus into the panel on open so keyboard users land inside it.
    (panelRef.current?.querySelector<HTMLElement>("a[href], button") ?? panelRef.current)?.focus();
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || btnRef.current?.contains(target)) return;
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
    if (next) setUnreadAtOpen(new Set(items.filter((n) => !n.readAt).map((n) => n.id)));
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
        aria-label={unread > 0 ? t("nav.notificationsUnread", { count: unread }) : t("personal.notifications.title")}
        // The panel is a dialog of plain links, not an ARIA menu — it has no
        // arrow-key roving, so announcing "menu" promised keyboard behaviour it
        // never had.
        aria-haspopup="dialog"
        aria-expanded={open}
        // ds-hover-tint: the same hover/focus recipe as the push bell beside it
        // (guardrail 42 — the background is inline, so a hover class can't win).
        className="ds-hover-tint relative inline-flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
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
              color: "var(--ds-accent-fg)",
              fontSize: 9.5,
              fontWeight: 700,
              lineHeight: "15px",
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            {/* Same cap as the mobile top-bar badge (mobile-nav.tsx). */}
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("personal.notifications.title")}
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
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)" }}>{t("personal.notifications.title")}</span>
          </div>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {/* An empty list is only "No notifications yet" once the store has
                actually loaded; before that it is in flight, and after a failed
                first load it is unknown. Both used to render as empty. */}
            {items.length === 0 && status === "loading" ? (
              <div className="ds-mono" style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                {t("shared.bell.loading")}
              </div>
            ) : items.length === 0 && status === "error" ? (
              // text-red-400 is remapped to --ds-danger, tuned for text on this
              // bg-1 surface (guardrail 42).
              <div role="alert" className="ds-mono text-red-400" style={{ padding: "28px 16px", textAlign: "center", fontSize: 12 }}>
                {t("shared.bell.loadFailed")}
              </div>
            ) : items.length === 0 ? (
              <div className="ds-mono" style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                {t("shared.bell.empty")}
              </div>
            ) : (
              items.map((n) => {
                const poster = posterUrl(n.posterPath, "w342");
                return (
                  <Link
                    key={n.id}
                    href={notificationHref(n)}
                    onClick={() => setOpen(false)}
                    // The unread tint is a class, not an inline style, so the
                    // hover class can win over it. accent-soft, not bg-2: bg-2
                    // is white on this bg-1 panel in the light theme.
                    className={`flex gap-2.5 transition-colors hover:bg-[var(--ds-bg-3)] ${
                      unreadAtOpen.has(n.id) || !n.readAt ? "bg-[var(--ds-accent-soft)]" : ""
                    }`}
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--ds-border)",
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
                      <div style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", lineHeight: 1.35, marginTop: 1 }}>{notificationBody(n, t)}</div>
                      <div className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-subtle)", marginTop: 3 }}>
                        {mounted ? formatRelativeTimeLocalized(n.createdAt, locale) : ""}
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
            className="block text-center transition-colors hover:bg-[var(--ds-bg-3)]"
            style={{ padding: "9px 12px", borderTop: "1px solid var(--ds-border)", fontSize: 12, fontWeight: 500, color: "var(--ds-accent-text)" }}
          >
            {t("shared.bell.viewAll")}
          </Link>
        </div>
      )}
    </div>
  );
}
