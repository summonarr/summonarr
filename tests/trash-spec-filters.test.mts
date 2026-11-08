// What "Managed", "Paused", "Unmanaged" and "Errored" mean on a TRaSH spec tab
// (src/components/admin/trash-guides/spec-filters.ts) — one predicate each,
// shared by the filter chips, the quick-select, the header counts and the
// Overview's KPIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countSpecs, filterSpecs, specMatches, SPEC_FILTERS } from "../src/components/admin/trash-guides/spec-filters.ts";

const app = (o: { enabled?: boolean; lastError?: string | null } = {}) => ({
  id: "a", enabled: true, remoteId: 1, appliedAt: "2026-08-01T00:00:00Z", lastError: null, lastErrorAt: null, errorCount: 0, ...o,
});
const spec = (name: string, application: ReturnType<typeof app> | null) => ({ name, trashId: `${name.toLowerCase()}-id`, application });
const specs = [
  spec("Managed", app()),
  spec("Paused", app({ enabled: false })),
  spec("Errored", app({ lastError: "400" })),
  spec("Fresh", null),
];

test("a paused spec is not managed: the filter, the count and the quick-select agree", () => {
  assert.deepEqual(filterSpecs(specs, "managed", "").map((s) => s.name), ["Managed", "Errored"]);
  assert.equal(countSpecs(specs, "managed"), 2, "the header count is the filter's set");
  assert.deepEqual(filterSpecs(specs, "paused", "").map((s) => s.name), ["Paused"]);
  assert.deepEqual(filterSpecs(specs, "unmanaged", "").map((s) => s.name), ["Fresh"]);
  assert.deepEqual(filterSpecs(specs, "errored", "").map((s) => s.name), ["Errored"]);
  assert.equal(filterSpecs(specs, "all", "").length, 4);
  // Managed, paused and unmanaged split the catalog.
  assert.equal(countSpecs(specs, "managed") + countSpecs(specs, "paused") + countSpecs(specs, "unmanaged"), specs.length);
});

test("the search reads the name and trashId, case-insensitively, inside the filter", () => {
  assert.deepEqual(filterSpecs(specs, "all", "FRESH-ID").map((s) => s.name), ["Fresh"]);
  assert.deepEqual(filterSpecs(specs, "managed", "pau").map((s) => s.name), []);
});

test("the spec tab and the Overview KPIs use the shared predicates, never their own", () => {
  const read = (f: string) => readFileSync(new URL(`../src/components/admin/trash-guides/${f}`, import.meta.url), "utf8");
  const section = read("spec-section.tsx");
  assert.match(section, /filterSpecs\(specsHere, filter, deferredSearch\)/, "the list (searched at low priority)");
  assert.match(section, /const selectBy = \(f: SpecFilter\) => setSelected\(new Set\(filtered\.filter\(\(s\) => specMatches\(s, f\)\)/, "the quick-select");
  assert.match(section, /countSpecs\(specs, "managed"\)/, "the header count");
  assert.doesNotMatch(section, /application\?\.enabled\)|!!s\.application\b/, "no private 'managed' left");
  assert.match(read("overview-kpis.tsx"), /specMatches\(s, "managed"\)/);
  assert.ok(SPEC_FILTERS.includes("paused"));
  assert.equal(specMatches({ application: null }, "errored"), false);
});
