// Unit tests for the shared relative-time formatter (src/lib/relative-time.ts).
// Pins the unit boundaries ("just now" / m / h / d) so a refactor can't silently
// shift a threshold — these strings render on every activity/audit table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { formatRelativeTime, formatRelativeTimeLocalized } from "../src/lib/relative-time.ts";

test("under a minute → \"just now\"", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now), "just now");
  assert.equal(formatRelativeTime(now - 59_000), "just now");
});

test("minutes: 1m at 60s, caps at 59m", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 60_000), "1m ago");
  assert.equal(formatRelativeTime(now - 5 * 60_000), "5m ago");
  assert.equal(formatRelativeTime(now - (59 * 60_000 + 59_000)), "59m ago");
});

test("hours: 1h at 60m, caps at 23h", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 60 * 60_000), "1h ago");
  assert.equal(formatRelativeTime(now - (23 * 60 * 60_000 + 59 * 60_000)), "23h ago");
});

test("days from 24h up, unbounded", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 24 * 60 * 60_000), "1d ago");
  assert.equal(formatRelativeTime(now - 400 * 24 * 60 * 60_000), "400d ago");
});

test("accepts Date, ISO string, and epoch number", () => {
  const fiveMinAgo = Date.now() - 5 * 60_000;
  assert.equal(formatRelativeTime(new Date(fiveMinAgo)), "5m ago");
  assert.equal(formatRelativeTime(new Date(fiveMinAgo).toISOString()), "5m ago");
  assert.equal(formatRelativeTime(fiveMinAgo), "5m ago");
});

test("future timestamps degrade to \"just now\" (never negative units)", () => {
  assert.equal(formatRelativeTime(Date.now() + 60 * 60_000), "just now");
});

// An unparseable timestamp renders nothing rather than "NaNd ago" in the
// activity/audit tables, the same as the localized variant.
test("unparseable input renders an empty string", () => {
  assert.equal(formatRelativeTime("garbage"), "");
  assert.equal(formatRelativeTime(new Date(NaN)), "");
  assert.equal(formatRelativeTime(Number.NaN), "");
});

// ── formatRelativeTimeLocalized ─────────────────────────────────────────────

test("localized: English keeps the compact form; another language goes through Intl with the same buckets", () => {
  const now = Date.now();
  // ICU spaces French with a no-break space; compare the words, not the space kind.
  const loc = (ms: number, locale: string) => formatRelativeTimeLocalized(ms, locale).replace(/\s/g, " ");
  assert.equal(loc(now - 5 * 60_000, "en"), "5m ago");
  assert.equal(loc(now - 5 * 60_000, "fr"), "il y a 5 min");
  assert.equal(loc(now - 3 * 60 * 60_000, "es"), "hace 3 h");
  assert.equal(loc(now - 4 * 24 * 60 * 60_000, "fr"), "il y a 4 j");
  assert.equal(loc(now, "de"), "jetzt");
});

test("localized: an unparsable date renders nothing instead of throwing a RangeError mid-render", () => {
  assert.equal(formatRelativeTimeLocalized("garbage", "es"), "");
  assert.equal(formatRelativeTimeLocalized(new Date(NaN), "fr"), "");
  assert.equal(formatRelativeTimeLocalized(Number.NaN, "zh"), "");
});

// The profile page used to carry a second, catalog-worded copy of these buckets,
// so one timestamp read differently in two cards. There is ONE formatter.
test("no component carries its own relative-time formatter", () => {
  const root = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const child = new URL(name, dir);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(ts|tsx)$/.test(name)) {
        const src = readFileSync(child, "utf8");
        if (/translatedRelativeTime|from "\.\/relative-time"/.test(src)) offenders.push(child.pathname);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test("an unparsable date renders nothing in every variant, never NaN", async () => {
  const { formatRelativeTimeWithDateFallback } = await import("../src/lib/relative-time.ts");
  assert.equal(formatRelativeTime("not a date"), "");
  assert.equal(formatRelativeTimeWithDateFallback("not a date"), "");
  assert.equal(formatRelativeTimeLocalized("not a date", "es"), "");
});

test("the date fallback starts at 30 days and takes a locale", async () => {
  const { formatRelativeTimeWithDateFallback } = await import("../src/lib/relative-time.ts");
  const day = 24 * 60 * 60_000;
  assert.equal(formatRelativeTimeWithDateFallback(Date.now() - 29 * day), "29d ago");
  const old = Date.UTC(2020, 0, 15, 12);
  assert.equal(formatRelativeTimeWithDateFallback(old), "Jan 15, 2020");
  assert.equal(formatRelativeTimeWithDateFallback(old, "de-DE"), new Date(old).toLocaleDateString("de-DE", { month: "short", day: "numeric", year: "numeric" }));
});
