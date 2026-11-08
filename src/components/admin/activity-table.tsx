// The Activity tables' header and body cells and their small icons, shared by
// the history, recent-plays, title and user views. Plain components with no
// hooks; the colours are tokens (guardrail 42).

import type { ReactNode } from "react";

/* ── Table header / sort / chevron ────────────────────────────── */

export function ChevIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 150ms var(--ds-ease)",
        color: "var(--ds-fg-subtle)",
      }}
    >
      <path
        d="M4.5 3l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SortIcon({
  active,
  dir,
}: {
  active: boolean;
  dir?: "asc" | "desc";
}) {
  if (!active) {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        style={{ opacity: 0.3, color: "currentColor" }}
      >
        <path
          d="M4 5l2-2 2 2M4 7l2 2 2-2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      style={{ color: "var(--ds-accent-text)" }}
    >
      {dir === "asc" ? (
        <path
          d="M3 7l3-3 3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3 5l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function Th({
  label,
  onSort,
  active,
  dir,
  width,
  align = "left",
}: {
  label?: string;
  onSort?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      aria-sort={onSort ? (active ? (dir === "asc" ? "ascending" : "descending") : "none") : undefined}
      style={{
        textAlign: align,
        padding: "10px 11px",
        fontSize: 9.5,
        fontWeight: 500,
        color: active ? "var(--ds-fg)" : "var(--ds-fg-subtle)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--ds-border)",
        whiteSpace: "nowrap",
        userSelect: "none",
        width,
        fontFamily: "var(--font-mono)",
      }}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            justifyContent: align === "right" ? "flex-end" : "flex-start",
            width: "100%",
            padding: 0,
            border: 0,
            background: "transparent",
            color: "inherit",
            font: "inherit",
            letterSpacing: "inherit",
            textTransform: "inherit",
          }}
        >
          <span>{label}</span>
          <SortIcon active={!!active} dir={dir} />
        </button>
      ) : (
        label
      )}
    </th>
  );
}

// A body cell of the Activity tables: the shared padding and no-wrap, plus the
// few things that vary per column. Colours are tokens (guardrail 42).
export function Td({
  children,
  mono = false,
  color,
  align,
  tabular = false,
  fontSize,
}: {
  children?: ReactNode;
  mono?: boolean;
  color?: string;
  align?: "right";
  tabular?: boolean;
  fontSize?: number;
}) {
  return (
    <td
      className={mono ? "ds-mono" : undefined}
      style={{
        padding: "10px 14px",
        color,
        fontSize,
        textAlign: align,
        fontVariantNumeric: tabular ? "tabular-nums" : undefined,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
