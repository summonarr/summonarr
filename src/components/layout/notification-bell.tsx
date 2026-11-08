"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import Image from "next/image";
import { Bell, Film, Tv2 } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useNotifications, type NotificationItem, type NotificationStoreStatus } from "@/components/notifications/notification-store";
import { notificationHref } from "@/lib/notification-links";
import { notificationBody } from "@/components/notifications/notification-list";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { UnreadCountBadge } from "@/components/layout/unread-badge";

export function NotificationBell() {
  // Fetching, polling and live (SSE) reloads all happen in the shared
  // NotificationStoreProvider ((app)/layout.tsx). This bell and the mobile
  // nav's badge are both on every page, so sharing one store avoids fetching
  // /api/notifications twice.
  const { items, unread, status, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  // Opening marks everything read (optimistically, before the panel paints),
  // so the unread tint keys off the ids that were unread AT OPEN — plus any
  // that arrived while it was open — not readAt.
  const [unreadAtOpen, setUnreadAtOpen] = useState<ReadonlySet<string>>(() => new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const mounted = useHasMounted();
  const t = useT();

  useDismissOnOutside(open, panelRef, btnRef, setOpen);
  useMarkReadWhileOpen(open, items, unread, markAllRead, setUnreadAtOpen);

  function toggle() {
    const next = !open;
    if (next) setUnreadAtOpen(new Set(items.filter((n) => !n.readAt).map((n) => n.id)));
    setOpen(next);
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
        {mounted && <UnreadCountBadge count={unread} size="md" />}
      </button>

      {open && (
        <BellPanel
          panelRef={panelRef}
          btnRef={btnRef}
          items={items}
          status={status}
          unreadAtOpen={unreadAtOpen}
          mounted={mounted}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// While the panel is open: an outside click closes it, Escape closes it and
// hands focus back to the bell, and focus moves into the panel on open so
// keyboard users land inside it.
function useDismissOnOutside(
  open: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  btnRef: RefObject<HTMLButtonElement | null>,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
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
  }, [open, panelRef, btnRef, setOpen]);
}

// Opening the panel marks everything read — including notifications that land
// while it is open. The panel can open before the store's first load (unread
// still 0), and rows that arrive then are on screen: without this they stayed
// unread and the badge came back on close. Each id is attempted once per
// opening, so a failed mark (the store rolls the rows back) can't loop.
function useMarkReadWhileOpen(
  open: boolean,
  items: readonly NotificationItem[],
  unread: number,
  markAllRead: () => Promise<void>,
  setUnreadAtOpen: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void,
) {
  const attempted = useRef<{ ids: Set<string>; opened: boolean }>({ ids: new Set(), opened: false });
  useEffect(() => {
    if (!open) {
      attempted.current = { ids: new Set(), opened: false };
      return;
    }
    const seen = attempted.current;
    const fresh = items.filter((n) => !n.readAt && !seen.ids.has(n.id)).map((n) => n.id);
    // The count can cover rows the list doesn't hold, so the first pass after
    // opening also marks on the count alone.
    const firstPass = !seen.opened;
    seen.opened = true;
    if (fresh.length === 0 && !(firstPass && unread > 0)) return;
    for (const id of fresh) seen.ids.add(id);
    if (fresh.length > 0) setUnreadAtOpen((prev) => new Set([...prev, ...fresh]));
    void markAllRead();
  }, [open, items, unread, markAllRead, setUnreadAtOpen]);
}

function BellPanel({
  panelRef,
  btnRef,
  items,
  status,
  unreadAtOpen,
  mounted,
  onClose,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  btnRef: RefObject<HTMLButtonElement | null>;
  items: readonly NotificationItem[];
  status: NotificationStoreStatus;
  unreadAtOpen: ReadonlySet<string>;
  mounted: boolean;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("personal.notifications.title")}
      tabIndex={-1}
      // Tabbing past the last link leaves a non-modal panel floating over
      // the page: close it once focus has left both it and the bell. Focus
      // is NOT pulled back — the user tabbed onward on purpose. (A blur to
      // nowhere — relatedTarget null, e.g. the window losing focus — keeps
      // it open; the outside click / Escape paths still close it.)
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || panelRef.current?.contains(next) || btnRef.current?.contains(next)) return;
        onClose();
      }}
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
        {items.length === 0 ? (
          <BellEmpty status={status} />
        ) : (
          items.map((n) => (
            <BellRow
              key={n.id}
              n={n}
              unread={unreadAtOpen.has(n.id) || !n.readAt}
              mounted={mounted}
              onNavigate={onClose}
            />
          ))
        )}
      </div>
      <Link
        href="/notifications"
        onClick={onClose}
        className="block text-center transition-colors hover:bg-[var(--ds-bg-3)]"
        style={{ padding: "9px 12px", borderTop: "1px solid var(--ds-border)", fontSize: 12, fontWeight: 500, color: "var(--ds-accent-text)" }}
      >
        {t("shared.bell.viewAll")}
      </Link>
    </div>
  );
}

const EMPTY_STYLE = { padding: "28px 16px", textAlign: "center", fontSize: 12 } as const;

// An empty list is only "No notifications yet" once the store has actually
// loaded; before that it is in flight, and after a failed first load it is
// unknown. Both used to render as empty.
function BellEmpty({ status }: { status: NotificationStoreStatus }) {
  const t = useT();
  if (status === "error") {
    // text-red-400 is remapped to --ds-danger, tuned for text on this bg-1
    // surface (guardrail 42).
    return (
      <div role="alert" className="ds-mono text-red-400" style={EMPTY_STYLE}>
        {t("shared.bell.loadFailed")}
      </div>
    );
  }
  return (
    <div className="ds-mono" style={{ ...EMPTY_STYLE, color: "var(--ds-fg-subtle)" }}>
      {status === "loading" ? t("shared.bell.loading") : t("shared.bell.empty")}
    </div>
  );
}

function BellRow({
  n,
  unread,
  mounted,
  onNavigate,
}: {
  n: NotificationItem;
  unread: boolean;
  mounted: boolean;
  onNavigate: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  // The thumbnail renders at 34px: the smallest TMDB poster (92px) covers it
  // at 2x without the optimizer fetching the 342px source for every row.
  const poster = posterUrl(n.posterPath, "w92");
  return (
    <Link
      href={notificationHref(n)}
      onClick={onNavigate}
      // The unread tint is a class, not an inline style, so the hover class
      // can win over it. accent-soft, not bg-2: bg-2 is white on this bg-1
      // panel in the light theme.
      className={`flex gap-2.5 transition-colors hover:bg-[var(--ds-bg-3)] ${unread ? "bg-[var(--ds-accent-soft)]" : ""}`}
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
}
