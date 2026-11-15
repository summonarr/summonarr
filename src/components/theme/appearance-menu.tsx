"use client";

import { Moon, Sun } from "@/components/icons";
import { ACCENTS, useTheme, type Accent, type Theme } from "./theme-provider";
import { isAccent, isTheme } from "@/lib/theme-constants";
import { radioKeyTarget } from "./radio-keys";
import { useLocale, useSetLocale, useT } from "@/components/i18n/i18n-provider";
import { LOCALES, LOCALE_LABELS, isLocale, type Locale } from "@/lib/i18n/locales";
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


const sectionHeaderStyle: React.CSSProperties = {
  padding: "6px 8px 2px",
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--ds-fg-subtle)",
};

/* The swatch shown beside an accent's name, in both forms. */
function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14,
        height: 14,
        borderRadius: 999,
        background: color,
        border: "1px solid var(--ds-border)",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

type AppearanceOption<T extends string> = {
  value: T;
  label: string;
  /** Rendered before the label: an icon or a Swatch. */
  lead?: React.ReactNode;
  lang?: string;
};

type AppearanceSection<T extends string> = {
  key: string;
  header: string;
  label: string;
  value: T;
  options: AppearanceOption<T>[];
  /** Takes any string and ignores one that isn't a known value, so the menu
   *  form's untyped onValueChange can call it directly. */
  onChange: (v: string) => void;
};

/* Standalone (non-menu) variant. The menu form below uses base-ui menu radio
   items, which THROW ("MenuRootContext is missing") outside a DropdownMenu. The
   mobile nav drawer is not a menu, so it uses this version: the same options as
   plain buttons in a radiogroup, following the ARIA radio pattern — one Tab
   stop (the checked option) and the arrow keys move and select. */
function StandaloneRadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  commitOnArrow = true,
}: {
  label: string;
  value: T;
  options: AppearanceOption<T>[];
  onChange: (v: T) => void;
  /** false: an arrow key only moves focus and Enter/Space commits. For a choice
   *  whose change is costly (the language reloads the page's data). */
  commitOnArrow?: boolean;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = radioKeyTarget(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[next]?.focus();
    if (commitOnArrow) onChange(options[next].value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 8px 8px" }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        // Roving tab stop: the checked option, or the first when none is.
        const tabbable = selectedIndex === -1 ? i === 0 : selected;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            lang={o.lang}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className="ds-tap ds-hover-tint flex items-center gap-2 font-medium transition-colors"
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
            {o.lead}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* The menu form of one section. base-ui hands onValueChange an untyped value;
   the section's onChange checks it before the setter sees it. */
function MenuRadioSection<T extends string>({ section }: { section: AppearanceSection<T> }) {
  return (
    <DropdownMenuRadioGroup
      aria-label={section.label}
      value={section.value}
      onValueChange={(v) => {
        if (typeof v === "string") section.onChange(v);
      }}
    >
      {section.options.map((o) => (
        <DropdownMenuRadioItem key={o.value} value={o.value} lang={o.lang}>
          {o.lead}
          {o.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** The three sections, built once for both forms. */
function useAppearanceSections(): [AppearanceSection<Theme>, AppearanceSection<Accent>, AppearanceSection<Locale>] {
  const { theme, setTheme, accent, setAccent } = useTheme();
  const t = useT();
  const locale = useLocale();
  const setLocale = useSetLocale();
  return [
    {
      key: "theme",
      header: t("appearance.theme"),
      label: t("appearance.theme"),
      value: theme,
      onChange: (v) => {
        if (isTheme(v)) setTheme(v);
      },
      options: [
        { value: "dark", label: t("appearance.dark"), lead: <Moon className="size-4" /> },
        { value: "light", label: t("appearance.light"), lead: <Sun className="size-4" /> },
      ],
    },
    {
      key: "accent",
      header: t("appearance.accent"),
      label: t("appearance.accentColor"),
      value: accent,
      onChange: (v) => {
        if (isAccent(v)) setAccent(v);
      },
      options: ACCENTS.map((a) => ({
        value: a,
        label: t(`appearance.accent.${a}`),
        lead: <Swatch color={ACCENT_SWATCH[a]} />,
      })),
    },
    {
      key: "language",
      header: t("appearance.language"),
      label: t("appearance.language"),
      value: locale,
      onChange: (v) => {
        if (isLocale(v)) setLocale(v);
      },
      options: LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l], lang: l })),
    },
  ];
}

/**
 * `standalone` renders the non-menu form for contexts that are NOT a base-ui
 * Menu (e.g. the mobile nav drawer). Default (false) keeps the menuitemradio
 * form required by the header account dropdown's keyboard model.
 */
export function AppearanceMenu({ standalone = false }: { standalone?: boolean } = {}) {
  const [theme, accent, language] = useAppearanceSections();
  const header = (section: { header: string }) => (
    <div style={sectionHeaderStyle} aria-hidden="true">
      {section.header}
    </div>
  );

  if (standalone) {
    return (
      <>
        {header(theme)}
        <StandaloneRadioGroup<Theme> label={theme.label} value={theme.value} onChange={theme.onChange} options={theme.options} />
        {header(accent)}
        <StandaloneRadioGroup<Accent> label={accent.label} value={accent.value} onChange={accent.onChange} options={accent.options} />
        {header(language)}
        <StandaloneRadioGroup<Locale> label={language.label} value={language.value} onChange={language.onChange} options={language.options} commitOnArrow={false} />
      </>
    );
  }

  return (
    <>
      {header(theme)}
      <MenuRadioSection section={theme} />
      {header(accent)}
      <MenuRadioSection section={accent} />
      {header(language)}
      <MenuRadioSection section={language} />
    </>
  );
}
