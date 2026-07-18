"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";

interface MotdModalProps {
  title: string;
  body: string;
}

const SESSION_KEY = "motd_dismissed";

export function MotdModal({ title, body }: MotdModalProps) {
  // Effect flips visibility after hydration; initial render matches SSR (null) to avoid hydration mismatch
  const [visible, setVisible] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = "motd-modal-title";

  useEffect(() => {
    if (!body) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;
    setVisible(true);
  }, [body]);

  const dismiss = useCallback(() => {
    sessionStorage.setItem(SESSION_KEY, "1");
    setVisible(false);
  }, []);

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Announcement"}
        className="relative w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-5 h-5" />
        </button>

        {title && (
          <h2
            id={titleId}
            className="text-lg font-bold text-white mb-3 pr-8"
          >
            {title}
          </h2>
        )}

        <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">{body}</p>

        <div className="mt-6 flex justify-end">
          <Button
            data-motd-primary
            onClick={dismiss}
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
