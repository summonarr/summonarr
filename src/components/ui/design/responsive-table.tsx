"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  label: React.ReactNode;
  render?: (row: T) => React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  wrap?: boolean;
  width?: string | number;
  hideOnMobile?: boolean;
};

/**
 * Responsive table. Renders a classic `<table>` at ≥640px and a stack of
 * labelled cards below that breakpoint.
 *
 * Convention: a column with `key === "act"` is treated as the action column
 * and rendered as a trailing block on the mobile card variant.
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  onRowClick,
  dense,
  className,
  rowKey,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  onRowClick?: (row: T) => void;
  dense?: boolean;
  className?: string;
  rowKey?: (row: T, index: number) => React.Key;
}) {
  const cardColumns = columns.filter(
    (c) => c.key !== "act" && !c.hideOnMobile,
  );
  const primaryCol = cardColumns[0];
  const restCols = cardColumns.slice(1);
  const actionCol = columns.find((c) => c.key === "act");
  const keyFor = (r: T, i: number) => rowKey?.(r, i) ?? i;

  return (
    <div className={className}>
      {/* Desktop / tablet */}
      <div
        className="ds-resp-table-grid"
        style={{
          background: "var(--ds-bg-2)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
          overflow: "auto",
        }}
      >
        <table
          style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}
        >
          <thead>
            <tr
              style={{
                background: "var(--ds-bg-1)",
                borderBottom: "1px solid var(--ds-border)",
              }}
            >
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="ds-mono"
                  style={{
                    textAlign: "left",
                    padding: dense ? "6px 12px" : "9px 14px",
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: "var(--ds-fg-subtle)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    whiteSpace: "nowrap",
                    width: c.width,
                  }}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={keyFor(r, i)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={{
                  borderBottom:
                    i === rows.length - 1
                      ? "none"
                      : "1px solid var(--ds-border)",
                  cursor: onRowClick ? "pointer" : "default",
                  transition: "background 100ms var(--ds-ease)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--ds-bg-3)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      padding: dense ? "8px 12px" : "12px 14px",
                      color: c.muted
                        ? "var(--ds-fg-muted)"
                        : "var(--ds-fg)",
                      fontFamily: c.mono
                        ? "var(--font-geist-mono, ui-monospace, monospace)"
                        : "inherit",
                      fontSize: c.mono ? 11.5 : 13,
                      whiteSpace: c.wrap ? "normal" : "nowrap",
                      verticalAlign: "middle",
                    }}
                  >
                    {c.render
                      ? c.render(r)
                      : ((r as Record<string, React.ReactNode>)[c.key] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <div className={cn("ds-resp-table-card", "ds-resp-table-stack")}>
        {rows.map((r, i) => (
          <div
            key={keyFor(r, i)}
            className="ds-resp-row-card ds-tap"
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            style={{ cursor: onRowClick ? "pointer" : "default" }}
          >
            {primaryCol && (
              <div style={{ marginBottom: 2 }}>
                {primaryCol.render
                  ? primaryCol.render(r)
                  : ((r as Record<string, React.ReactNode>)[primaryCol.key] ??
                    null)}
              </div>
            )}
            {restCols.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginTop: 4,
                  paddingTop: 6,
                  borderTop: "1px dashed var(--ds-border)",
                }}
              >
                {restCols.map((c) => (
                  <div key={c.key} className="ds-resp-kv">
                    <span className="ds-resp-kv-k">{c.label}</span>
                    <span
                      className="ds-resp-kv-v"
                      style={{
                        fontFamily: c.mono
                          ? "var(--font-geist-mono, ui-monospace, monospace)"
                          : "inherit",
                        fontSize: c.mono ? 11.5 : 13,
                      }}
                    >
                      {c.render
                        ? c.render(r)
                        : ((r as Record<string, React.ReactNode>)[c.key] ??
                          null)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {actionCol?.render && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: "1px solid var(--ds-border)",
                }}
              >
                {actionCol.render(r)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
