"use client";

import { useEffect, useRef, type RefObject } from "react";

// Accessibility wiring shared by the hand-rolled modal overlays (user-modals/*,
// watch-grade). On mount it moves focus into the dialog (an explicit initial
// element, else the first focusable, else the container), traps Tab within the
// container so focus can't escape to the page behind an aria-modal dialog,
// closes on Escape, locks the page's scroll while any overlay is open, and
// restores focus to the opener on unmount. The @base-ui Dialog primitive gives
// all this (plus an inert background) where it's used; this brings the bespoke
// overlays to parity without a full rewrite.
//
// Stacked overlays: only the most recently opened one handles Escape and Tab.
// An Escape an inner control already handled (defaultPrevented) or one that
// ends an IME composition never closes the dialog.
//
// `onClose` is read through a ref, so a fresh callback per render never re-runs
// the focus-in/restore effect. When the opener is gone by the time the dialog
// closes (a menu item that unmounted with its menu), focus goes to
// `returnFocusRef` instead — the menu's trigger, say.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable=\"false\"])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisible(el: HTMLElement): boolean {
  // checkVisibility counts position:fixed descendants, which offsetParent reports as null.
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  return el.getClientRects().length > 0;
}

/** The Tab order inside `container`: focusable, enabled and rendered. Exported for its unit test. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.matches(":disabled") && (isVisible(el) || el === document.activeElement),
  );
}

// Open overlays, oldest first. Only the last one answers the keyboard.
const openModals: object[] = [];

export function isTopModal(token: object): boolean {
  return openModals[openModals.length - 1] === token;
}

/** The modal's keyboard rule for one event, pure over its inputs. Exported for its unit test. */
export function modalKeyAction(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "defaultPrevented">,
  focus: { count: number; atFirst: boolean; atLast: boolean; inside: boolean },
): "close" | "focusContainer" | "focusFirst" | "focusLast" | null {
  if (e.isComposing || e.defaultPrevented) return null;
  if (e.key === "Escape") return "close";
  if (e.key !== "Tab") return null;
  if (focus.count === 0) return "focusContainer";
  if (e.shiftKey) return focus.atFirst || !focus.inside ? "focusLast" : null;
  return focus.atLast || !focus.inside ? "focusFirst" : null;
}

// Page scroll lock, counted across stacked overlays: the first lock hides the
// root's overflow and pads it by the scrollbar's width (so the page doesn't
// shift sideways); the last release puts both back exactly as they were.
type ScrollRoot = { style: { overflow: string; paddingRight: string } };
let scrollLocks = 0;
let savedScroll: { overflow: string; paddingRight: string } | null = null;

/** Lock `root`'s scroll; the returned release is idempotent. Exported for its unit test. */
export function lockPageScroll(root: ScrollRoot, scrollbarWidth: number): () => void {
  if (scrollLocks === 0) {
    savedScroll = { overflow: root.style.overflow, paddingRight: root.style.paddingRight };
    root.style.overflow = "hidden";
    if (scrollbarWidth > 0) root.style.paddingRight = `${scrollbarWidth}px`;
  }
  scrollLocks++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks--;
    if (scrollLocks === 0 && savedScroll) {
      root.style.overflow = savedScroll.overflow;
      root.style.paddingRight = savedScroll.paddingRight;
      savedScroll = null;
    }
  };
}

function restoreFocus(opener: HTMLElement | null, fallback: HTMLElement | null | undefined): void {
  const target = opener?.isConnected ? opener : fallback?.isConnected ? fallback : null;
  target?.focus?.();
}

export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
  returnFocusRef?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const token = {};
    openModals.push(token);
    const root = document.documentElement;
    const unlockScroll = lockPageScroll(root, window.innerWidth - root.clientWidth);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Move focus in: an explicit target, else the first focusable, else the
    // dialog container itself (needs tabIndex={-1} to be focusable).
    const container = containerRef.current;
    const initial = initialFocusRef?.current ?? (container ? focusableWithin(container)[0] : null) ?? container;
    initial?.focus?.();

    function onKey(e: KeyboardEvent) {
      if (!isTopModal(token)) return;
      const focusables = container ? focusableWithin(container) : [];
      const active = document.activeElement;
      const action = modalKeyAction(e, {
        count: focusables.length,
        atFirst: active === focusables[0],
        atLast: active === focusables[focusables.length - 1],
        inside: container?.contains(active) ?? false,
      });
      if (action === null || (!container && action !== "close")) return;
      e.preventDefault();
      if (action === "close") onCloseRef.current();
      // Nothing focusable inside — keep focus on the container, don't leak out.
      else if (action === "focusContainer") container?.focus?.();
      else if (action === "focusFirst") focusables[0].focus();
      else focusables[focusables.length - 1].focus();
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockScroll();
      const at = openModals.indexOf(token);
      if (at >= 0) openModals.splice(at, 1);
      // Read at close on purpose: the fallback is whatever the ref holds then.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      restoreFocus(opener, returnFocusRef?.current);
    };
  }, [containerRef, initialFocusRef, returnFocusRef]);
}
