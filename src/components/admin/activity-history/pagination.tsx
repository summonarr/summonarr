"use client";

// Pagination footer for the history table: rows-per-page select, result-range
// label, and the page-number strip. Page/limit state lives in the parent;
// the range/window values are pure derivations computed here.

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
  const startItem = total > 0 ? (page - 1) * limit + 1 : 0;
  const endItem = Math.min(page * limit, total);
  const pageRange: number[] = [];
  {
    const s = Math.max(1, page - 2);
    const e = Math.min(totalPages, page + 2);
    for (let i = s; i <= e; i++) pageRange.push(i);
  }

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
          Rows
        </span>
        <select
          value={limit}
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
          {[10, 25, 50, 100, 150, 200].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-disabled)",
            marginLeft: 6,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {total > 0
            ? `${startItem.toLocaleString("en-US")}–${endItem.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
            : "0 results"}
        </span>
      </div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {(
          [
            ["«", () => setPage(1), page === 1],
            ["‹", () => setPage(page - 1), page === 1],
          ] as const
        ).map(([label, fn, disabled], idx) => (
          <PageBtn key={idx} onClick={fn} disabled={disabled}>
            {label}
          </PageBtn>
        ))}
        {pageRange[0] > 1 && (
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
        )}
        {pageRange.map((p) => (
          <PageBtn
            key={p}
            onClick={() => setPage(p)}
            active={p === page}
          >
            {p}
          </PageBtn>
        ))}
        {pageRange[pageRange.length - 1] < totalPages && (
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
        )}
        {(
          [
            ["›", () => setPage(page + 1), page >= totalPages],
            ["»", () => setPage(totalPages), page >= totalPages],
          ] as const
        ).map(([label, fn, disabled], idx) => (
          <PageBtn key={idx} onClick={fn} disabled={disabled}>
            {label}
          </PageBtn>
        ))}
      </div>
    </div>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
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
        cursor: disabled ? "default" : "pointer",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </button>
  );
}
