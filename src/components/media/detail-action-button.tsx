"use client";

import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// One shared style for every action button on the movie/TV detail pages
// (request, 4K, watchlist, hide, trailer, report, vote, …) and for the
// non-clickable status pills shown in their place ("Available in 4K").
// Keeping it in one place stops the copies drifting apart.
//
// Backgrounds are inline styles, and a CSS :hover class can't override an
// inline background, so hover uses `ds-hover-tint` (an inset tint plus a
// keyboard focus ring). The pointer cursor comes from a global
// `button:not(:disabled)` rule, so never add `cursor-pointer` here.

export type DetailActionVariant =
  | "primary" // accent CTA
  | "secondary" // neutral surface (default)
  | "ghost" // transparent, muted text (Cancel)
  | "danger" // solid danger (a destructive confirm)
  | "accent-soft" // done / toggle-on (View Request, On Watchlist)
  | "danger-soft" // destructive toggle-on (Voted to Delete)
  | "muted"; // inert (Not available to request)

export type DetailActionSize = "md" | "sm";

const VARIANT_STYLE: Record<DetailActionVariant, CSSProperties> = {
  primary: { background: "var(--ds-accent)", color: "var(--ds-accent-fg)", border: "1px solid transparent" },
  secondary: { background: "var(--ds-bg-2)", color: "var(--ds-fg)", border: "1px solid var(--ds-border)" },
  ghost: { background: "transparent", color: "var(--ds-fg-muted)", border: "1px solid var(--ds-border)" },
  // --ds-on-status is the readable text colour on a status fill: white in
  // the light theme, dark in the dark theme (where white text is too faint).
  danger: { background: "var(--ds-danger)", color: "var(--ds-on-status)", border: "1px solid transparent" },
  "accent-soft": {
    background: "var(--ds-accent-soft)",
    color: "var(--ds-accent-text)",
    border: "1px solid var(--ds-accent-ring)",
  },
  "danger-soft": {
    background: "color-mix(in oklab, var(--ds-danger) 14%, transparent)",
    color: "var(--ds-danger)",
    border: "1px solid color-mix(in oklab, var(--ds-danger) 40%, transparent)",
  },
  muted: { background: "var(--ds-bg-2)", color: "var(--ds-fg-muted)", border: "1px solid var(--ds-border)" },
};

// md is the detail action row; sm is for dialog footers and heading rows.
const SIZE_STYLE: Record<DetailActionSize, CSSProperties> = {
  md: { height: 34, padding: "6px 14px" },
  sm: { height: 32, padding: "5px 12px" },
};

const BASE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: "nowrap",
};

/** Inline style for one variant/size — for a <Link>/<a> that must read as an action. */
export function detailActionStyle(
  variant: DetailActionVariant,
  size: DetailActionSize = "md",
): CSSProperties {
  return { ...BASE_STYLE, ...SIZE_STYLE[size], ...VARIANT_STYLE[variant] };
}

/** Class list for an interactive action (button or link); pairs with detailActionStyle. */
export const DETAIL_ACTION_CLASS = "ds-hover-tint";

export function DetailActionButton({
  variant = "secondary",
  size = "md",
  busy = false,
  type = "button",
  className,
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: DetailActionVariant;
  size?: DetailActionSize;
  /** A request is in flight: announces aria-busy and shows the progress cursor (pair with `disabled`). */
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      className={cn(DETAIL_ACTION_CLASS, "disabled:opacity-70", className)}
      style={{ ...detailActionStyle(variant, size), ...(busy ? { cursor: "progress" } : null), ...style }}
      {...props}
    />
  );
}

/** Inert twin: a state pill with the action metrics and no hover affordance. */
export function DetailActionStatus({
  variant = "muted",
  size = "md",
  style,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: DetailActionVariant; size?: DetailActionSize }) {
  return <span style={{ ...detailActionStyle(variant, size), ...style }} {...props} />;
}
