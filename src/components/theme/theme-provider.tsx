"use client";

import { createContext, useCallback, useContext, useState } from "react";

/* Persisted appearance preferences.
   - theme  drives globals.css `[data-theme]` (ds-* tokens + legacy remap)
     and the shadcn `.dark` class together.
   - accent drives globals.css `[data-accent]` (the --ds-accent hue).
   Persistence is per-device via localStorage (the next-themes convention);
   an inline blocking script in src/app/layout.tsx applies the same values
   before first paint so there is no flash. */

export type Theme = "dark" | "light";
export type Accent = "indigo" | "amber" | "emerald" | "cyan" | "rose" | "mono";

export const ACCENTS: readonly Accent[] = [
  "indigo",
  "amber",
  "emerald",
  "cyan",
  "rose",
  "mono",
];

export const THEME_STORAGE_KEY = "summonarr-theme";
export const ACCENT_STORAGE_KEY = "summonarr-accent";

const DEFAULT_THEME: Theme = "dark";
const DEFAULT_ACCENT: Accent = "indigo";

type ThemeContextValue = {
  theme: Theme;
  accent: Accent;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setAccent: (a: Accent) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.classList.toggle("dark", theme === "dark");
}

function applyAccent(accent: Accent) {
  document.documentElement.setAttribute("data-accent", accent);
}

// Read the values the inline script (src/app/layout.tsx) already applied to
// <html> before paint, so the first client render matches the visible UI with
// no toggle flicker. SSR has no document → falls back to the SSR defaults,
// which match the hardcoded <html data-theme="dark" data-accent="indigo">.
function initialTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : DEFAULT_THEME;
}

function initialAccent(): Accent {
  if (typeof document === "undefined") return DEFAULT_ACCENT;
  const a = document.documentElement.getAttribute("data-accent");
  return a && (ACCENTS as readonly string[]).includes(a)
    ? (a as Accent)
    : DEFAULT_ACCENT;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [accent, setAccentState] = useState<Accent>(initialAccent);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* storage unavailable (private mode / disabled) — fall back to session-only */
    }
  }, []);

  const setAccent = useCallback((a: Accent) => {
    setAccentState(a);
    applyAccent(a);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, a);
    } catch {
      /* storage unavailable — session-only */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider
      value={{ theme, accent, setTheme, toggleTheme, setAccent }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}
