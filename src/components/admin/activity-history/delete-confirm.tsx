"use client";

// Modal confirmation for deleting a single play record. Pure presentation —
// the parent owns the deleting/error state and the DELETE call.

import {
  Dialog,
  DialogBackdrop,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import type { HistoryRow } from "./types";
import { useT } from "@/components/i18n/i18n-provider";

// Splits a translated template on {name} placeholders and drops in nodes.
function rich(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? <span key={i}>{nodes[m[1]]}</span> : part;
  });
}

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
  const t = useT();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Escape and backdrop clicks close the dialog, except while the delete
        // is running (the Cancel button is disabled then too). Closing it early
        // would leave no place to show an error if the delete then failed, and
        // the admin would wrongly believe the play was deleted.
        if (!next && !deleting) onCancel();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          style={{
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border-strong)",
            borderRadius: 10,
            boxShadow: "var(--ds-shadow-lg)",
          }}
        >
        <DialogTitle
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ds-fg)",
            margin: 0,
            marginBottom: 6,
            letterSpacing: "-0.01em",
          }}
        >
          {t("adminActivity.deleteConfirm.title")}
        </DialogTitle>
        <div
          style={{
            fontSize: 12,
            color: "var(--ds-fg-muted)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          {rich(t("adminActivity.deleteConfirm.body"), {
            title: <span style={{ color: "var(--ds-fg)" }}>{row.title}</span>,
            user: (
              <span style={{ color: "var(--ds-fg)" }}>
                {row.mediaServerUser.username}
              </span>
            ),
          })}
          {/* Say how many rows will go. A grouped row is one VIEWING that was
              paused and resumed, so it can stand for several database rows.
              Deleted play history cannot be rebuilt (guardrail 19: the live
              poller is its only writer), so warn before deleting several. */}
          {(row.segmentCount ?? 1) > 1 && (
            <>
              {" "}
              {rich(t("adminActivity.deleteConfirm.sittings"), {
                sittings: (
                  <span style={{ color: "var(--ds-fg)" }}>
                    {t("adminActivity.deleteConfirm.sittingsCount", { count: row.segmentCount ?? 1 })}
                  </span>
                ),
              })}
            </>
          )}
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
            type="button"
            className="ds-hover-tint"
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
            {t("adminActivity.common.cancel")}
          </button>
          <button
            type="button"
            className="ds-hover-tint"
            onClick={onConfirm}
            disabled={deleting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: "var(--ds-danger)",
              border: "1px solid transparent",
              color: "var(--ds-on-status)",
              cursor: deleting ? "default" : "pointer",
              fontWeight: 500,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? t("adminActivity.common.deleting") : t("adminActivity.common.delete")}
          </button>
        </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
