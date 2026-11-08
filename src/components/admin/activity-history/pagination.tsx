"use client";

// Pagination footer for the history table: rows-per-page select, result-range
// label, and the page-number strip. The page and page-size state live in the
// parent; which numbers to show is the shared pager window (pager-window.ts),
// the same ±2 strip the browse pages draw.

import type { ReactNode } from "react";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { pagerWindow } from "@/lib/pager-window";
import { PAGE_SIZES } from "./types";

function Ellipsis() {
  return (
    <span
      className="ds-mono"
      style={{
        color: "var(--ds-fg-disabled)",
        fontSize: 11,
        padding: "0 4px",
      }}
    >
      …
    </span>
  );
}

export function HistoryPagination({
  page,
  setPage,
  limit,
  setLimit,
  total,
  totalPages,
}: {
  page: number;
  setPage: (p: number) => void;
  limit: number;
  setLimit: (n: number) => void;
  total: number;
  totalPages: number;
}) {
  const t = useT();
  const locale = useLocale();
  const startItem = total > 0 ? (page - 1) * limit + 1 : 0;
  const endItem = Math.min(page * limit, total);
  const { pages: pageRange } = pagerWindow(page, totalPages);
  const atFirst = page === 1;
  const atLast = page >= totalPages;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 0 0",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          className="ds-mono"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
        >
          {t("adminActivity.pagination.rows")}
        </span>
        <select
          value={limit}
          aria-label={t("adminActivity.pagination.rowsPerPage")}
          onChange={(e) => setLimit(Number(e.target.value))}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "3px 7px",
            background: "var(--ds-bg-1)",
            color: "var(--ds-fg)",
            border: "1px solid var(--ds-border)",
            borderRadius: 5,
            cursor: "pointer",
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            marginLeft: 6,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {total > 0
            ? t("adminActivity.pagination.range", {
                start: startItem.toLocaleString(locale),
                end: endItem.toLocaleString(locale),
                total: total.toLocaleString(locale),
              })
            : t("adminActivity.pagination.noResults")}
        </span>
      </div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <PageBtn onClick={() => setPage(1)} disabled={atFirst} ariaLabel={t("adminActivity.pagination.first")}>
          «
        </PageBtn>
        <PageBtn onClick={() => setPage(page - 1)} disabled={atFirst} ariaLabel={t("adminActivity.pagination.previous")}>
          ‹
        </PageBtn>
        {pageRange[0] > 1 && <Ellipsis />}
        {pageRange.map((p) => (
          <PageBtn
            key={p}
            onClick={() => setPage(p)}
            active={p === page}
          >
            {p}
          </PageBtn>
        ))}
        {pageRange[pageRange.length - 1] < totalPages && <Ellipsis />}
        <PageBtn onClick={() => setPage(page + 1)} disabled={atLast} ariaLabel={t("adminActivity.pagination.next")}>
          ›
        </PageBtn>
        <PageBtn onClick={() => setPage(totalPages)} disabled={atLast} ariaLabel={t("adminActivity.pagination.last")}>
          »
        </PageBtn>
      </div>
    </div>
  );
}

// `ariaLabel` names the glyph-only buttons (« ‹ › »), which a screen reader
// would otherwise announce as punctuation.
function PageBtn({
  children,
  onClick,
  disabled,
  active,
  ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className="ds-mono"
      style={{
        minWidth: 26,
        height: 26,
        padding: "0 6px",
        fontSize: 11,
        background: active ? "var(--ds-accent)" : "transparent",
        color: active
          ? "var(--ds-accent-fg)"
          : disabled
            ? "var(--ds-fg-disabled)"
            : "var(--ds-fg-muted)",
        border: "1px solid",
        borderColor: active ? "transparent" : "var(--ds-border)",
        borderRadius: 5,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </button>
  );
}
