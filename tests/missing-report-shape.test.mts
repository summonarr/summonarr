// What Admin → Missing accepts as a list from GET /api/admin/missing — live or
// snapshot (src/components/admin/missing-report-shape.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MISSING_REPORT } from "../src/components/admin/missing-report-shape.ts";
import { check } from "../src/lib/validate.ts";

const movie = { instance: "", arrId: 10, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, posterPath: null, inCinemas: null, physicalRelease: null, digitalRelease: null, releasedAt: "2026-01-01T00:00:00Z", daysMissing: 5 };
const report = { service: "radarr", enabled: true, instances: [{ slug: "", name: "Radarr" }], errors: [{ instance: "4k", error: "ECONNREFUSED", kind: "unreachable" }], items: [movie] };

test("a report is accepted with every row handed on whole", () => {
  const read = check(MISSING_REPORT, report);
  assert.ok(read.ok);
  assert.deepEqual(read.ok && read.value.items[0], movie, "a row keeps its display fields");
  assert.ok(check(MISSING_REPORT, { ...report, truncated: [{ instance: "", read: 20000, total: 25000 }] }).ok);
});

test("an error body, a row without its identity, or an unknown error kind is refused, never a list", () => {
  assert.equal(check(MISSING_REPORT, { error: "Radarr is down" }).ok, false);
  assert.equal(check(MISSING_REPORT, { ...report, items: [{ ...movie, arrId: "10" }] }).ok, false);
  assert.equal(check(MISSING_REPORT, { ...report, items: [{ ...movie, instance: undefined }] }).ok, false);
  assert.equal(check(MISSING_REPORT, { ...report, errors: [{ instance: "", error: "x", kind: "cosmic" }] }).ok, false);
  assert.equal(check(MISSING_REPORT, null).ok, false);
});

test("the route's own report type is what the check describes", () => {
  const data = readFileSync(new URL("../src/lib/arr-missing-data.ts", import.meta.url), "utf8");
  const iface = data.slice(data.indexOf("export interface MissingReport<T> {"), data.indexOf("}\n", data.indexOf("export interface MissingReport<T> {")));
  for (const field of ["service:", "enabled:", "instances:", "errors:", "items:", "truncated?:"]) assert.ok(iface.includes(field), field);
});
