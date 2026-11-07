// The Users page's per-user grant editor lists each named Radarr/Sonarr slug
// once (instanceGrants is one flat slug namespace for both services). A slug
// registered on both must read open only when BOTH twins are open: otherwise
// the open twin hides the Request toggle the restricted twin still needs, and
// an admin can't grant that user access to it from the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNamedInstanceAccess } from "../src/lib/permissions.ts";

type Inst = { slug: string; name: string; restricted: boolean; serverAll: boolean };
const open = (i: Inst) => !i.restricted || i.serverAll;

test("a restricted Sonarr twin and an open Radarr twin merge to one CLOSED entry", () => {
  const merged = mergeNamedInstanceAccess<Inst>([
    { slug: "anime", name: "Anime (Sonarr)", restricted: true, serverAll: false },
    { slug: "anime", name: "Anime (Radarr)", restricted: false, serverAll: false },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(open(merged[0]), false);
  assert.equal(merged[0].name, "Anime (Sonarr)", "the first twin's name is kept");
});

test("the order of the twins doesn't matter", () => {
  const merged = mergeNamedInstanceAccess<Inst>([
    { slug: "anime", name: "Anime", restricted: false, serverAll: false },
    { slug: "anime", name: "Anime", restricted: true, serverAll: false },
  ]);
  assert.equal(open(merged[0]), false);
});

test("a restricted twin opened to everyone (serverAll) counts as open", () => {
  const merged = mergeNamedInstanceAccess<Inst>([
    { slug: "kids", name: "Kids", restricted: true, serverAll: true },
    { slug: "kids", name: "Kids", restricted: false, serverAll: false },
  ]);
  assert.equal(open(merged[0]), true);
});

test("two open twins stay open, and distinct slugs keep their own entries in order", () => {
  const merged = mergeNamedInstanceAccess<Inst>([
    { slug: "a", name: "A", restricted: false, serverAll: false },
    { slug: "b", name: "B", restricted: true, serverAll: false },
    { slug: "a", name: "A", restricted: false, serverAll: false },
  ]);
  assert.deepEqual(merged.map((m) => [m.slug, open(m)]), [["a", true], ["b", false]]);
});

test("the input entries are never mutated", () => {
  const first: Inst = { slug: "x", name: "X", restricted: false, serverAll: false };
  mergeNamedInstanceAccess<Inst>([first, { slug: "x", name: "X", restricted: true, serverAll: false }]);
  assert.equal(first.restricted, false);
});
