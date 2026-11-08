// The appearance preferences' storage keys and accent list — ONE definition,
// read by ThemeProvider, the root layout's pre-paint script and the crash page.
//
// A plain module on purpose (neither "use client" nor server-only): the root
// layout is a Server Component, and importing these from theme-provider.tsx
// ("use client") would hand it client references, not the values.

export type Theme = "dark" | "light";

export const ACCENTS = ["indigo", "amber", "emerald", "cyan", "rose", "mono"] as const;
export type Accent = (typeof ACCENTS)[number];

export const THEME_STORAGE_KEY = "summonarr-theme";
export const ACCENT_STORAGE_KEY = "summonarr-accent";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/** The parts of `document` and `localStorage` the restore touches. */
export interface ThemeDocument {
  documentElement: {
    setAttribute(name: string, value: string): void;
    classList: { toggle(token: string, force?: boolean): unknown };
  };
}
export interface ThemeStorage {
  getItem(key: string): string | null;
}
interface ThemeKeys {
  theme: string;
  accent: string;
  accents: readonly string[];
}

const THEME_KEYS: ThemeKeys = { theme: THEME_STORAGE_KEY, accent: ACCENT_STORAGE_KEY, accents: ACCENTS };

// The restore itself. Self-contained on purpose — no reference outside its own
// parameters — because themeInitScript inlines its SOURCE into the pre-paint
// script, where nothing from this module exists.
function applyThemeFrom(doc: ThemeDocument, storage: ThemeStorage, keys: ThemeKeys): void {
  const d = doc.documentElement;
  const t = storage.getItem(keys.theme);
  const a = storage.getItem(keys.accent);
  if (t === "light" || t === "dark") {
    d.setAttribute("data-theme", t);
    d.classList.toggle("dark", t === "dark");
  }
  if (a && keys.accents.indexOf(a) !== -1) d.setAttribute("data-accent", a);
}

/** Applies the stored theme/accent to `doc`; values it doesn't know are ignored. Throws only if `storage` does. */
export function applyStoredTheme(doc: ThemeDocument, storage: ThemeStorage): void {
  applyThemeFrom(doc, storage, THEME_KEYS);
}

/** The root layout's anti-flash script: applies the stored theme/accent before
 *  first paint, running the same restore as applyStoredTheme. The layout
 *  evaluates it once into a module-level constant. */
export function themeInitScript(): string {
  const keys = JSON.stringify(THEME_KEYS).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `(function(){try{(${applyThemeFrom.toString()})(document,localStorage,${keys});}catch(e){}})();`;
}
