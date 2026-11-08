// Admin → Calendar reads what the server sends through a schema before
// drawing it (src/components/admin/arr-calendar-state.ts): a report missing
// its entries or its clock is a failed load, never a crash in render; and the
// command-watch line keeps one live region.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/lib/validate.ts";

const { CalendarReportSchema } = await import("../src/components/admin/arr-calendar-state.ts");

const entry = {
  key: "radarr::1:cinema",
  service: "radarr",
  instance: "",
  kind: "cinema",
  date: "2026-11-07T00:00:00.000Z",
  arrId: 1,
  episodeId: null,
  title: "Dune",
  year: 2021,
  tmdbId: 438631,
  tvdbId: null,
  posterPath: "/d.jpg",
  seasonNumber: null,
  episodeNumber: null,
  episodeTitle: null,
  finaleType: null,
  network: "Legendary",
  monitored: true,
  hasFile: false,
  status: "missing",
  progress: null,
  attention: false,
};
const report = {
  instances: [{ service: "radarr", slug: "", name: "Radarr" }],
  errors: [{ service: "sonarr", instance: "anime", kind: "timeout" }],
  entries: [entry],
  now: "2026-11-07T12:00:00.000Z",
};

test("a well-formed calendar report passes, every field the page reads kept", () => {
  const r = check(CalendarReportSchema, { ...report, extra: "dropped" });
  assert.ok(r.ok);
  assert.deepEqual(r.value, report);
  assert.ok(!("extra" in r.value));
});

test("a report with no entries list, no errors list or no clock is refused", () => {
  for (const field of ["entries", "errors", "instances", "now"] as const) {
    const { [field]: _gone, ...rest } = report;
    const r = check(CalendarReportSchema, rest);
    assert.ok(!r.ok, `${field} missing`);
  }
  assert.ok(!check(CalendarReportSchema, null).ok);
  assert.ok(!check(CalendarReportSchema, { ...report, now: 1730980800000 }).ok, "the clock is the ISO string the page parses");
});

test("an entry the page can't draw fails the whole report", () => {
  const bad = (patch: Record<string, unknown>) => check(CalendarReportSchema, { ...report, entries: [{ ...entry, ...patch }] });
  assert.ok(!bad({ status: "lost" }).ok, "a status with no chip tone");
  assert.ok(!bad({ kind: "vhs" }).ok);
  assert.ok(!bad({ service: "lidarr" }).ok);
  assert.ok(!bad({ arrId: "1" }).ok);
  assert.ok(!bad({ title: null }).ok);
  assert.ok(bad({ progress: 0.42, status: "downloading" }).ok);
});

test("an error kind the page doesn't know still loads (it reads as 'other' at render)", () => {
  const r = check(CalendarReportSchema, { ...report, errors: [{ service: "radarr", instance: "", kind: "brand-new" }] });
  assert.ok(r.ok);
  const page = readFileSync(new URL("../src/components/admin/arr-calendar.tsx", import.meta.url), "utf8");
  assert.match(page, /ARR_ERROR_KIND_KEYS\[isArrErrorKind\(e\.kind\) \? e\.kind : "other"\]/);
});

test("the command-watch line is one live region whose politeness rises on a failure — never a role swapped after mount", () => {
  const src = readFileSync(new URL("../src/components/admin/arr-command-watch.tsx", import.meta.url), "utf8");
  assert.match(src, /role="status"\s+aria-live=\{tone === "danger" \? "assertive" : "polite"\}/);
  assert.doesNotMatch(src, /role=\{tone/);
});
