// The Radarr/Sonarr and Plex/Jellyfin instance managers (client components the
// unit loader can't render) and their save routes, pinned by a structural scan.
//
// - One sentinel and one slug rule. The managers send SECRET_MASK_SENTINEL for a
//   secret they never showed, and the routes skip exactly that value; a private
//   copy on either side that drifts would store the bullets as the real key.
//   The slug check is the server's own validator, so the client can't accept a
//   slug the route refuses (or the reverse).
// - A save in flight locks the editors. Its response replaces every draft, so
//   anything typed meanwhile was silently discarded (and an edit flipped
//   "saving" back to "idle", re-enabling Save for a second concurrent POST).
// - The list's version goes back as `baseVersion`, so the server can refuse a
//   save over a list changed elsewhere (the route side is pinned in
//   admin-arr-instances-routes / media-instances-route).
// - Arr manager: option fetches for a slug are sequenced (only the latest
//   answer lands), and the cards, "copied" check and pending Remove follow a
//   draft id rather than a position.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECRET_MASK_SENTINEL } from "../src/lib/secret-mask.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ARR_UI = "src/components/settings/arr-instances-manager.tsx";
const MEDIA_UI = "src/components/settings/media-instances-manager.tsx";
const ARR_ROUTE = "src/app/api/admin/arr-instances/route.ts";
const MEDIA_ROUTE = "src/app/api/admin/media-instances/route.ts";

test("the sentinel keeps its exact bytes (clients already in the wild send this literal)", () => {
  assert.equal(SECRET_MASK_SENTINEL, "•".repeat(8));
});

test("managers and routes share the one sentinel and declare no private copy", () => {
  for (const path of [ARR_UI, MEDIA_UI, ARR_ROUTE, MEDIA_ROUTE]) {
    const src = read(path);
    assert.match(src, /import \{ SECRET_MASK_SENTINEL \} from "@\/lib\/secret-mask";/, path);
    assert.ok(!src.includes("•".repeat(8)), `${path} spells the sentinel out itself`);
    assert.doesNotMatch(src, /MASKED_VALUE/, path);
  }
});

test("the managers validate slugs with the server's own rule, not a private regex", () => {
  const arr = read(ARR_UI);
  const media = read(MEDIA_UI);
  assert.match(arr, /if \(!isNamed\(d\.slug\) \|\| !isValidInstanceSlug\(d\.slug\)\) \{/);
  assert.match(media, /if \(!isNamed\(d\.slug\) \|\| !isValidMediaInstanceSlug\(d\.slug\)\) \{/);
  for (const src of [arr, media]) assert.doesNotMatch(src, /\/\^\[a-z\]\[a-z0-9\]/, "no local copy of the slug regex");
  assert.match(read(MEDIA_ROUTE), /const INSTANCE_NAME_MAX_LEN = MEDIA_INSTANCE_NAME_MAX_LEN;/, "the route's name cap is the registry's");
});

for (const [label, path] of [["arr", ARR_UI], ["media", MEDIA_UI]] as const) {
  test(`${label} manager: the editors, Add and Refresh are disabled while a save is in flight, and edits can't clear "saving"`, () => {
    const src = read(path);
    assert.match(src, /const saving = status === "saving";/);
    assert.match(src, /<fieldset disabled=\{saving\} className="min-w-0 space-y-4">\s*\{drafts\.map\(/, "the draft cards sit in a disabled fieldset");
    assert.match(src, /onClick=\{addInstance\} disabled=\{saving\}/);
    assert.match(src, /onClick=\{\(\) => \(dirty \? setConfirmRefresh\(true\) : load\(\)\)\} disabled=\{saving\}/);
    assert.match(src, /const clearStatus = \(\) => setStatus\(\(s\) => \(s === "saving" \? s : "idle"\)\);/);
    const editors = src.slice(src.indexOf("const update = "), src.indexOf("async function save()"));
    assert.ok(editors.length > 0);
    assert.ok(!editors.includes('setStatus("idle")'), "update/add/remove go through clearStatus");
  });

  test(`${label} manager: the loaded version is sent back as baseVersion and replaced by the save's`, () => {
    const src = read(path);
    assert.match(src, /setVersion\(typeof v === "string" \? v : undefined\);/, "taken from GET's versions");
    assert.match(src, /body: JSON\.stringify\(\{ service, instances, \.\.\.\(version !== undefined \? \{ baseVersion: version \} : \{\}\) \}\),/);
    assert.match(src, /setVersion\(typeof data\.version === "string" \? data\.version : undefined\);/, "and from the POST's answer");
  });
}

test("media manager: a reload clears the last save's connection badges", () => {
  const src = read(MEDIA_UI);
  const load = src.slice(src.indexOf("const load = useCallback("), src.indexOf("useEffect(() => {"));
  assert.match(load, /setTests\(\{\}\);/);
  assert.match(load, /setStatus\("idle"\);/);
});

test("arr manager: only the latest option fetch for a slug may write its options", () => {
  const src = read(ARR_UI);
  const fetchOptions = src.slice(src.indexOf("const fetchOptions = useCallback("), src.indexOf("const load = useCallback("));
  assert.match(fetchOptions, /optionsSeq\.current\[slug\] = seq;/);
  assert.match(fetchOptions, /if \(latest\(\)\) setOptionsBySlug\(\(prev\) => \(\{ \.\.\.prev, \[slug\]: data \}\)\);/);
  assert.match(fetchOptions, /if \(latest\(\)\) setOptionsBySlug\(\(prev\) => \(\{ \.\.\.prev, \[slug\]: "error" \}\)\);/);
  assert.equal((fetchOptions.match(/setOptionsBySlug\(/g) ?? []).length, 3, "loading + the two guarded writes, nothing else");
});

test("arr manager: cards, the copied check and the pending Remove follow the draft id, not its position", () => {
  const src = read(ARR_UI);
  assert.match(src, /<div key=\{d\.id\} className="rounded-lg/);
  assert.doesNotMatch(src, /key=\{idx\}/);
  assert.match(src, /copiedHook === d\.id/);
  assert.match(src, /confirmRemove === d\.id/);
  assert.match(src, /onClick=\{\(\) => removeInstance\(d\.id\)\}/);
  assert.doesNotMatch(src, /\b(update|removeInstance|copyHook)\(idx\b/);
  // The id is client-only: the POST body maps named fields, never the draft.
  const body = src.slice(src.indexOf("const instances = drafts.map((d) => ({"), src.indexOf("try {", src.indexOf("const instances = drafts.map")));
  assert.doesNotMatch(body, /\bid:/);
});

test("arr manager: the options are narrowed once, with no casts or non-null assertions", () => {
  const src = read(ARR_UI);
  assert.match(src, /const ready: ArrOptions \| null = opts && typeof opts === "object" \? opts : null;/);
  assert.doesNotMatch(src, /\(opts as ArrOptions\)/);
  assert.doesNotMatch(src, /languageProfiles!/);
});
