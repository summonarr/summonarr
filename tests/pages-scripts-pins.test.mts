// Bug-hunt pins for the page / script partition.
//
//   1. Repeated query keys. Next hands a page `?q=a&q=b` as an ARRAY at runtime
//      whatever the declared prop type says. /votes already took the first value;
//      /requests, /issues, /admin/issues, /admin/audit-log and
//      /admin/activity/users called `.trim()` / `.replace()` / `.toLowerCase()`
//      (or passed an array as a Prisma `id`) on the raw value, so one repeated key
//      turned the page into the error boundary.
//   2. scripts/smoke-test.sh's plaintext-secret check carries its own copy of the
//      sensitive Setting keys. It had dropped `traktClientSecret`, so a plaintext
//      Trakt secret passed the "No sensitive Setting keys stored in plaintext" check.
//
// Both read SOURCE (the pages are server components that cannot be mounted here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_SENSITIVE_KEYS } from "@/lib/settings-sensitive-keys.ts";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// /requests and /issues read every key through the shared first() instead.
for (const [file, keys] of [
  ["src/app/(app)/requests/page.tsx", ["q", "status", "sort"]],
  ["src/app/(app)/issues/page.tsx", ["q", "selected", "status", "type"]],
] as const) {
  test(`${file} reads its query through PageSearchParams and first()`, () => {
    const src = read(file);
    assert.match(src, /searchParams: Promise<PageSearchParams>/);
    for (const key of keys) assert.match(src, new RegExp(`first\\(sp\\.${key}\\)`), `${key} must be reduced to its first value`);
    assert.doesNotMatch(src, /\b(qParam|selectedId)\.trim\(\)/);
  });
}

const PAGES: Array<{ file: string; raws: string[] }> = [
  { file: "src/app/(app)/admin/issues/page.tsx", raws: ["selectedRaw"] },
  { file: "src/app/(app)/admin/activity/users/page.tsx", raws: ["searchRaw"] },
];

for (const { file, raws } of PAGES) {
  test(`${file} normalizes repeated query keys before using them as strings`, () => {
    const src = read(file);
    for (const raw of raws) {
      assert.match(
        src,
        new RegExp(`Array\\.isArray\\(${raw}\\)\\s*\\?\\s*${raw}\\[0\\]\\s*:\\s*${raw}`),
        `${raw} must be reduced to its first value`,
      );
    }
    // The raw destructured names must not be used as strings anywhere else.
    for (const raw of raws) {
      const uses = src.split(raw).length - 1;
      assert.equal(uses, 4,`${raw} should appear only in the destructure + the normalization (found ${uses})`);
    }
  });
}

// The audit-log page reads its filter the way the list and export routes do:
// through a URLSearchParams (a repeated key is its first value) handed to the
// shared builder, never by calling a string method on a raw prop.
test("src/app/(app)/admin/audit-log/page.tsx reads its filter through a URLSearchParams, first value per key", () => {
  const src = read("src/app/(app)/admin/audit-log/page.tsx");
  assert.match(src, /new URLSearchParams\(\)/);
  assert.match(src, /Array\.isArray\(value\) \? value : /, "an array value must be appended item by item");
  assert.match(src, /buildAuditLogWhere\(query\)/);
  assert.doesNotMatch(src, /sanitizeContainsSearch/, "the builder sanitizes; the page never touches a raw value");
});

test("smoke-test.sh checks every static sensitive Setting key for plaintext", () => {
  const script = read("scripts/smoke-test.sh");
  const m = script.match(/key IN \(([^)]*)\)/);
  assert.ok(m, "smoke-test.sh no longer has the sensitive-key IN (...) list");
  const listed = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  for (const key of SETTINGS_SENSITIVE_KEYS) {
    assert.ok(listed.has(key), `smoke-test.sh plaintext check is missing ${key}`);
  }
});

// A six-figure played list passed through push(...spread) exceeds the engine's
// argument limit and fails the whole server's snapshot.
test("upstream-watch-data does not spread an unbounded collection into push()", () => {
  const src = read("src/lib/upstream-watch-data.ts");
  assert.doesNotMatch(src, /\.push\(\s*\.\.\.byItem\.values\(\)\s*\)/);
});
