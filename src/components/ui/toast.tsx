"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Check, AlertTriangle, Bell, X } from "@/components/icons";

type ToastVariant = "success" | "error" | "info";
interface ToastItem {
  id: number;
  title: string;
  variant: ToastVariant;
}
interface ToastContextValue {
  toast: (t: { title: string; variant?: ToastVariant }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Fail-soft: a component that calls useToast() outside the provider gets a no-op
// rather than a crash. The provider is mounted at the app root, so this only
// guards against misuse.
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? { toast: () => {} };
}

const AUTO_DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ title, variant = "info" }: { title: string; variant?: ToastVariant }) => {
      const id = ++idRef.current;
      setToasts((cur) => [...cur, { id, title, variant }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  // Memoized so consumers don't re-render every time the toast list changes.
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* One live region on the container; the items carry only a role. Nesting
          aria-live on both made screen readers announce each toast twice.
          Below lg the fixed bottom tab bar (mobile-nav.tsx, ≥64px tall) covers
          the bottom-right corner, so the anchor clears it there and drops back
          to 16px once the bar is hidden. */}
      <div
        aria-live="polite"
        className="fixed z-[100] flex flex-col gap-2 pointer-events-none right-4 bottom-[calc(env(safe-area-inset-bottom,0px)_+_80px)] lg:bottom-[calc(env(safe-area-inset-bottom,0px)_+_16px)]"
        style={{ maxWidth: "min(92vw, 380px)" }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
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
            <span
              className="shrink-0"
              style={{
                marginTop: 1,
                color:
                  t.variant === "success"
                    ? "var(--ds-success)"
                    : t.variant === "error"
                      ? "var(--ds-danger)"
                      : "var(--ds-fg-subtle)",
              }}
            >
              {t.variant === "success" ? (
                <Check style={{ width: 15, height: 15 }} />
              ) : t.variant === "error" ? (
                <AlertTriangle style={{ width: 15, height: 15 }} />
              ) : (
                <Bell style={{ width: 15, height: 15 }} />
              )}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
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
        ))}
      </div>
    </ToastContext.Provider>
  );
}
