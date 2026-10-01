// Unit tests for the UI translation layer (src/lib/i18n).
//
// - Catalog parity: every locale carries exactly English's keys, with the same
//   placeholders. A missing key silently degrades to English at runtime, and a
//   dropped/renamed placeholder renders a literal "{name}" — neither is caught
//   by the type checker, so they are pinned here.
// - Usage coverage: every literal key passed to t("…") in src/ exists in the
//   English catalog, so a typo can't ship as a raw dotted id on screen.
// - Locale negotiation (cookie > Accept-Language > default) and the
//   translator's plural / fallback / interpolation rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  negotiateLocale,
  resolveLocale,
} from "../src/lib/i18n/locales.ts";
import { createTranslator, interpolate, placeholdersOf } from "../src/lib/i18n/translate.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MESSAGES = join(ROOT, "src/lib/i18n/messages");

const areasOf = (locale: string): string[] =>
  readdirSync(join(MESSAGES, locale)).filter((f) => f.endsWith(".json")).sort();

// Merges a locale's per-area files, failing on a key defined in two areas
// (the later spread would silently win at runtime).
function readCatalog(locale: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of areasOf(locale)) {
    const area: Record<string, string> = JSON.parse(readFileSync(join(MESSAGES, locale, file), "utf8"));
    for (const [k, v] of Object.entries(area)) {
      assert.ok(!(k in merged), `${locale}: key ${k} defined in more than one area (${file})`);
      merged[k] = v;
    }
  }
  return merged;
}

const en = readCatalog("en");

test("every locale has the same area files as English, all wired into catalogs.ts", () => {
  const catalogs = readFileSync(join(ROOT, "src/lib/i18n/catalogs.ts"), "utf8");
  for (const locale of LOCALES) {
    assert.deepEqual(areasOf(locale), areasOf("en"), `${locale} area files`);
    for (const file of areasOf(locale)) {
      assert.ok(
        catalogs.includes(`"./messages/${locale}/${file}"`),
        `catalogs.ts does not import messages/${locale}/${file}`,
      );
    }
  }
});

test("every locale has exactly the English keys", () => {
  for (const locale of LOCALES) {
    const cat = readCatalog(locale);
    assert.deepEqual(Object.keys(cat).sort(), Object.keys(en).sort(), `${locale}.json key set`);
  }
});

test("every translation keeps the English placeholders", () => {
  for (const locale of LOCALES) {
    const cat = readCatalog(locale);
    for (const [key, value] of Object.entries(en)) {
      assert.deepEqual(placeholdersOf(cat[key]), placeholdersOf(value), `${locale}: ${key}`);
    }
  }
});

test("no catalog value is blank", () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(readCatalog(locale))) {
      assert.ok(typeof value === "string" && value.trim() !== "", `${locale}: ${key}`);
    }
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("every literal t() key used in src/ exists in en.json", () => {
  // Matches t("a.b") and t('a.b', …) — dynamic keys (template literals) are
  // out of reach of a scan and must be covered by their own catalog entries.
  // Also matches `i18nKey: "a.b"` — data-driven labels (nav items) that are
  // translated at render time from a key stored beside them.
  const call = /(?:\bt\(\s*|\bi18nKey:\s*)["']([a-zA-Z0-9_.-]+)["']/g;
  const missing: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    if (!/\buse(T|Translator)\b|getTranslator|i18nKey/.test(src)) continue;
    for (const m of src.matchAll(call)) {
      const key = m[1];
      const plural = Object.keys(en).some((k) => k.startsWith(`${key}_`));
      if (!(key in en) && !plural) missing.push(`${file.slice(ROOT.length)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("negotiateLocale: primary subtag, q-values, q=0, fallback", () => {
  assert.equal(negotiateLocale(null), DEFAULT_LOCALE);
  assert.equal(negotiateLocale(""), DEFAULT_LOCALE);
  assert.equal(negotiateLocale("es-MX,es;q=0.9,en;q=0.8"), "es");
  assert.equal(negotiateLocale("fr-FR,fr;q=0.9,es;q=0.5,en;q=0.4"), "es");
  assert.equal(negotiateLocale("en;q=0.2,es;q=0.8"), "es");
  assert.equal(negotiateLocale("es;q=0,en"), "en");
  assert.equal(negotiateLocale("de,fr"), DEFAULT_LOCALE);
  // Equal q keeps header order.
  assert.equal(negotiateLocale("es,en"), "es");
  assert.equal(negotiateLocale("en,es"), "en");
});

test("resolveLocale: a valid cookie wins, an invalid one is ignored", () => {
  assert.equal(resolveLocale("es", "en"), "es");
  assert.equal(resolveLocale("xx", "es"), "es");
  assert.equal(resolveLocale(undefined, undefined), DEFAULT_LOCALE);
  assert.equal(isLocale("es"), true);
  assert.equal(isLocale("ES"), false);
});

test("translator: lookup, English fallback, key fallback", () => {
  const t = createTranslator("es", { "a.hello": "Hola" }, { "a.hello": "Hello", "a.only": "Only en" });
  assert.equal(t("a.hello"), "Hola");
  assert.equal(t("a.only"), "Only en");
  assert.equal(t("a.none"), "a.none");
});

test("translator: interpolation leaves unknown placeholders intact", () => {
  assert.equal(interpolate("Hi {name}, {x}", { name: "Ana" }), "Hi Ana, {x}");
  const t = createTranslator("en", { greet: "Hi {name}" }, {});
  assert.equal(t("greet", { name: "Ana" }), "Hi Ana");
});

test("translator: plurals by locale category with _other fallback", () => {
  const msgs = { "n.items_one": "{count} item", "n.items_other": "{count} items" };
  const t = createTranslator("en", msgs, {});
  assert.equal(t("n.items", { count: 1 }), "1 item");
  assert.equal(t("n.items", { count: 0 }), "0 items");
  assert.equal(t("n.items", { count: 5 }), "5 items");
  // Spanish has a "many" category for large round numbers in recent CLDR;
  // with no _many entry it must land on _other, not the raw key.
  const tes = createTranslator("es", { "n.items_one": "{count} elemento", "n.items_other": "{count} elementos" }, {});
  assert.equal(tes("n.items", { count: 1000000 }), "1000000 elementos");
  assert.equal(tes("n.items", { count: 1 }), "1 elemento");
});
