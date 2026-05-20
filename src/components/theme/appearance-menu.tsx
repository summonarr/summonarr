"use client";

import { Moon, Sun, Check } from "@/components/icons";
import { ACCENTS, useTheme, type Accent } from "./theme-provider";

/* Theme + accent picker. Designed to drop into the header user dropdown
   (renders its own labelled section; does not close the menu on change so
   the user can preview hues live). */

const ACCENT_SWATCH: Record<Accent, string> = {
  indigo: "oklch(0.58 0.21 275)",
  amber: "oklch(0.78 0.16 75)",
  emerald: "oklch(0.68 0.16 158)",
  cyan: "oklch(0.72 0.13 220)",
  rose: "oklch(0.66 0.21 15)",
  mono: "oklch(0.85 0 0)",
};

export function AppearanceMenu() {
  const { theme, setTheme, accent, setAccent } = useTheme();

  return (
    <div
      className="ds-mono"
      style={{ padding: "8px 8px 10px", display: "grid", gap: 8 }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ds-fg-subtle)",
        }}
      >
        Appearance
      </div>

      {/* Theme segmented toggle */}
      <div
        role="group"
        aria-label="Theme"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          padding: 3,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: "var(--ds-r-md)",
        }}
      >
        {(
          [
            ["dark", "Dark", Moon],
            ["light", "Light", Sun],
          ] as const
        ).map(([value, label, Icon]) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => setTheme(value)}
              className="ds-tap"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 28,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: 0,
                borderRadius: "var(--ds-r-sm)",
                background: active ? "var(--ds-accent)" : "transparent",
                color: active ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
                fontFamily: "inherit",
              }}
            >
              <Icon size={13} strokeWidth={2} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Accent swatches */}
      <div
        role="group"
        aria-label="Accent color"
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {ACCENTS.map((a) => {
          const active = accent === a;
          return (
            <button
              key={a}
              type="button"
              aria-label={a}
              aria-pressed={active}
              title={a}
              onClick={() => setAccent(a)}
              className="ds-tap"
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                cursor: "pointer",
                background: ACCENT_SWATCH[a],
                border: active
                  ? "2px solid var(--ds-fg)"
                  : "2px solid var(--ds-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              {active && (
                <Check
                  size={13}
                  strokeWidth={3}
                  color={
                    a === "amber" || a === "cyan" || a === "mono"
                      ? "#000"
                      : "#fff"
                  }
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
