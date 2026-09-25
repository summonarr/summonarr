"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";

interface MotdModalProps {
  title: string;
  body: string;
}

// The "dismissed" flag's storage key is built from the announcement's TEXT.
// With one fixed key, dismissing an old message would also hide any new or
// edited one for the rest of the tab session. The hash is FNV-1a: a short,
// stable fingerprint of the text, not a security hash.
function contentKey(title: string, body: string): string {
  const raw = `${title}\n${body}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `motd_dismissed:${(h >>> 0).toString(36)}`;
}

export function MotdModal({ title, body }: MotdModalProps) {
  // Starts hidden so the first client render matches the server (which renders
  // nothing); the effect below shows it after hydration.
  const [visible, setVisible] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = "motd-modal-title";
  const sessionKey = contentKey(title, body);

  // sessionStorage throws (SecurityError) when site data is blocked, and an
  // effect that throws takes the whole (app) layout down to its error
  // boundary. Unreadable storage just means "not dismissed yet".
  useEffect(() => {
    if (!body) return;
    try {
      if (sessionStorage.getItem(sessionKey)) return;
    } catch {
      // fall through and show it
    }
    setVisible(true);
  }, [body, sessionKey]);

  const dismiss = useCallback(() => {
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {
      // dismissal just won't persist across reloads
    }
    setVisible(false);
  }, [sessionKey]);

  // Focus a sensible element on open, return focus to the opener on close, ESC closes.
  useEffect(() => {
    if (!visible) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    // Focus the primary action ("Got it") so Enter/Space dismisses immediately.
    const primary =
      dialogRef.current?.querySelector<HTMLElement>("[data-motd-primary]") ??
      dialogRef.current?.querySelector<HTMLElement>("[aria-label='Dismiss']");
    primary?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      // Trap Tab within the dialog so focus can't leak to the page behind this
      // aria-modal overlay.
      if (e.key !== "Tab") return;
      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [visible, dismiss]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Announcement"}
        className="relative w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-700 shadow-[var(--ds-shadow-lg)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={dismiss}
          className="ds-hover-tint absolute top-3 right-3 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 transition-colors"
          style={{ width: 32, height: 32 }}
          aria-label="Dismiss"
        >
          <X className="w-5 h-5" />
        </button>

        {title && (
          <h2
            id={titleId}
            className="text-lg font-bold text-zinc-100 mb-3 pr-8"
          >
            {title}
          </h2>
        )}

        <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">{body}</p>

        <div className="mt-6 flex justify-end">
          <Button data-motd-primary onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
