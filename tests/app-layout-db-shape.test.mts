// Source-level pin for the (app) layout's per-render DB shape (review
// 2026-09, finding f21). The layout imports .tsx components, so it cannot be
// loaded under the test runner — the idiom here is the same as
// tests/app-page-auth-guard.test.mts: read the source and pin its structure.
//
// Two things are pinned:
//   1. `generateMetadata` and the layout body share ONE settings read via
//      React `cache`. Next memoizes only `fetch()` between the two; a Prisma
//      read is not deduped, so a bare `setting.findUnique({ key: "siteTitle" })`
//      in generateMetadata re-reads a row the body's findMany already fetched
//      on every (app) page render.
//   2. The `discordId` lookup rides in the same `Promise.all` as the settings
//      and feature-flag reads instead of being awaited serially after them —
//      session.user.id is known before the batch, so the serial form added a
//      full DB round-trip of latency to every page on any deployment with a
//      Discord invite configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LAYOUT = join(process.cwd(), "src", "app", "(app)", "layout.tsx");
const src = readFileSync(LAYOUT, "utf8");

test("(app) layout: generateMetadata reads siteTitle through the React-cached settings read, not its own findUnique", () => {
  assert.match(src, /import\s*\{\s*cache\s*\}\s*from\s*["']react["']/, "React `cache` must be imported");
  assert.match(src, /const readLayoutSettings = cache\(/, "the shared settings read must be wrapped in cache()");
  assert.doesNotMatch(
    src,
    /setting\.findUnique\(\s*\{\s*where:\s*\{\s*key:\s*["']siteTitle["']/,
    "generateMetadata must not issue its own siteTitle read — it duplicates the body's findMany",
  );
  const meta = src.slice(src.indexOf("export async function generateMetadata"), src.indexOf("export default async function AppLayout"));
  assert.match(meta, /readLayoutSettings\(\)/, "generateMetadata must go through readLayoutSettings()");
});

test("(app) layout: the discordId lookup is batched into the Promise.all, not awaited serially after it", () => {
  const body = src.slice(src.indexOf("export default async function AppLayout"));
  const batchStart = body.indexOf("await Promise.all([");
  assert.ok(batchStart >= 0, "the layout body must batch its reads in a Promise.all");
  const batchEnd = body.indexOf("]);", batchStart);
  const batch = body.slice(batchStart, batchEnd);
  assert.match(batch, /readLayoutSettings\(\)/, "settings read must be in the batch");
  assert.match(batch, /getFeatureFlags\(\)/, "feature-flag read must be in the batch");
  assert.match(batch, /user\.findUnique\(/, "the discordId lookup must be in the batch");
  // Exactly one user.findUnique in the body, and it lives inside the batch —
  // a second, serial one after the batch is the regression.
  const after = body.slice(batchEnd);
  assert.doesNotMatch(after, /user\.findUnique\(/, "no serial user.findUnique may follow the batch");
  assert.doesNotMatch(after, /await prisma\./, "no serial prisma read may follow the batch");
});

test("(app) layout: the DB-checked login gate still precedes and sits outside the try/catch (guardrail 29)", () => {
  const body = src.slice(src.indexOf("export default async function AppLayout"));
  const gate = body.indexOf('if (!session) redirect("/login")');
  const tryStart = body.indexOf("try {");
  assert.ok(gate >= 0, "redirect gate must exist");
  assert.ok(tryStart > gate, "redirect gate must precede the try/catch so NEXT_REDIRECT is never swallowed");
});
