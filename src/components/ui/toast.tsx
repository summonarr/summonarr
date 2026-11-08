"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, AlertTriangle, Bell, X } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { pushCapped } from "@/components/ui/toast-queue";

type ToastVariant = "success" | "error" | "info";
/** One inline button (e.g. "Undo"). Clicking it runs `onClick` and dismisses
    the toast. A toast carrying an action gets the longer error-length timeout,
    so there is time to reach it. */
interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastItem {
  id: number;
  title: string;
  variant: ToastVariant;
  action?: ToastAction;
}
interface ToastInput {
  title: string;
  variant?: ToastVariant;
  action?: ToastAction;
}
interface ToastContextValue {
  toast: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const NO_PROVIDER: ToastContextValue = { toast: () => {} };
let warnedNoProvider = false;

function warnNoProviderOnce() {
  if (warnedNoProvider || process.env.NODE_ENV === "production") return;
  warnedNoProvider = true;
  console.warn("[toast] useToast() called outside <ToastProvider>; toasts will not show");
}

// Fail-soft: a component that calls useToast() outside the provider gets a no-op
// rather than a crash. The provider is mounted at the app root, so this only
// guards against misuse — which development builds say, once, so a component
// rendered outside it doesn't lose its feedback silently.
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  useEffect(() => {
    if (!ctx) warnNoProviderOnce();
  }, [ctx]);
  return ctx ?? NO_PROVIDER;
}

const AUTO_DISMISS_MS = 4000;
// Errors carry a reason the user may need to read in full (a failed Radarr
// push, say), and there's no way to get a toast back once it's gone.
const ERROR_AUTO_DISMISS_MS = 10000;

function dismissAfter(variant: ToastVariant, hasAction = false): number {
  return variant === "error" || hasAction ? ERROR_AUTO_DISMISS_MS : AUTO_DISMISS_MS;
}

const GLYPH_STYLE: React.CSSProperties = { width: 15, height: 15 };

// One entry per variant, so a new variant can't miss its colour or icon.
const VARIANT_LOOK: Record<ToastVariant, { color: string; Icon: typeof Check }> = {
  success: { color: "var(--ds-success)", Icon: Check },
  error: { color: "var(--ds-danger)", Icon: AlertTriangle },
  info: { color: "var(--ds-fg-subtle)", Icon: Bell },
};

/** Timers, the capped list and focus bookkeeping. The list lives in a ref
 *  mirror as well as state, so every change is computed outside a setState
 *  updater (updaters must stay pure) and evicted timers are cleared once. */
function useToastQueue() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const listRef = useRef<ToastItem[]>([]);
  const idRef = useRef(0);
  // Pending auto-dismiss timers by toast id, so a manual dismiss clears its
  // timer and hovering/focusing a toast can pause it.
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Each toast's DOM node, and the element focus came from when it entered
  // one, so removing a focused toast hands focus back instead of to <body>.
  const nodesRef = useRef(new Map<number, HTMLElement>());
  const returnFocusRef = useRef(new Map<number, HTMLElement>());

  const clearTimer = useCallback((id: number) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const commit = useCallback((next: ToastItem[], removed: readonly number[]) => {
    for (const id of removed) {
      clearTimer(id);
      const node = nodesRef.current.get(id);
      const back = returnFocusRef.current.get(id);
      returnFocusRef.current.delete(id);
      if (node && node.contains(document.activeElement) && back?.isConnected) back.focus();
    }
    listRef.current = next;
    setToasts(next);
  }, [clearTimer]);

  const dismiss = useCallback(
    (id: number) => {
      commit(listRef.current.filter((t) => t.id !== id), [id]);
    },
    [commit],
  );

  // (Re)starts the full countdown. Resuming after a pause restarts it rather
  // than tracking the remainder — the reader just finished looking at it.
  const startTimer = useCallback(
    (id: number, variant: ToastVariant, hasAction = false) => {
      clearTimer(id);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), dismissAfter(variant, hasAction)),
      );
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback(
    ({ title, variant = "info", action }: ToastInput) => {
      const id = ++idRef.current;
      const { kept, evicted } = pushCapped(listRef.current, { id, title, variant, action });
      commit(kept, evicted);
      startTimer(id, variant, !!action);
    },
    [commit, startTimer],
  );

  const registerNode = useCallback((id: number, node: HTMLElement | null) => {
    if (node) nodesRef.current.set(id, node);
    else nodesRef.current.delete(id);
  }, []);

  const noteFocusFrom = useCallback((id: number, from: EventTarget | null) => {
    const node = nodesRef.current.get(id);
    if (from instanceof HTMLElement && !(node && node.contains(from))) returnFocusRef.current.set(id, from);
  }, []);

  // The provider sits at the root and normally never unmounts; if it does,
  // no pending dismiss may fire into it.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  return { toasts, toast, dismiss, clearTimer, startTimer, registerNode, noteFocusFrom };
}

type ToastQueue = ReturnType<typeof useToastQueue>;

function ToastCard({ item: t, queue, dismissLabel }: { item: ToastItem; queue: ToastQueue; dismissLabel: string }) {
  const { color, Icon } = VARIANT_LOOK[t.variant];
  return (
    <div
      ref={(node) => queue.registerNode(t.id, node)}
      onPointerEnter={() => queue.clearTimer(t.id)}
      onPointerLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) queue.startTimer(t.id, t.variant, !!t.action);
      }}
      onFocus={(e) => {
        queue.noteFocusFrom(t.id, e.relatedTarget);
        queue.clearTimer(t.id);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) {
          queue.startTimer(t.id, t.variant, !!t.action);
        }
      }}
      className="pointer-events-auto flex items-start gap-2.5 ds-page-enter"
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.4,
        background: "var(--ds-bg-2)",
        color: "var(--ds-fg)",
        border: "1px solid var(--ds-border)",
        boxShadow: "var(--ds-shadow-lg)",
      }}
    >
      <span className="shrink-0" style={{ marginTop: 1, color }}>
        <Icon style={GLYPH_STYLE} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action?.onClick();
            queue.dismiss(t.id);
          }}
          className="ds-hover-tint shrink-0 font-semibold rounded-md"
          // Same negative-margin trick as the dismiss button: a 28px-tall
          // hit box that doesn't grow the row.
          style={{
            minHeight: 28,
            margin: "-5px 0",
            padding: "0 8px",
            fontSize: 13,
            color: "var(--ds-accent-text)",
          }}
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => queue.dismiss(t.id)}
        aria-label={dismissLabel}
        className="ds-hover-tint shrink-0 inline-flex items-center justify-center rounded-md"
        // 28px hit box around the 14px glyph; the negative margins keep
        // the row's height and right edge where the text puts them.
        style={{
          width: 28,
          height: 28,
          margin: "-5px -7px -5px 0",
          color: "var(--ds-fg-subtle)",
        }}
      >
        <X style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}

const STACK_CLASS = "flex flex-col gap-2";

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const tr = useT();
  const queue = useToastQueue();
  const { toasts, toast } = queue;

  // Memoized so consumers don't re-render every time the toast list changes.
  const value = useMemo(() => ({ toast }), [toast]);
  const dismissLabel = tr("shared.common.dismiss");
  const polite = toasts.filter((t) => t.variant !== "error");
  const errors = toasts.filter((t) => t.variant === "error");

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* TWO persistent live regions, siblings in one fixed stack: errors are
          announced assertively, everything else politely. The items carry no
          role, because role="alert"/"status" are live regions themselves and a
          region nested in another can be announced twice; and a region that is
          inserted already holding its text is often not announced at all, so
          the containers stay mounted while empty.
          Below lg the fixed bottom tab bar (mobile-nav.tsx, ≥64px tall) covers
          the bottom-right corner, so the anchor clears it there and drops back
          to 16px once the bar is hidden. */}
      <div
        className="fixed z-[100] flex flex-col pointer-events-none right-4 bottom-[calc(env(safe-area-inset-bottom,0px)_+_80px)] lg:bottom-[calc(env(safe-area-inset-bottom,0px)_+_16px)]"
        style={{ maxWidth: "min(92vw, 380px)" }}
      >
        <div aria-live="polite" className={STACK_CLASS}>
          {polite.map((t) => (
            <ToastCard key={t.id} item={t} queue={queue} dismissLabel={dismissLabel} />
          ))}
        </div>
        {/* The 8px gap between the two stacks only while both hold toasts,
            so an empty region never pushes the other off the anchor. */}
        <div
          aria-live="assertive"
          className={STACK_CLASS}
          style={{ marginTop: polite.length > 0 && errors.length > 0 ? 8 : 0 }}
        >
          {errors.map((t) => (
            <ToastCard key={t.id} item={t} queue={queue} dismissLabel={dismissLabel} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
