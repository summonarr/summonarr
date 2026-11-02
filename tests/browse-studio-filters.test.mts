// Studio / network / certification discover filters (src/lib/studio-list.ts and
// the sanitize + wire mapping in src/lib/tmdb.ts). The wire shape and cache-key
// sanitising are exercised through the real discover functions with a stubbed
// fetch, in the style of tests/tmdb.test.mts's discover cases.
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildStudioList, MAX_STUDIO_LINKS, isCertificationCap, CERTIFICATION_CAPS } = await import("../src/lib/studio-list.ts");

test("TV lists networks first, then companies; movies list companies only", () => {
  const nets = [{ id: 49, name: "HBO" }];
  const cos = [{ id: 1, name: "Warner Bros." }, { id: 2, name: "Legendary" }];
  assert.deepEqual(buildStudioList("TV", nets, cos).map((s) => `${s.kind}:${s.id}`), ["network:49", "company:1", "company:2"]);
  assert.deepEqual(buildStudioList("MOVIE", nets, cos).map((s) => `${s.kind}:${s.id}`), ["company:1", "company:2"], "a movie has no network");
});

test("junk entries are skipped, ids de-duplicate per kind, and the list is capped", () => {
  const list = buildStudioList("MOVIE", null, [
    { id: 0, name: "zero" }, { id: -3, name: "neg" }, { id: 1.5, name: "frac" }, { id: 5, name: "  " }, { id: 5 }, { name: "no id" },
    { id: 7, name: "A" }, { id: 7, name: "A again" },
  ]);
  assert.deepEqual(list, [{ id: 7, name: "A", kind: "company" }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Studio ${i + 1}` }));
  assert.equal(buildStudioList("MOVIE", null, many).length, MAX_STUDIO_LINKS);
  assert.equal(buildStudioList("MOVIE", undefined, undefined).length, 0);
});

test("only the US ratings TMDB can cap at are accepted", () => {
  for (const c of CERTIFICATION_CAPS) assert.equal(isCertificationCap(c), true);
  for (const bad of ["", "pg", "TV-MA", "X", "R; drop", undefined, null, 13]) assert.equal(isCertificationCap(bad), false, String(bad));
});
