// The Activity filter bar's rules (src/components/admin/activity-filter-rules.ts)
// and the labelled segmented groups both filter bars draw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSubPageActive, parseCustomDays, subPageHref } from "../src/components/admin/activity-filter-rules.ts";
import { ACTIVITY_MAX_DAYS } from "../src/lib/activity-days.ts";

test("the Custom period names why a value is refused", () => {
  assert.deepEqual(parseCustomDays(" 45 "), { ok: true, days: 45 });
  assert.deepEqual(parseCustomDays(""), { ok: false, errorKey: "adminActivity.filter.error.empty" });
  assert.deepEqual(parseCustomDays("4.5"), { ok: false, errorKey: "adminActivity.filter.error.whole" });
  assert.deepEqual(parseCustomDays("abc"), { ok: false, errorKey: "adminActivity.filter.error.whole" });
  assert.deepEqual(parseCustomDays("-5"), { ok: false, errorKey: "adminActivity.filter.error.range" });
  assert.deepEqual(parseCustomDays(String(ACTIVITY_MAX_DAYS + 1)), { ok: false, errorKey: "adminActivity.filter.error.range" });
});

test("a filtered tab carries the period/source/type and nothing else", () => {
  const params = new URLSearchParams("days=45&source=plex&search=neo&from=2026-10-01");
  const keys = ["days", "source", "mediaType"];
  assert.equal(subPageHref({ labelKey: "x", href: "/admin/activity/stats", filtered: true }, params, keys), "/admin/activity/stats?days=45&source=plex");
  assert.equal(subPageHref({ labelKey: "x", href: "/admin/activity/users" }, params, keys), "/admin/activity/users");
  assert.equal(subPageHref({ labelKey: "x", href: "/admin/activity", filtered: true }, new URLSearchParams(), keys), "/admin/activity");
});

test("the overview tab is active on its own path only; the others on their subtree", () => {
  const overview = { labelKey: "x", href: "/admin/activity", exact: true };
  const history = { labelKey: "x", href: "/admin/activity/history" };
  assert.equal(isSubPageActive("/admin/activity", overview), true);
  assert.equal(isSubPageActive("/admin/activity/history", overview), false);
  assert.equal(isSubPageActive("/admin/activity/history", history), true);
  assert.equal(isSubPageActive("/admin/activity/historyx", history), false);
});

// A screen reader hears "Source, group: Plex, pressed", not a bare "Plex, pressed".
test("both filter bars draw their segmented controls through the one labelled group", () => {
  const group = readFileSync(new URL("../src/components/admin/activity-seg-group.tsx", import.meta.url), "utf8");
  assert.match(group, /<span id=\{labelId\}/);
  assert.match(group, /role="group" aria-labelledby=\{labelId\}/);
  const bar = readFileSync(new URL("../src/components/admin/activity-filter-bar.tsx", import.meta.url), "utf8");
  assert.equal((bar.match(/<LabelledSegGroup\b/g) ?? []).length, 2, "Period, and Source/Type through SegmentFilter");
  assert.equal((bar.match(/<SegmentFilter\b/g) ?? []).length, 2);
  const history = readFileSync(new URL("../src/components/admin/activity-history/filter-bar.tsx", import.meta.url), "utf8");
  assert.match(history, /<LabelledSegGroup\b/);
  assert.doesNotMatch(history, /role="group"/, "no second hand-rolled group");
});
