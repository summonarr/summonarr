"use client";

// The History table's header row and its one-cell status rows (first load,
// failed load, no match, an inverted date range). Presentational: the table
// owns the state and hands in what to show.

import type { ReactNode } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { Th } from "@/components/admin/activity-ui";
import type { SortDir, SortField } from "./types";

export function HistoryTableHead({
  sortBy,
  sortDir,
  onSort,
}: {
  sortBy: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const t = useT();
  const sortable = (field: SortField) => ({
    onSort: () => onSort(field),
    active: sortBy === field,
    dir: sortDir,
  });
  return (
    <thead>
      <tr style={{ background: "var(--ds-bg-1)" }}>
        <Th width={28} />
        <Th label={t("adminActivity.field.user")} />
        <Th label={t("adminActivity.field.title")} {...sortable("title")} />
        <Th label={t("adminActivity.field.started")} {...sortable("startedAt")} />
        <Th label={t("adminActivity.field.length")} {...sortable("duration")} align="right" />
        <Th label={t("adminActivity.field.watched")} {...sortable("playDuration")} align="right" />
        <Th label={t("adminActivity.field.stream")} />
        <Th label={t("adminActivity.field.quality")} />
        <Th label={t("adminActivity.field.platform")} {...sortable("platform")} />
        <Th width={48} align="right" />
      </tr>
    </thead>
  );
}

// One full-width message row in place of the plays.
export function HistoryStatusRow({
  colSpan,
  tone = "subtle",
  fontSize,
  children,
}: {
  colSpan: number;
  tone?: "subtle" | "danger";
  fontSize?: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: "60px 20px",
          textAlign: "center",
          color: tone === "danger" ? "var(--ds-danger)" : "var(--ds-fg-subtle)",
          fontSize,
        }}
      >
        {children}
      </td>
    </tr>
  );
}

// A failed load: copy an admin can act on, with a Retry beside it.
export function HistoryLoadError({ colSpan, message, onRetry }: { colSpan: number; message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <HistoryStatusRow colSpan={colSpan} tone="danger">
      <div role="alert">{message}</div>
      <button
        type="button"
        className="ds-hover-tint"
        onClick={onRetry}
        style={{
          marginTop: 10,
          fontSize: 12,
          padding: "5px 12px",
          borderRadius: 6,
          background: "transparent",
          border: "1px solid var(--ds-border)",
          color: "var(--ds-fg-muted)",
        }}
      >
        {t("adminActivity.common.retry")}
      </button>
    </HistoryStatusRow>
  );
}
