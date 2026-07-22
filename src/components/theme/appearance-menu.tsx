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

/* Standalone (non-menu) variant. The menu form below renders base-ui
   Menu.RadioGroup/RadioItem, which THROW ("MenuRootContext is missing") unless a
   <Menu.Root> is an ancestor — so it can only be used inside a DropdownMenu. The
   mobile nav drawer is a Drawer, not a Menu, so rendering the menu form there
   crashed the whole app into global-error ("Something went wrong") the moment the
   drawer opened. This variant keeps the same options and roving a11y semantics
   using a plain radiogroup that needs no menu context. */
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
              cursor: "pointer",
              background: selected ? "var(--ds-accent-soft)" : "transparent",
              color: selected ? "var(--ds-accent)" : "var(--ds-fg)",
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
