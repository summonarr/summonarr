// Message lookup + interpolation. Pure and zero-import (beyond types) so the
// server helper, the client provider and tests share one implementation.
//
// Catalogs are FLAT objects keyed by dotted ids ("nav.home"). Placeholders are
// `{name}`. Plurals: when `vars.count` is a number, `<key>_<category>` is tried
// first (category from Intl.PluralRules for the locale — "one", "other",
// "many", …), then `<key>_other`, then `<key>`. A key missing from the active
// catalog falls back to English, then to the key itself, so an untranslated
// string degrades to English rather than to a blank.

import type { Locale } from "./locales";

export type Messages = Readonly<Record<string, string>>;
export type TranslateVars = Readonly<Record<string, string | number>>;
export type Translator = (key: string, vars?: TranslateVars) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

function lookup(
  key: string,
  vars: TranslateVars | undefined,
  pluralRules: Intl.PluralRules,
  catalog: Messages,
): string | undefined {
  const count = vars?.count;
  if (typeof count === "number") {
    const own = catalog[`${key}_${pluralRules.select(count)}`];
    if (own !== undefined) return own;
    const other = catalog[`${key}_other`];
    if (other !== undefined) return other;
  }
  return catalog[key];
}

export function createTranslator(
  locale: Locale,
  messages: Messages,
  fallback: Messages,
): Translator {
  const rules = new Intl.PluralRules(locale);
  const fallbackRules = new Intl.PluralRules("en");
  return (key, vars) => {
    const template =
      lookup(key, vars, rules, messages) ?? lookup(key, vars, fallbackRules, fallback) ?? key;
    return interpolate(template, vars);
  };
}
