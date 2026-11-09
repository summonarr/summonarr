"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  ACCENT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isAccent,
  isTheme,
  type Accent,
  type Theme,
} from "@/lib/theme-constants";

/* Saved appearance preferences.
   - theme  sets `[data-theme]` on <html> (the ds-* colour tokens in
     globals.css) and the shadcn `.dark` class together.
   - accent sets `[data-accent]` on <html> (the --ds-accent hue).
   Both are saved per device in localStorage. A small inline script in
   src/app/layout.tsx applies them before the first paint, so the page never
   flashes the wrong colours. */

// The keys and accent list live in a plain shared module so the root
// layout's pre-paint script and the crash page read the same values; they are
// re-exported here for the existing importers.
export { ACCENT_STORAGE_KEY, ACCENTS, THEME_STORAGE_KEY, type Accent, type Theme } from "@/lib/theme-constants";

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

// <html data-theme/data-accent> IS the store: layout.tsx's inline script
// writes the saved values there before first paint, the setters below write it,
// and another tab's change arrives as a "storage" event that is applied there.
// The server snapshot is the defaults, so hydration matches the server HTML and
// React re-renders with the real values right after (no mount effect needed).
function readTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  return isTheme(t) ? t : DEFAULT_THEME;
}

function readAccent(): Accent {
  const a = document.documentElement.getAttribute("data-accent");
  return isAccent(a) ? a : DEFAULT_ACCENT;
}

// One snapshot for both values, so the provider holds a single subscription (a
// second would double the observers and apply each storage event twice).
const APPEARANCE_SEPARATOR = "|";
function readAppearance(): string {
  return `${readTheme()}${APPEARANCE_SEPARATOR}${readAccent()}`;
}
const SERVER_APPEARANCE = `${DEFAULT_THEME}${APPEARANCE_SEPARATOR}${DEFAULT_ACCENT}`;

function subscribeAppearance(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent"],
  });
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY && isTheme(e.newValue)) applyTheme(e.newValue);
    else if (e.key === ACCENT_STORAGE_KEY && isAccent(e.newValue)) applyAccent(e.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const appearance = useSyncExternalStore(subscribeAppearance, readAppearance, () => SERVER_APPEARANCE);
  const [themeText, accentText] = appearance.split(APPEARANCE_SEPARATOR);
  const theme = isTheme(themeText) ? themeText : DEFAULT_THEME;
  const accent = isAccent(accentText) ? accentText : DEFAULT_ACCENT;

  // The browser-chrome colour follows whatever theme is current, the one the
  // pre-paint script applied included.
  useEffect(() => {
    applyChromeColor(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    applyTheme(t);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* storage unavailable (private mode / disabled) — fall back to session-only */
    }
  }, []);

  const setAccent = useCallback((a: Accent) => {
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
