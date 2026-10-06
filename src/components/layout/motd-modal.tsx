"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/components/i18n/i18n-provider";

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

// Rendered on the shared Dialog primitive: @base-ui supplies the focus trap,
// Escape, click-outside, scroll lock, return-focus and the aria wiring that a
// previous hand-rolled overlay re-implemented (and had already drifted from
// the primitive's scrim and border).
export function MotdModal({ title, body }: MotdModalProps) {
  // Starts hidden so the first client render matches the server (which renders
  // nothing); the effect below shows it after hydration.
  const [visible, setVisible] = useState(false);
  const t = useT();
  // Initial focus lands on the primary action so Enter/Space dismisses at once
  // (base-ui would otherwise focus the first tabbable — the close X).
  const primaryRef = useRef<HTMLButtonElement>(null);
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

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        // Escape, backdrop click and the close control all arrive here; every
        // way out counts as a dismissal so the announcement stays gone.
        if (!open) dismiss();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-md" initialFocus={primaryRef}>
          <DialogClose
            aria-label={t("shared.common.dismiss")}
            className="ds-hover-tint absolute top-3 right-3 z-10 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 transition-colors"
            style={{ width: 32, height: 32 }}
          >
            <X className="w-5 h-5" />
          </DialogClose>
          <DialogContent>
            {title ? (
              <DialogTitle className="font-bold mb-3 pr-8">{title}</DialogTitle>
            ) : (
              // An untitled announcement still needs an accessible name.
              <DialogTitle className="sr-only">{t("shared.motd.announcement")}</DialogTitle>
            )}

            <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">{body}</p>

            <div className="mt-6 flex justify-end">
              <Button ref={primaryRef} onClick={dismiss}>
                {t("shared.motd.gotIt")}
              </Button>
            </div>
          </DialogContent>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
