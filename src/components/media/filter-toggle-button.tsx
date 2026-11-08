"use client";

import type { ButtonHTMLAttributes, CSSProperties } from "react";

// The pill toggle beside the browse filters ("Hide available"): the /movies and
// /tv FilterBar and the home / upcoming HideAvailableToggle draw the same one.
// 32px tall like the compact selects beside it, accent-soft while pressed.
export function FilterToggleButton({
  pressed,
  style,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed" | "type"> & { pressed: boolean }) {
  const look: CSSProperties = {
    padding: "5px 12px",
    minHeight: 32,
    borderRadius: 8,
    fontSize: 12,
    background: pressed ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
    color: pressed ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
    border: `1px solid ${pressed ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
  };
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`ds-tap ds-hover-tint inline-flex items-center gap-1.5 font-medium${className ? ` ${className}` : ""}`}
      style={{ ...look, ...style }}
      {...rest}
    />
  );
}
