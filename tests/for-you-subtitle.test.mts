// The For You page's subtitle (src/lib/for-you-subtitle.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForYouSubtitle } from "@/lib/for-you-subtitle.ts";
import type { Translator } from "@/lib/i18n/translate.ts";

const t = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key}${JSON.stringify(vars)}` : key)) as Translator;
const none = { watchHistorySeeds: 0, watchlistSeeds: 0, requestSeeds: 0 };
const NOW = Date.UTC(2026, 0, 1, 12);

test("an empty shelf has the plain subtitle", () => {
  assert.equal(buildForYouSubtitle(t, { total: 0, shown: 0, allFallback: false, seeds: none, computedAt: null }, NOW), "browse.forYou.subtitle");
});

test("a cold-start shelf says so", () => {
  assert.equal(
    buildForYouSubtitle(t, { total: 5, shown: 5, allFallback: true, seeds: none, computedAt: new Date(NOW - 5 * 60_000) }, NOW),
    'browse.forYou.fallbackPicks{"count":5} · browse.forYou.fallbackHint · browse.forYou.updated.minutes{"count":5}',
  );
});

test("a filtered shelf names both counts and every seed source, joined", () => {
  const out = buildForYouSubtitle(
    t,
    { total: 9, shown: 4, allFallback: false, seeds: { watchHistorySeeds: 2, watchlistSeeds: 1, requestSeeds: 0 }, computedAt: null },
    NOW,
  );
  assert.equal(
    out,
    'browse.forYou.picksOf{"count":4,"total":9} · browse.forYou.builtFrom{"seeds":"browse.forYou.seeds.join{\\"rest\\":\\"browse.forYou.seeds.watched{\\\\\\"count\\\\\\":2}\\",\\"last\\":\\"browse.forYou.seeds.watchlist{\\\\\\"count\\\\\\":1}\\"}"}',
  );
  assert.equal(
    buildForYouSubtitle(t, { total: 3, shown: 3, allFallback: false, seeds: none, computedAt: null }, NOW),
    'browse.forYou.picks{"count":3}',
    "no seeds, no 'built from'; all shown, the plain count",
  );
});
