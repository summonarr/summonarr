"use client";

import { Moon, Sun } from "@/components/icons";
import { ACCENTS, useTheme, type Accent, type Theme } from "./theme-provider";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

/* Theme + accent picker for the header account dropdown. Rendered as two
   menuitemradio groups so the controls join the menu's arrow-key roving focus
   and expose aria-checked — the prior custom <button>s sat inside the role=menu
   but weren't menu items, so base-ui's keyboard model skipped them (keyboard
   users couldn't reach them). base-ui's RadioItem defaults closeOnClick=false,
   so selecting a theme/accent keeps the menu open for live preview, preserving
   the original behavior. The section header is a static, non-focusable label
   (base-ui correctly skips it in navigation). */

const ACCENT_SWATCH: Record<Accent, string> = {
  indigo: "oklch(0.58 0.21 275)",
  amber: "oklch(0.78 0.16 75)",
  emerald: "oklch(0.68 0.16 158)",
  cyan: "oklch(0.72 0.13 220)",
  rose: "oklch(0.66 0.21 15)",
  mono: "oklch(0.85 0 0)",
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

export function AppearanceMenu() {
  const { theme, setTheme, accent, setAccent } = useTheme();

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
