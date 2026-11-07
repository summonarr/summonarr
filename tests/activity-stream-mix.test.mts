// The play-method mix behind the Activity stream-type bars. Methods the UI
// doesn't name (a null method reads "Unknown") fold into one "other" count, and
// the total covers all of it — dropping them made 3 transcodes beside 97
// unknown sessions read "100% Transcode" on the title and user detail pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STREAM_METHODS, foldStreamMethods, streamMixSegments } from "../src/lib/activity-stream-mix.ts";

test("unnamed methods fold into other, and the total counts every session", () => {
  const mix = foldStreamMethods([
    { method: "Transcode", count: 3 },
    { method: "Unknown", count: 97 },
  ]);
  assert.deepEqual(mix.counts, { DirectPlay: 0, DirectStream: 0, Transcode: 3 });
  assert.equal(mix.other, 97);
  assert.equal(mix.total, 100);
  assert.equal(Math.round((mix.counts.Transcode / mix.total) * 100), 3, "3%, not 100%");
});

test("counts are by name, so the input order never changes them", () => {
  const rows = [
    { method: "DirectPlay", count: 40 },
    { method: "Transcode", count: 10 },
    { method: "DirectStream", count: 5 },
    { method: "Copy", count: 2 },
  ];
  const a = foldStreamMethods(rows);
  const b = foldStreamMethods([...rows].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.counts.DirectPlay, 40);
  assert.equal(a.other, 2);
  assert.equal(a.total, 57);
  assert.deepEqual([...STREAM_METHODS], ["DirectPlay", "DirectStream", "Transcode"]);
});

test("the named counts and other always add up to the total, even when a method repeats", () => {
  const mix = foldStreamMethods([
    { method: "DirectPlay", count: 4 },
    { method: "Unknown", count: 1 },
    { method: "DirectPlay", count: 6 },
  ]);
  assert.equal(mix.counts.DirectPlay, 10);
  assert.equal(mix.counts.DirectPlay + mix.counts.DirectStream + mix.counts.Transcode + mix.other, mix.total);
});

test("an empty ratio is all zeros", () => {
  assert.deepEqual(foldStreamMethods([]), {
    counts: { DirectPlay: 0, DirectStream: 0, Transcode: 0 },
    other: 0,
    total: 0,
  });
});

test("the bar segments come out in method order, with one Other only when something else was recorded", () => {
  assert.deepEqual(
    streamMixSegments(foldStreamMethods([
      { method: "Transcode", count: 3 },
      { method: "Unknown", count: 90 },
      { method: "DirectPlay", count: 5 },
      { method: "Copy", count: 7 },
    ])),
    [
      { key: "DirectPlay", count: 5 },
      { key: "DirectStream", count: 0 },
      { key: "Transcode", count: 3 },
      { key: "Other", count: 97 },
    ],
  );
  assert.deepEqual(
    streamMixSegments(foldStreamMethods([{ method: "DirectPlay", count: 2 }])).map((s) => s.key),
    ["DirectPlay", "DirectStream", "Transcode"],
    "no Other segment when every session had a named method",
  );
  const mix = foldStreamMethods([{ method: "Transcode", count: 1 }, { method: "Unknown", count: 4 }]);
  assert.equal(streamMixSegments(mix).reduce((n, s) => n + s.count, 0), mix.total, "the segments sum to the total");
});

test("the stats, title and user views draw their segments from the shared fold and meta, and direct play is read by name", () => {
  for (const rel of ["activity-stats-redesign.tsx", "activity-title-detail.tsx", "activity-user-detail.tsx"]) {
    const src = readFileSync(new URL(`../src/components/admin/${rel}`, import.meta.url), "utf8");
    assert.match(src, /const streamMix = foldStreamMethods\((s|stats)\.transcodeRatio\);/, `${rel} folds the whole ratio`);
    assert.match(src, /const streamTypes = streamTypeSegments\(t, streamMix\);/, `${rel} builds its bars through the shared helper`);
    assert.doesNotMatch(src, /STREAM_META|STREAM_METHODS\.map/, `${rel} keeps no private copy of the method labels and colours`);
  }
  const ui = readFileSync(new URL("../src/components/admin/activity-ui.tsx", import.meta.url), "utf8");
  assert.match(ui, /export const STREAM_META: Record<StreamSegmentKey, \{ labelKey: string; color: string \}>/);
  assert.match(ui, /Other: \{ labelKey: "adminActivity\.method\.other", color: "var\(--ds-fg-disabled\)" \}/);
  assert.match(ui, /return streamMixSegments\(mix\)\.map\(/);

  const stats = readFileSync(new URL("../src/components/admin/activity-stats-redesign.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(stats, /streamTypes\[0\]/, "the direct-play share must not depend on bar order");
  assert.match(stats, /streamShares\(\s*streamMix,\s*stats\.transcodeReasons,?\s*\)/);
});
