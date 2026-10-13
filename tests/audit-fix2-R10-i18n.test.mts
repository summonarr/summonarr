// Wording pins for the second post-v0.34.0 review's i18n findings. The parity
// tests in tests/i18n.test.mts check keys and placeholders only, so a string
// can claim the wrong thing in one language and still pass them. Each pin
// below checks the one property its fix restored, in every language.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LOCALES } from "../src/lib/i18n/locales.ts";

const MESSAGES = join(new URL("..", import.meta.url).pathname, "src/lib/i18n/messages");

function readCatalog(locale: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of readdirSync(join(MESSAGES, locale)).filter((f) => f.endsWith(".json"))) {
    Object.assign(merged, JSON.parse(readFileSync(join(MESSAGES, locale, file), "utf8")));
  }
  return merged;
}

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, readCatalog(l)])) as Record<string, Record<string, string>>;

function text(locale: string, key: string): string {
  const value = catalogs[locale]?.[key];
  assert.ok(value, `${locale}: ${key} missing`);
  return value;
}

/** Runs one per-locale check for every locale the table names, and requires the table to name all of them. */
function eachLocale(table: Record<string, (value: string, locale: string) => void>, key: string): void {
  assert.deepEqual(Object.keys(table).sort(), [...LOCALES].sort(), "the pin covers every locale");
  for (const locale of LOCALES) table[locale](text(locale, key), locale);
}

test("cleanup result: a failed target is 'not confirmed', never 'not deleted' (a timed-out delete may have gone through)", () => {
  const key = "adminManage.cleanup.result.failedReasons";
  const claims: Record<string, [RegExp, RegExp]> = {
    en: [/not deleted/i, /not confirmed/i],
    de: [/nicht gelöscht/i, /nicht bestätigt/i],
    es: [/no eliminado/i, /no confirmada/i],
    fr: [/non supprimé/i, /non confirmée/i],
    it: [/non eliminato/i, /non confermata/i],
    pt: [/não excluído/i, /não confirmada/i],
    zh: [/未删除/, /未确认/],
  };
  eachLocale(
    Object.fromEntries(Object.entries(claims).map(([locale, [wrong, right]]) => [locale, (value: string) => {
      assert.doesNotMatch(value, wrong, `${locale}: asserts the delete did not happen`);
      assert.match(value, right, `${locale}: does not say the delete is unconfirmed`);
      assert.match(value, /\{list\}/, `${locale}: lost its placeholder`);
    }])),
    key,
  );
});

test("Missing bulk bar: one title on another page is singular", () => {
  const one: Record<string, RegExp> = {
    en: /another page\)/,
    de: /einer anderen Seite/,
    es: /otra página\)/,
    fr: /une autre page/,
    it: /un'altra pagina\)/,
    pt: /outra página\)/,
    zh: /其他页面/, // no grammatical number
  };
  eachLocale(
    Object.fromEntries(Object.entries(one).map(([locale, re]) => [locale, (value: string) => {
      assert.match(value, re, `${locale}: the _one form is not singular`);
    }])),
    "adminArr.missingBulk.selectedOffPage_one",
  );
  for (const locale of ["en", "es", "it", "pt"]) {
    assert.doesNotMatch(text(locale, "adminArr.missingBulk.selectedOffPage_one"), /pages|páginas|pagine/, `${locale}: _one still plural`);
    assert.match(text(locale, "adminArr.missingBulk.selectedOffPage_other"), /pages|páginas|pagine/, `${locale}: _other lost its plural`);
  }
});

test("indexer use-switch hint: what would never be used is the SWITCH, not the indexer", () => {
  const subject: Record<string, [RegExp, RegExp | null]> = {
    en: [/this switch would never be used/, /so it would never/],
    de: [/diese Option/, null],
    es: [/esta opción nunca se usaría/, null],
    fr: [/cette option/, null],
    it: [/questa opzione non verrebbe mai usata/, /mai usato\b/],
    pt: [/essa opção nunca seria usada/, /\bele nunca\b/],
    zh: [/该选项永远不会被使用/, /它永远/],
  };
  eachLocale(
    Object.fromEntries(Object.entries(subject).map(([locale, [right, wrong]]) => [locale, (value: string) => {
      assert.match(value, right, `${locale}: does not name the switch`);
      if (wrong) assert.doesNotMatch(value, wrong, `${locale}: still says the indexer would never be used`);
    }])),
    "adminArr.system.useUnsupportedHint",
  );
});

test("provider switch refusal: names the use that wasn't switched on, never the whole indexer", () => {
  const rss = "apiAdmin.arr.providerRssUnsupported";
  const search = "apiAdmin.arr.providerSearchUnsupported";
  for (const locale of LOCALES) {
    // The refusal clause repeats RSS, so the subject can't be read as the indexer.
    assert.equal(text(locale, rss).match(/RSS/g)?.length, 2, `${locale}: the RSS refusal does not name RSS as what stayed off`);
    assert.doesNotMatch(text(locale, rss) + text(locale, search), /wurde er nicht|il n'a donc|ele não foi|so it wasn't|so it wasn’t|未将其开启/, `${locale}: says the indexer was not switched on`);
  }
  const searchOff: Record<string, RegExp> = {
    en: /so searching wasn't switched on/,
    de: /daher wurde die Suche nicht eingeschaltet/,
    es: /así que la búsqueda no se activó/,
    fr: /la recherche n'a donc pas été activée/,
    it: /quindi la ricerca non è stata attivata/,
    pt: /por isso a busca não foi ativada/,
    zh: /因此未开启搜索/,
  };
  eachLocale(
    Object.fromEntries(Object.entries(searchOff).map(([locale, re]) => [locale, (value: string) => {
      assert.match(value, re, `${locale}: the search refusal does not name searching as what stayed off`);
    }])),
    search,
  );
});

test("Mark failed with an unknown grab state: the refusal is Summonarr's, and 'since' has an object", () => {
  for (const locale of LOCALES) {
    const value = text(locale, "adminArr.history.stateUnknown");
    // markHistoryFailed answers AlreadyFailedError before anything reaches the arr.
    assert.match(value, /Summonarr/, `${locale}: does not say Summonarr refuses`);
    assert.doesNotMatch(value, /Radarr\/Sonarr|\barr\b/, `${locale}: credits the arr with the refusal`);
  }
  assert.match(text("en", "adminArr.history.stateUnknown"), /since it was grabbed —/);
  assert.doesNotMatch(text("en", "adminArr.history.stateUnknown"), /since —/);
});

test("Why? status: 'monitors the series but none of its episodes' never says 'aired' (it fires before a premiere too)", () => {
  const aired: Record<string, RegExp> = {
    en: /aired/i,
    de: /ausgestrahlt/i,
    es: /emitid/i,
    fr: /diffusé/i,
    it: /trasmess/i,
    pt: /exibid/i,
    zh: /已播出/,
  };
  eachLocale(
    Object.fromEntries(Object.entries(aired).map(([locale, re]) => [locale, (value: string) => {
      assert.doesNotMatch(value, re, `${locale}: still limits it to aired episodes`);
      assert.equal(value.match(/\{service\}/g)?.length, 2, `${locale}: placeholders changed`);
    }])),
    "adminQueue.arrStatus.why.unmonitoredEpisodes",
  );
});
