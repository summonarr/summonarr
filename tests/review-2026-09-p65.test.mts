// Review 2026-09 / P65 / f91 — BrowseGrid must not render the failure banner
// AND the "TMDB token not configured" empty state together.
//
// The pages (movies/page.tsx, tv/page.tsx) map a runBrowseQuery rejection to
// `{ items: [], failed: true }`, so on a TMDB outage `failed` is true AND the
// item list is empty. The empty-state ternary therefore has to be gated on
// `!failed`, or the grid shows the retry banner immediately followed by the
// wrong-cause "Set TMDB_READ_TOKEN" message — exactly what the `failed` prop
// exists to prevent.
//
// The node:test loader cannot import .tsx, so this is a structural pin on the
// source (same shape as tests/client-render-purity.test.mts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(here, "..", "src", "components", "media", "browse-grid.tsx"),
  "utf8",
);

test("f91: the empty-state branch is exclusive of the failure banner", () => {
  // The banner is gated on `failed && !isPending`; the empty state must carry
  // the complementary `!failed` guard so at most one of the two renders.
  assert.match(src, /failed && !isPending && \(/, "failure banner gate missing");
  assert.match(
    src,
    /items\.length === 0 && !isPending && !failed \? \(/,
    "empty-state ternary must be gated on `!failed` (guardrail: one cause, one message)",
  );
  // And the wrong-cause empty state is still the fallback for a genuine
  // no-token empty result (not deleted by mistake).
  assert.match(src, /title="TMDB token not configured"/);
});

test("f91: the banner does not claim a previous view is shown", () => {
  // The component no longer keeps a client-fetched previous view (the server
  // owns the render), so the banner must not promise one.
  assert.doesNotMatch(src, /Showing the previous view/);
  assert.match(src, /Couldn&apos;t load results from TMDB/);
});
