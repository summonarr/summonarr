"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/* Saved appearance preferences.
   - theme  sets `[data-theme]` on <html> (the ds-* colour tokens in
     globals.css) and the shadcn `.dark` class together.
   - accent sets `[data-accent]` on <html> (the --ds-accent hue).
   Both are saved per device in localStorage. A small inline script in
   src/app/layout.tsx applies them before the first paint, so the page never
   flashes the wrong colours. */

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

// Browser-chrome colour (mobile toolbar / PWA status bar) — the hex forms of
// --ds-bg. layout.tsx's static viewport.themeColor is the dark one because the
// app defaults to dark; a <meta> can't read the stored choice, so the client
// rewrites it whenever the theme is known.
const THEME_CHROME: Record<Theme, string> = { dark: "#09090b", light: "#fbfcfd" };

function applyChromeColor(theme: Theme) {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_CHROME[theme];
  }
}

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.classList.toggle("dark", theme === "dark");
  applyChromeColor(theme);
}

function applyAccent(accent: Accent) {
  document.documentElement.setAttribute("data-accent", accent);
}

// State starts at the server-rendered defaults so the first client render
// matches the server HTML (no hydration mismatch). The effect below then reads
// the saved values that layout.tsx's inline script already put on <html>.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [accent, setAccentState] = useState<Accent>(DEFAULT_ACCENT);

  // Runs once after mount to copy <html data-theme/data-accent> into state.
  // After that this provider is the only writer, so nothing needs watching.
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    const a = document.documentElement.getAttribute("data-accent");
    if (t === "light" || t === "dark") {
      setThemeState(t);
      applyChromeColor(t);
    }
    if (a && (ACCENTS as readonly string[]).includes(a)) {
      setAccentState(a as Accent);
    }
  }, []);

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

  // Memoized so consumers of the context don't re-render on every provider
  // render — the setters are stable (useCallback), so this only changes when
  // theme/accent actually change.
  const value = useMemo(
    () => ({ theme, accent, setTheme, toggleTheme, setAccent }),
    [theme, accent, setTheme, toggleTheme, setAccent],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}
