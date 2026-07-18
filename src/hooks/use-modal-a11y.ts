"use client";

import { useEffect, type RefObject } from "react";

// Accessibility wiring shared by the hand-rolled modal overlays (user-modals/*,
// motd-modal). On mount it moves focus into the dialog (an explicit initial
// element, else the container), traps Tab within the container so focus can't
// escape to the page behind an aria-modal dialog, closes on Escape, and restores
// focus to the opener on unmount. The @base-ui Dialog primitive gives all this
// for free where it's used; this brings the bespoke overlays to parity without a
// full rewrite.
//
// `containerRef` and `onClose` (and the optional `initialFocusRef`) must be
// stable across renders for the effect deps — refs are stable; pass a
// useCallback'd or otherwise-stable onClose.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Move focus in: an explicit target, else the first focusable, else the
    // dialog container itself (needs tabIndex={-1} to be focusable).
    const container = containerRef.current;
    const initial = initialFocusRef?.current ?? (container ? focusableWithin(container)[0] : null) ?? container;
    initial?.focus?.();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const focusables = focusableWithin(container);
      if (focusables.length === 0) {
        // Nothing focusable inside — keep focus on the container, don't leak out.
        e.preventDefault();
        container.focus?.();
        return;
      }
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
      opener?.focus?.();
    };
  }, [containerRef, onClose, initialFocusRef]);
}
