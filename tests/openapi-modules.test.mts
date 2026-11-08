// The OpenAPI document is assembled from one module per area
// (src/lib/openapi/paths/*). A path must live in exactly one module — merging
// them would let a later module silently replace an earlier one's operations —
// and the route serves the JSON built once at load, byte for byte.

import { specResponse, getSpec } from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const { PATH_MODULES, SPEC_JSON, spec } = await import("../src/lib/openapi/spec.ts");

test("every path is documented by exactly one area module, and the document carries them all", () => {
  const seen = new Map<string, number>();
  PATH_MODULES.forEach((paths, i) => {
    for (const path of Object.keys(paths)) {
      assert.equal(seen.get(path), undefined, `${path} is in modules ${seen.get(path)} and ${i}`);
      seen.set(path, i);
    }
  });
  assert.deepEqual(Object.keys(spec.paths).sort(), [...seen.keys()].sort());
  // Every module file under paths/ is assembled — a new area can't be left out.
  const files = readdirSync(new URL("../src/lib/openapi/paths/", import.meta.url)).filter((f) => f.endsWith(".ts"));
  assert.equal(PATH_MODULES.length, files.length, `paths/ holds ${files.length} modules, the document assembles ${PATH_MODULES.length}`);
  assert.ok(seen.size >= 190, `only ${seen.size} paths`);
});

test("GET /api/openapi serves the JSON built at load, uncached, as application/json", async () => {
  const res = await specResponse();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), SPEC_JSON);
  assert.equal(SPEC_JSON, JSON.stringify(spec));
  assert.deepEqual(await getSpec(), JSON.parse(SPEC_JSON));
});
