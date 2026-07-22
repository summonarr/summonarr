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
      <div
        aria-live="polite"
        className="fixed z-[100] flex flex-col gap-2 pointer-events-none"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)", right: 16, maxWidth: "min(92vw, 380px)" }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            aria-live={t.variant === "error" ? "assertive" : "polite"}
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
                    ? "var(--ds-accent)"
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
              className="shrink-0"
              style={{ color: "var(--ds-fg-subtle)", cursor: "pointer", marginTop: 1 }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
