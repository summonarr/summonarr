// RFC 5545 encoder pins (src/lib/ics.ts) for the personal calendar feed.
//
// What a calendar client actually rejects or mangles, each pinned here:
//   - LF-only line endings (Outlook refuses the file; §3.1 requires CRLF).
//   - Folding by characters instead of OCTETS, or a fold inside a multi-byte
//     UTF-8 sequence (Google renders U+FFFD, the title reads "Am�lie").
//   - Unescaped `,` `;` `\` or a raw newline in a TEXT value (the property is
//     cut short, or the rest is parsed as a new property).
//   - An all-day event whose DTEND equals DTSTART (zero-length — hidden by
//     several clients) or crosses a month/leap boundary wrongly.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  escapeIcsText,
  foldIcsLine,
  buildIcsCalendar,
  nextIsoDate,
  isIsoDate,
  icsUtcDateTime,
} = await import("../src/lib/ics.ts");

const octets = (s: string) => Buffer.byteLength(s, "utf8");
const NOW = new Date("2026-10-01T12:34:56.789Z");

// ── escaping ────────────────────────────────────────────────────────────────

test("TEXT escaping covers backslash, semicolon, comma and every newline form", () => {
  assert.equal(escapeIcsText("a\\b"), "a\\\\b");
  assert.equal(escapeIcsText("Dune; Part Two, Remastered"), "Dune\\; Part Two\\, Remastered");
  assert.equal(escapeIcsText("one\ntwo\r\nthree\rfour"), "one\\ntwo\\nthree\\nfour");
});

test("backslash is escaped FIRST, so the escapes it introduces are not doubled", () => {
  // A wrong order turns ";" into "\;" and then "\\;" — a literal backslash.
  assert.equal(escapeIcsText(";"), "\\;");
  assert.equal(escapeIcsText("\\;"), "\\\\\\;");
});

test("control characters other than TAB are stripped from TEXT", () => {
  assert.equal(escapeIcsText("a\u0000b\u0007c\td\u007f"), "abc\td");
});

// ── folding ─────────────────────────────────────────────────────────────────

test("a line of exactly 75 octets is not folded; 76 is", () => {
  assert.equal(foldIcsLine("x".repeat(75)), "x".repeat(75));
  assert.equal(foldIcsLine("x".repeat(76)), `${"x".repeat(75)}\r\n x`);
});

test("every physical line is at most 75 octets, continuation space included", () => {
  const folded = foldIcsLine("SUMMARY:" + "abcdefghij".repeat(40));
  const lines = folded.split("\r\n");
  assert.ok(lines.length > 5);
  for (const [i, l] of lines.entries()) {
    assert.ok(octets(l) <= 75, `line ${i} is ${octets(l)} octets`);
    if (i > 0) assert.equal(l[0], " ", "continuation lines start with one space");
  }
  // Unfolding (remove CRLF + one space) restores the original exactly.
  assert.equal(folded.replace(/\r\n /g, ""), "SUMMARY:" + "abcdefghij".repeat(40));
});

test("folding counts OCTETS: a 2-byte character line folds where a char count would not", () => {
  const line = "é".repeat(40); // 40 chars, 80 octets
  const folded = foldIcsLine(line);
  assert.notEqual(folded, line, "40 characters must still fold at 75 octets");
  for (const l of folded.split("\r\n")) assert.ok(octets(l) <= 75);
});

test("a fold never splits a multi-byte UTF-8 sequence (2-, 3- and 4-byte)", () => {
  for (const ch of ["é", "日", "🎬"]) {
    for (let pad = 0; pad < 6; pad++) {
      const line = "S".repeat(70 + pad) + ch.repeat(30);
      const folded = foldIcsLine(line);
      const bytes = Buffer.from(folded, "utf8");
      // Round-trip through bytes: a split sequence decodes to U+FFFD.
      assert.ok(!bytes.toString("utf8").includes("�"), `split ${ch} at pad ${pad}`);
      for (const l of folded.split("\r\n")) {
        assert.ok(octets(l) <= 75, `${ch} pad ${pad}: ${octets(l)} octets`);
        // Each physical line is itself valid UTF-8 (no dangling lead/continuation byte).
        assert.equal(Buffer.from(l, "utf8").toString("utf8"), l);
      }
      assert.equal(folded.replace(/\r\n /g, ""), line);
    }
  }
});

// ── dates ───────────────────────────────────────────────────────────────────

test("nextIsoDate rolls month, year and leap-day boundaries", () => {
  assert.equal(nextIsoDate("2026-01-31"), "2026-02-01");
  assert.equal(nextIsoDate("2026-12-31"), "2027-01-01");
  assert.equal(nextIsoDate("2028-02-28"), "2028-02-29");
  assert.equal(nextIsoDate("2027-02-28"), "2027-03-01");
});

test("isIsoDate rejects impossible and malformed dates", () => {
  assert.ok(isIsoDate("2028-02-29"));
  assert.ok(!isIsoDate("2027-02-29"));
  assert.ok(!isIsoDate("2026-13-01"));
  assert.ok(!isIsoDate("2026-1-01"));
  assert.ok(!isIsoDate("2026-01-01T00:00:00Z"));
});

test("DTSTAMP is UTC basic format", () => {
  assert.equal(icsUtcDateTime(NOW), "20261001T123456Z");
});

// ── document ────────────────────────────────────────────────────────────────

function build(events: Parameters<typeof buildIcsCalendar>[0]["events"]) {
  return buildIcsCalendar({ name: "Summonarr – My releases", refreshInterval: "PT6H", events, now: NOW });
}

test("every line ends in CRLF, including the last, with no bare LF anywhere", () => {
  const ics = build([{ uid: "movie-1-digital@summonarr", date: "2026-10-05", summary: "A\nB" }]);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false, "no bare LF");
  assert.equal(ics.replace(/\r\n/g, "").includes("\r"), false, "no bare CR");
});

test("calendar header carries VERSION, PRODID, CALSCALE, METHOD, name and refresh hints", () => {
  const lines = build([]).split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  for (const want of [
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Summonarr – My releases",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ]) {
    assert.ok(lines.includes(want), `missing ${want}`);
  }
  assert.ok(lines.some((l) => l.startsWith("PRODID:")));
});

test("an all-day event is DTSTART;VALUE=DATE with an exclusive next-day DTEND", () => {
  const ics = build([
    {
      uid: "tv-95396-s2e3@summonarr",
      date: "2026-12-31",
      summary: "Severance S02E03 – Who Is Alive?",
      description: "Episode air date\nhttps://example.com/tv/95396",
      url: "https://example.com/tv/95396",
    },
  ]);
  const lines = ics.replace(/\r\n /g, "").split("\r\n");
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261231"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20270101"));
  assert.ok(lines.includes("UID:tv-95396-s2e3@summonarr"));
  assert.ok(lines.includes("DTSTAMP:20261001T123456Z"));
  assert.ok(lines.includes("SUMMARY:Severance S02E03 – Who Is Alive?"));
  assert.ok(lines.includes("DESCRIPTION:Episode air date\\nhttps://example.com/tv/95396"));
  assert.ok(lines.includes("URL:https://example.com/tv/95396"));
  assert.ok(lines.includes("TRANSP:TRANSPARENT"));
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, 1);
  assert.equal(lines.filter((l) => l === "END:VEVENT").length, 1);
});

test("an event with an invalid date is dropped rather than emitted malformed", () => {
  const ics = build([{ uid: "x@summonarr", date: "2026-02-30", summary: "Bad" }]);
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});

test("a long multibyte SUMMARY is folded within the document too", () => {
  const ics = build([{ uid: "m@summonarr", date: "2026-10-05", summary: "Amélie ".repeat(30) }]);
  for (const l of ics.split("\r\n")) assert.ok(octets(l) <= 75, `${octets(l)}: ${l}`);
  assert.ok(ics.replace(/\r\n /g, "").includes(`SUMMARY:${"Amélie ".repeat(30)}`));
});
