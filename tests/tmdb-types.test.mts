// Unit tests for the TMDB image-URL builders and the ISO-code display-name
// helpers (src/lib/tmdb-types.ts). The URL builders gate on a leading "/" so
// garbage paths from older cache rows (empty strings, bare filenames, absolute
// URLs) can never be interpolated into an image.tmdb.org URL — a bad path must
// yield null (no <img src>) rather than a broken or attacker-shaped URL.
// languageName/regionName must return NULL, never throw, for unknown/malformed
// ISO codes coming out of TMDB responses — Intl echoes an unknown code back as
// its own "name", and passing that through defeated every `??` fallback behind
// them (the detail pages showed "XC" where TMDB had "Czechoslovakia").
//
// localizedProductionCountry pins the detail pages' country row: TMDB's own
// English name is authoritative and the English page renders it unchanged
// (guardrail 40a); another language is translated through Intl ONLY where Intl
// and TMDB agree on which country the code denotes. ICU aliases TMDB's legacy
// codes at successor states ("SU" → Russia, "YU" → Serbia) and knows no "XC" at
// all, so a Soviet film read "Russia"/"Rusia" and a Czechoslovak one "XC" on
// every page, the English one included. Node's ICU (these run server-side) —
// the Spanish/French wordings asserted here are stable across ICU releases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { posterUrl, backdropUrl, stillUrl, languageName, regionName, localizedProductionCountry } from "../src/lib/tmdb-types.ts";

test("posterUrl builds the default w342 URL from a valid path", () => {
  assert.equal(posterUrl("/abc123.jpg"), "https://image.tmdb.org/t/p/w342/abc123.jpg");
});

test("posterUrl honors explicit sizes", () => {
  assert.equal(posterUrl("/p.jpg", "w342"), "https://image.tmdb.org/t/p/w342/p.jpg");
  assert.equal(posterUrl("/p.jpg", "w500"), "https://image.tmdb.org/t/p/w500/p.jpg");
  assert.equal(posterUrl("/p.jpg", "original"), "https://image.tmdb.org/t/p/original/p.jpg");
});

test("posterUrl returns null for null, empty, and non-slash-prefixed paths", () => {
  assert.equal(posterUrl(null), null);
  assert.equal(posterUrl(""), null); // older cache rows persisted "" instead of null
  assert.equal(posterUrl("abc123.jpg"), null); // bare filename
  assert.equal(posterUrl("https://evil.example/x.jpg"), null); // absolute URL can't be smuggled in
  assert.equal(posterUrl(" /padded.jpg"), null); // leading whitespace is not a valid TMDB path
});

test("backdropUrl builds w780 by default and supports original; invalid paths → null", () => {
  assert.equal(backdropUrl("/bd.jpg"), "https://image.tmdb.org/t/p/w780/bd.jpg");
  assert.equal(backdropUrl("/bd.jpg", "original"), "https://image.tmdb.org/t/p/original/bd.jpg");
  assert.equal(backdropUrl(null), null);
  assert.equal(backdropUrl(""), null);
  assert.equal(backdropUrl("bd.jpg"), null);
});

test("stillUrl builds w300 by default and supports w185/original; invalid paths → null", () => {
  assert.equal(stillUrl("/ep.jpg"), "https://image.tmdb.org/t/p/w300/ep.jpg");
  assert.equal(stillUrl("/ep.jpg", "w185"), "https://image.tmdb.org/t/p/w185/ep.jpg");
  assert.equal(stillUrl("/ep.jpg", "original"), "https://image.tmdb.org/t/p/original/ep.jpg");
  assert.equal(stillUrl(null), null);
  assert.equal(stillUrl(""), null);
  assert.equal(stillUrl("ep.jpg"), null);
});

test("a '//'-prefixed path stays on image.tmdb.org (interpolated into the path, not protocol-relative)", () => {
  // "//host/x.jpg" starts with "/" so it passes the gate, but the result is a
  // path on image.tmdb.org — the base URL prefix means it can never re-target
  // the host. Pins that the gate + prefix compose safely.
  const url = posterUrl("//evil.example/x.jpg");
  assert.equal(url, "https://image.tmdb.org/t/p/w342//evil.example/x.jpg");
  assert.equal(new URL(url as string).hostname, "image.tmdb.org");
});

test("languageName maps ISO codes to English display names", () => {
  assert.equal(languageName("en"), "English");
  assert.equal(languageName("fr"), "French");
  assert.equal(languageName("ja"), "Japanese");
});

test("languageName resolves regional subtags", () => {
  const name = languageName("pt-BR");
  // Exact wording varies by ICU version ("Brazilian Portuguese" vs
  // "Portuguese (Brazil)") — assert it resolved to a Portuguese variant.
  assert.ok(name);
  assert.equal(name.includes("Portuguese"), true);
});

test("languageName returns null for null/undefined/empty input", () => {
  assert.equal(languageName(null), null);
  assert.equal(languageName(undefined), null);
  assert.equal(languageName(""), null);
});

test("languageName is null for unknown or malformed codes, never throws, never the code", () => {
  // Intl echoes an unassigned code back unchanged; that is not a name. The
  // callers (spokenLanguages, the detail pages) put the raw code behind `??`/`||`
  // themselves, which only works if this returns null.
  assert.equal(languageName("zz"), null); // structurally valid, unassigned
  assert.equal(languageName("!!"), null); // malformed tag → Intl throws RangeError → caught
  // The cached Intl.DisplayNames instance must survive a thrown lookup:
  assert.equal(languageName("fr"), "French");
});

test("languageName names in the viewer's language, capitalised as a standalone label", () => {
  assert.equal(languageName("fr", "fr"), "Français");
  assert.equal(languageName("en", "es"), "Inglés");
});

test("regionName names a known code in English by default and in the given locale", () => {
  assert.equal(regionName("US"), "United States");
  assert.equal(regionName("US", "es"), "Estados Unidos");
  assert.equal(regionName("de", "fr"), "Allemagne", "lower-case input is a region code too");
  assert.equal(regionName(null), null);
  assert.equal(regionName(""), null);
});

test("regionName is null for a code Intl has no name for — so a `?? tmdbName` fallback can fire", () => {
  assert.equal(regionName("XC"), null, "TMDB's Czechoslovakia");
  assert.equal(regionName("XG", "es"), null, "TMDB's East Germany");
  assert.equal(regionName("QQ"), null);
  assert.equal(regionName("USA"), null, "malformed (3 letters) → Intl throws → null, not a throw");
});

test("regionName aliases TMDB's legacy codes at successor states — a non-null WRONG answer the helper below must catch", () => {
  // Documents WHY localizedProductionCountry cannot rely on `??`: for these
  // codes Intl answers, confidently, with a different country.
  assert.notEqual(regionName("SU"), null);
  assert.notEqual(regionName("SU"), "Soviet Union");
  assert.notEqual(regionName("YU"), null);
  assert.notEqual(regionName("YU"), "Yugoslavia");
});

// ── localizedProductionCountry ──────────────────────────────────────────────
const soviet = { productionCountryCodes: ["SU"], productionCountries: ["Soviet Union"] };
const czechoslovak = { productionCountryCodes: ["XC"], productionCountries: ["Czechoslovakia"] };
const yugoslav = { productionCountryCodes: ["YU"], productionCountries: ["Yugoslavia"] };
// TMDB's real wording for US differs from Intl's ("United States of America"
// vs "United States") — the same country, so it IS translated.
const american = { productionCountryCodes: ["US"], productionCountries: ["United States of America"] };
const german = { productionCountryCodes: ["DE"], productionCountries: ["Germany"] };

test("localizedProductionCountry: the English page renders TMDB's own name unchanged, for every code", () => {
  assert.equal(localizedProductionCountry(soviet, "en"), "Soviet Union");
  assert.equal(localizedProductionCountry(czechoslovak, "en"), "Czechoslovakia");
  assert.equal(localizedProductionCountry(american, "en"), "United States of America");
  assert.equal(localizedProductionCountry(german, "en"), "Germany");
});

test("localizedProductionCountry: another language is translated where Intl and TMDB agree on the country", () => {
  assert.equal(localizedProductionCountry(american, "es"), "Estados Unidos");
  assert.equal(localizedProductionCountry(american, "fr"), "États-Unis");
  assert.equal(localizedProductionCountry(german, "es"), "Alemania");
});

test("localizedProductionCountry: a legacy code ICU re-targets keeps TMDB's English name in every language", () => {
  assert.equal(localizedProductionCountry(soviet, "es"), "Soviet Union", "never Intl's 'Rusia'");
  assert.equal(localizedProductionCountry(soviet, "fr"), "Soviet Union");
  assert.equal(localizedProductionCountry(yugoslav, "es"), "Yugoslavia", "never Intl's 'Serbia'");
});

test("localizedProductionCountry: a code Intl cannot name keeps TMDB's English name, never the bare code", () => {
  assert.equal(localizedProductionCountry(czechoslovak, "es"), "Czechoslovakia");
  assert.equal(localizedProductionCountry({ productionCountryCodes: ["XG"], productionCountries: ["East Germany"] }, "de"), "East Germany");
});

test("localizedProductionCountry: a retargeted code whose Intl English name already matches TMDB's is translated", () => {
  // TMDB and Intl agree ("Russia" under a legacy code) ⇒ nothing to protect.
  assert.equal(localizedProductionCountry({ productionCountryCodes: ["SU"], productionCountries: ["Russia"] }, "es"), "Rusia");
});

test("localizedProductionCountry: nothing to show is null (omitted), never a bare code", () => {
  assert.equal(localizedProductionCountry({ productionCountryCodes: ["QQ"] }, "en"), null);
  assert.equal(localizedProductionCountry({ productionCountryCodes: ["QQ"], productionCountries: [] }, "es"), null);
  assert.equal(localizedProductionCountry({}, "es"), null);
  // A code without a TMDB name (unreachable from tmdb.ts, which always writes
  // both) still names a known country in the viewer's language.
  assert.equal(localizedProductionCountry({ productionCountryCodes: ["US"] }, "es"), "Estados Unidos");
});

test("localizedProductionCountry: a row cached before productionCountryCodes existed keeps its English name", () => {
  assert.equal(localizedProductionCountry({ productionCountries: ["Germany"] }, "es"), "Germany");
  assert.equal(localizedProductionCountry({ productionCountries: ["Germany"] }, "en"), "Germany");
});

test("localizedProductionCountry: index-aligned — the second country follows the same rule", () => {
  const two = { productionCountryCodes: ["SU", "GB"], productionCountries: ["Soviet Union", "United Kingdom"] };
  assert.equal(localizedProductionCountry(two, "es", 1), "Reino Unido");
  assert.equal(localizedProductionCountry(two, "es", 0), "Soviet Union");
  assert.equal(localizedProductionCountry(two, "es", 2), null);
});
