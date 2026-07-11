// Unit tests for the TMDB image-URL builders and language helper
// (src/lib/tmdb-types.ts). The URL builders gate on a leading "/" so garbage
// paths from older cache rows (empty strings, bare filenames, absolute URLs)
// can never be interpolated into an image.tmdb.org URL — a bad path must
// yield null (no <img src>) rather than a broken or attacker-shaped URL.
// languageName must return the raw code, never throw, for unknown/malformed
// ISO codes coming out of TMDB responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { posterUrl, backdropUrl, stillUrl, languageName } from "../src/lib/tmdb-types.ts";

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

test("languageName falls back to the raw code for unknown or malformed codes, never throws", () => {
  assert.equal(languageName("zz"), "zz"); // structurally valid, unassigned → code fallback
  assert.equal(languageName("!!"), "!!"); // malformed tag → Intl throws RangeError → caught → code
  // The cached Intl.DisplayNames instance must survive a thrown lookup:
  assert.equal(languageName("fr"), "French");
});
