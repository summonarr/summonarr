"use client";

import { Moon, Sun } from "@/components/icons";
import { ACCENTS, useTheme, type Accent, type Theme } from "./theme-provider";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

/* Theme + accent picker for the header account dropdown. The options are menu
   radio items so the menu's arrow keys reach them and screen readers hear which
   one is checked. base-ui radio items don't close the menu on click, so the
   admin can preview each choice live. The section headers are plain labels
   that keyboard navigation skips. */

const ACCENT_SWATCH: Record<Accent, string> = {
  indigo: "oklch(0.58 0.21 275)",
  amber: "oklch(0.78 0.16 75)",
  emerald: "oklch(0.68 0.16 158)",
  cyan: "oklch(0.72 0.13 220)",
  rose: "oklch(0.66 0.21 15)",
  // Mono FLIPS with the theme ([data-accent="mono"] in globals.css: near-white
  // in dark, near-black in light), so the swatch is split between the two
  // values. A single value previews the opposite of the pick in one theme and
  // reads as an empty circle on that theme's menu surface.
  mono: "linear-gradient(135deg, oklch(0.97 0 0) 50%, oklch(0.18 0 0) 50%)",
};

const ACCENT_LABEL: Record<Accent, string> = {
  indigo: "Indigo",
  amber: "Amber",
  emerald: "Emerald",
  cyan: "Cyan",
  rose: "Rose",
  mono: "Mono",
};

const sectionHeaderStyle: React.CSSProperties = {
  padding: "6px 8px 2px",
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--ds-fg-subtle)",
};

/* Standalone (non-menu) variant. The menu form below uses base-ui menu radio
   items, which THROW ("MenuRootContext is missing") outside a DropdownMenu. The
   mobile nav drawer is not a menu, so it uses this version: the same options as
   plain buttons in a radiogroup (each one is tabbed to; there is no arrow-key
   navigation). */
function StandaloneRadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; swatch?: string; icon?: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 8px 8px" }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className="ds-tap flex items-center gap-2 font-medium transition-colors"
            style={{
              padding: "7px 10px",
              borderRadius: 6,
              fontSize: 13,
              minHeight: 36,
              background: selected ? "var(--ds-accent-soft)" : "transparent",
              color: selected ? "var(--ds-accent-text)" : "var(--ds-fg)",
              border: `1px solid ${selected ? "var(--ds-accent)" : "var(--ds-border)"}`,
            }}
          >
            {o.swatch ? (
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: o.swatch,
                  border: "1px solid var(--ds-border)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
            ) : (
              o.icon
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * `standalone` renders the non-menu form for contexts that are NOT a base-ui
 * Menu (e.g. the mobile nav drawer). Default (false) keeps the menuitemradio
 * form required by the header account dropdown's keyboard model.
 */
export function AppearanceMenu({ standalone = false }: { standalone?: boolean } = {}) {
  const { theme, setTheme, accent, setAccent } = useTheme();

  if (standalone) {
    return (
      <>
        <div style={sectionHeaderStyle} aria-hidden="true">
          Theme
        </div>
        <StandaloneRadioGroup<Theme>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "dark", label: "Dark", icon: <Moon className="size-4" /> },
            { value: "light", label: "Light", icon: <Sun className="size-4" /> },
          ]}
        />
        <div style={sectionHeaderStyle} aria-hidden="true">
          Accent
        </div>
        <StandaloneRadioGroup<Accent>
          label="Accent color"
          value={accent}
          onChange={setAccent}
          options={ACCENTS.map((a) => ({
            value: a,
            label: ACCENT_LABEL[a],
            swatch: ACCENT_SWATCH[a],
          }))}
        />
      </>
    );
  }

  return (
    <>
      <div style={sectionHeaderStyle} aria-hidden="true">
        Theme
      </div>
      <DropdownMenuRadioGroup
        aria-label="Theme"
        value={theme}
        onValueChange={(v) => setTheme(v as Theme)}
      >
        <DropdownMenuRadioItem value="dark">
          <Moon className="size-4" /> Dark
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="light">
          <Sun className="size-4" /> Light
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>

      <div style={sectionHeaderStyle} aria-hidden="true">
        Accent
      </div>
      <DropdownMenuRadioGroup
        aria-label="Accent color"
        value={accent}
        onValueChange={(v) => setAccent(v as Accent)}
      >
        {ACCENTS.map((a) => (
          <DropdownMenuRadioItem key={a} value={a}>
            <span
              aria-hidden="true"
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                background: ACCENT_SWATCH[a],
                border: "1px solid var(--ds-border)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            {ACCENT_LABEL[a]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
