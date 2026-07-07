import type { ReactNode } from "react";

// Shared empty-state block for list pages (requests, votes, issues, …). Replaces
// the hand-rolled "ds-mono dashed" copies that were duplicated per page and had
// begun to drift. Presentational only (no "use client", no hooks) so it renders
// inside server components. Pass the message (often a filter-aware ternary) as
// children.
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-center ds-mono"
      style={{
        padding: "40px 20px",
        background: "var(--ds-bg-1)",
        border: "1px dashed var(--ds-border)",
        borderRadius: 8,
        fontSize: 12,
        color: "var(--ds-fg-subtle)",
      }}
    >
      {children}
    </div>
  );
}
