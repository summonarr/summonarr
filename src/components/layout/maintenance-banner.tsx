"use client";

import { Wrench, X } from "@/components/icons";
import { useState } from "react";

// Admin-only strip shown while maintenance mode is on (non-admins see
// MaintenancePage instead). Styled like the login page's maintenance notice:
// a warning-tinted background, normal text colour, and the warning colour only
// on the icon so the text stays readable in both themes.
export function MaintenanceBanner({ message }: { message?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-4"
      style={{
        paddingTop: 6,
        paddingBottom: 6,
        background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
        borderBottom: "1px solid color-mix(in oklab, var(--ds-warning) 28%, transparent)",
      }}
    >
      <Wrench className="shrink-0" style={{ width: 14, height: 14, color: "var(--ds-warning)" }} />
      <p className="text-sm flex-1 m-0" style={{ color: "var(--ds-fg)" }}>
        <span className="font-medium">Maintenance mode is active.</span>
        {message && (
          <span className="ml-1" style={{ color: "var(--ds-fg-muted)" }}>
            {message}
          </span>
        )}
        <span className="ml-1" style={{ color: "var(--ds-fg-muted)" }}>
          Non-admin users are blocked.
        </span>
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ds-hover-tint shrink-0 inline-flex items-center justify-center rounded-md transition-colors"
        style={{ width: 32, height: 32, color: "var(--ds-fg-muted)" }}
        aria-label="Dismiss maintenance banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
