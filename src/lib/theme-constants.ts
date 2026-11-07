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

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/** The root layout's anti-flash script: applies the stored theme/accent before
 *  first paint. Built from the constants above so a new accent can't be missed
 *  there; the layout evaluates it once into a module-level constant. */
export function themeInitScript(): string {
  return `(function(){try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(t==="light"||t==="dark"){d.setAttribute("data-theme",t);d.classList.toggle("dark",t==="dark");}if(a&&${JSON.stringify(ACCENTS)}.indexOf(a)!==-1){d.setAttribute("data-accent",a);}}catch(e){}})();`;
}
