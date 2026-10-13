// Pins two row layouts that lost their TITLE at a 1024px viewport, found in a
// browser pass over the production build (2026-10-13). Both rows put a wide
// action bar beside a flexible title column; the title must never be left to
// whatever the actions don't use.
//
// - Request queue (admin-request-list.tsx): an APPROVED row's bar (Why? · Search
//   · Pick release · Re-push · Delete, ~490px) sat beside the title from `sm`
//   up, leaving the title 36px wide. The actions now take their own row below xl.
// - Admin issues (admin/issues/page.tsx): the title Link was `flex-1` (a 0
//   basis), so the flex-wrap row wrapped only once the actions ALONE overflowed
//   it; a ~490px bar left the title ~100px. It now grows from a real basis.
//
// Structural pins (the unit loader can't import .tsx); each was mutation-checked
// by reverting the class list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("request queue: the row only stops wrapping at xl, and the actions take their own row below it", () => {
  const src = read("src/components/admin/admin-request-list.tsx");
  assert.match(src, /className="flex flex-wrap xl:flex-nowrap items-start"/);
  assert.match(src, /className="flex justify-end basis-full xl:basis-auto xl:shrink-0"/);
  assert.doesNotMatch(src, /sm:flex-nowrap items-start/, "the sm breakpoint crushed the title next to the APPROVED action bar");
  assert.doesNotMatch(src, /basis-full sm:basis-auto sm:shrink-0/);
});

test("admin issues: the title grows from a real basis, so a wide action bar wraps instead of crushing it", () => {
  const src = read("src/app/(app)/admin/issues/page.tsx");
  assert.match(src, /className="grow basis-40 min-w-0 block rounded transition-colors"/);
  assert.doesNotMatch(src, /className="flex-1 min-w-0 block rounded transition-colors"/, "a 0 basis wraps only once the actions alone overflow the row");
});
