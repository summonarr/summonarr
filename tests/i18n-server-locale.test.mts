// Server-side language resolution (src/lib/i18n/server-locale.ts): which
// language an API response or a notification is written in.
//
// Pinned because each rule exists for a reason a later edit could undo:
//   - an explicit cookie choice beats the browser's Accept-Language;
//   - a native client (X-Summonarr-Client) ignores Accept-Language — the iOS
//     apps' UI is English, so a Spanish phone would otherwise get Spanish
//     errors inside English screens;
//   - a request with no hints (every existing route test) gets English, so
//     translating responses cannot change any existing wire assertion;
//   - a recipient's stored locale decides notifications; garbage falls back.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  instanceDefaultLocale,
  instanceDefaultLocaleWarning,
  localeForRequest,
  localeForUser,
  parseInstanceDefaultLocale,
  translatorFor,
  translatorForRequest,
} = await import("../src/lib/i18n/server-locale.ts");
const { localeCookieFrom } = await import("../src/lib/i18n/locales.ts");

const ORIGINAL_DEFAULT = process.env.SUMMONARR_DEFAULT_LOCALE;
afterEach(() => {
  if (ORIGINAL_DEFAULT === undefined) delete process.env.SUMMONARR_DEFAULT_LOCALE;
  else process.env.SUMMONARR_DEFAULT_LOCALE = ORIGINAL_DEFAULT;
});

const req = (headers: Record<string, string>) => new Request("http://localhost/api/x", { headers });

test("a request with no language hints is answered in English", () => {
  delete process.env.SUMMONARR_DEFAULT_LOCALE;
  assert.equal(localeForRequest(req({})), "en");
  assert.equal(translatorForRequest(req({}))("nav.signOut"), "Sign out");
});

test("the picker cookie beats Accept-Language", () => {
  assert.equal(localeForRequest(req({ cookie: "a=1; summonarr-locale=es; b=2", "accept-language": "en" })), "es");
  assert.equal(localeForRequest(req({ cookie: "summonarr-locale=en", "accept-language": "es" })), "en");
});

test("an unknown cookie value is ignored, not trusted", () => {
  assert.equal(localeForRequest(req({ cookie: "summonarr-locale=xx", "accept-language": "es-MX" })), "es");
});

test("browsers follow Accept-Language; native clients do not", () => {
  assert.equal(localeForRequest(req({ "accept-language": "es-ES,es;q=0.9" })), "es");
  assert.equal(localeForRequest(req({ "accept-language": "es-ES", "x-summonarr-client": "ios; build=40" })), "en");
});

test("SUMMONARR_DEFAULT_LOCALE sets the fallback; an invalid value is ignored", () => {
  process.env.SUMMONARR_DEFAULT_LOCALE = "es";
  assert.equal(instanceDefaultLocale(), "es");
  assert.equal(localeForRequest(req({})), "es");
  assert.equal(localeForRequest(req({ "accept-language": "ru" })), "es");
  assert.equal(localeForRequest(req({ "accept-language": "de" })), "de");
  assert.equal(localeForRequest(req({ "x-summonarr-client": "ios" })), "es");
  process.env.SUMMONARR_DEFAULT_LOCALE = "klingon";
  assert.equal(instanceDefaultLocale(), "en");
});

test("a region- or script-tagged SUMMONARR_DEFAULT_LOCALE resolves on its primary subtag", () => {
  // The README calls the languages "pt (Brazilian)" and "zh (Simplified)",
  // which invites exactly these spellings; an exact match silently made every
  // one of them English. Same rule as negotiateLocale's Accept-Language match.
  process.env.SUMMONARR_DEFAULT_LOCALE = "pt-BR";
  assert.equal(instanceDefaultLocale(), "pt");
  assert.equal(localeForUser({ locale: null }), "pt", "notifications to users with no stored language follow it");
  assert.equal(localeForRequest(req({ "x-summonarr-client": "ios" })), "pt", "so do native clients");
  process.env.SUMMONARR_DEFAULT_LOCALE = "zh-Hans-CN";
  assert.equal(instanceDefaultLocale(), "zh");
  process.env.SUMMONARR_DEFAULT_LOCALE = " ES_es ";
  assert.equal(instanceDefaultLocale(), "es");
  process.env.SUMMONARR_DEFAULT_LOCALE = "pt_BR.UTF-8"; // the POSIX LANG spelling
  assert.equal(instanceDefaultLocale(), "pt");
  process.env.SUMMONARR_DEFAULT_LOCALE = "klingon";
  assert.equal(instanceDefaultLocale(), "en");
  assert.equal(parseInstanceDefaultLocale("fr-CA"), "fr");
  assert.equal(parseInstanceDefaultLocale("ru-RU"), null, "an unsupported language is still null, region or not");
  assert.equal(parseInstanceDefaultLocale("-BR"), null);
  assert.equal(parseInstanceDefaultLocale(undefined), null);
});

test("the boot warning fires only for a SET value that names no supported language", () => {
  delete process.env.SUMMONARR_DEFAULT_LOCALE;
  assert.equal(instanceDefaultLocaleWarning(), null);
  process.env.SUMMONARR_DEFAULT_LOCALE = "";
  assert.equal(instanceDefaultLocaleWarning(), null, "the shipped .env.example leaves it blank");
  process.env.SUMMONARR_DEFAULT_LOCALE = "pt-BR";
  assert.equal(instanceDefaultLocaleWarning(), null, "a region tag is accepted, not warned about");
  process.env.SUMMONARR_DEFAULT_LOCALE = "klingon";
  const warning = instanceDefaultLocaleWarning();
  assert.ok(warning?.startsWith('[i18n] SUMMONARR_DEFAULT_LOCALE="klingon" is not a supported locale'), String(warning));
  assert.ok(warning?.endsWith('using "en"'), String(warning));
  // instrumentation.ts is where it is logged, once at boot (guardrail 7: no
  // success line — the helper returns null for a valid value).
  const boot = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  assert.match(boot, /instanceDefaultLocaleWarning\(\)/, "instrumentation.ts no longer checks SUMMONARR_DEFAULT_LOCALE at boot");
});

test("notifications use the recipient's stored locale, else the instance default", () => {
  delete process.env.SUMMONARR_DEFAULT_LOCALE;
  assert.equal(localeForUser({ locale: "es" }), "es");
  assert.equal(localeForUser({ locale: null }), "en");
  assert.equal(localeForUser({ locale: "ru" }), "en");
  assert.equal(localeForUser(null), "en");
  process.env.SUMMONARR_DEFAULT_LOCALE = "es";
  assert.equal(localeForUser({}), "es");
});

test("translators are real catalogs, cached per locale", () => {
  assert.equal(translatorFor("es")("nav.signOut"), "Cerrar sesión");
  assert.equal(translatorFor("es"), translatorFor("es"));
});

test("localeCookieFrom reads exactly the locale cookie", () => {
  assert.equal(localeCookieFrom("summonarr-locale=es"), "es");
  assert.equal(localeCookieFrom("x-summonarr-locale=es; other=1"), undefined);
  assert.equal(localeCookieFrom(null), undefined);
});
