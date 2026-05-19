"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

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

// Initial state mirrors the SSR defaults exactly so the first client paint
// matches SSR (no hydration mismatch). A useEffect below then reads the
// per-device persisted values from <html> (already applied by the inline
// blocking script in src/app/layout.tsx) and reconciles state. Visual color
// never flashes because the inline script set the CSS variables before paint.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [accent, setAccentState] = useState<Accent>(DEFAULT_ACCENT);

  // One-time post-mount reconciliation with values the inline blocking script
  // already applied to <html data-theme/data-accent>. The set-state-in-effect
  // rule is intentionally suppressed: this is exactly the "sync React state
  // with an external system (DOM attribute set before hydration)" pattern that
  // effects exist for. No subscription is needed — the attribute is owned by
  // this provider after mount.
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    const a = document.documentElement.getAttribute("data-accent");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === "light" || t === "dark") setThemeState(t);
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
