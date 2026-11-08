// How a library path is made comparable with a Radarr/Sonarr folder
// (src/lib/fix-match-shared.ts normaliseLibraryPath / pathWithin). No DB, no network.
import test from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);

const { normaliseLibraryPath, pathWithin } = await import("../src/lib/fix-match-shared.ts");

test("every trailing separator is dropped, so a folder written with extra slashes still matches", () => {
  assert.equal(normaliseLibraryPath("/movies//"), "/movies");
  assert.equal(normaliseLibraryPath("C:\\Movies\\\\"), "C:/Movies");
  assert.equal(normaliseLibraryPath("/movies/Dune (2021)/"), "/movies/Dune (2021)");
  assert.ok(pathWithin("/movies//", "/movies"));
  assert.ok(pathWithin("/movies//", normaliseLibraryPath("/movies/Dune (2021)/Dune.mkv")));
});

test("a blank, dot or root-only path is no path at all", () => {
  for (const raw of [null, undefined, "", "   ", ".", "/", "//", "\\"]) assert.equal(normaliseLibraryPath(raw), "", String(raw));
  assert.equal(pathWithin("/", "/movies"), false);
});

