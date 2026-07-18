"use client";

// Modal confirmation for deleting a single play record. Pure presentation —
// the parent owns the deleting/error state and the DELETE call.

import type { HistoryRow } from "./types";

export function DeleteConfirm({
  row,
  deleting,
  error,
  onConfirm,
  onCancel,
}: {
  row: HistoryRow;
  deleting: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360,
          padding: 18,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border-strong)",
          borderRadius: 10,
          boxShadow: "var(--ds-shadow-lg)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ds-fg)",
            marginBottom: 6,
            letterSpacing: "-0.01em",
          }}
        >
          Delete this play?
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ds-fg-muted)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          The play record for{" "}
          <span style={{ color: "var(--ds-fg)" }}>{row.title}</span> by{" "}
          <span style={{ color: "var(--ds-fg)" }}>
            {row.mediaServerUser.username}
          </span>{" "}
          will be permanently removed from history.
        </div>
        {error && (
          <div
            role="alert"
            style={{
              fontSize: 12,
              color: "var(--ds-danger)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={deleting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: "var(--ds-danger)",
              border: "1px solid transparent",
              color: "white",
              cursor: deleting ? "default" : "pointer",
              fontWeight: 500,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
