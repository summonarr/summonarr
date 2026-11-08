// The TRaSH section's ?service= / ?variant= params as the nav reads them
// (src/components/admin/trash-guides/nav-params.ts) — the server pages' rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTrashService, parseTrashVariant, trashNavQuery } from "../src/components/admin/trash-guides/nav-params.ts";

test("only ?service=sonarr is Sonarr, as on the server", () => {
  assert.equal(parseTrashService("sonarr"), "SONARR");
  for (const raw of [null, "", "radarr", "SONARR", "foo"]) assert.equal(parseTrashService(raw), "RADARR", String(raw));
  const shared = readFileSync(new URL("../src/app/(app)/admin/trash-guides/_shared.ts", import.meta.url), "utf8");
  assert.match(shared, /rawService === "sonarr" \? "SONARR" : "RADARR"/, "the server reads it the same way");
});

test("a tab link carries the view as read: never a junk ?service= or an unoffered ?variant=", () => {
  const offered = [{ slug: "" }, { slug: "4k" }];
  assert.equal(trashNavQuery(parseTrashService("SONARR"), parseTrashVariant("bogus", offered)), "");
  assert.equal(trashNavQuery(parseTrashService("sonarr"), parseTrashVariant("4k", offered)), "?service=sonarr&variant=4k");
  assert.equal(trashNavQuery("RADARR", "4k"), "?variant=4k");
  assert.equal(parseTrashVariant(null, offered), "");
  const nav = readFileSync(new URL("../src/components/admin/trash-guides/trash-guides-nav.tsx", import.meta.url), "utf8");
  assert.match(nav, /const tabQuery = trashNavQuery\(currentService, currentVariant\);/);
  assert.doesNotMatch(nav, /rawService/, "the raw param is never copied onto a link");
});
