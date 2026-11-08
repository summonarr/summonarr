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
const ARR_DATA = "src/components/settings/arr-instances-data.ts";
const MEDIA_UI = "src/components/settings/media-instances-manager.tsx";
const MEDIA_DATA = "src/components/settings/media-instances-data.ts";
const ARR_ROUTE = "src/app/api/admin/arr-instances/route.ts";
const MEDIA_ROUTE = "src/app/api/admin/media-instances/route.ts";

test("the sentinel keeps its exact bytes (clients already in the wild send this literal)", () => {
  assert.equal(SECRET_MASK_SENTINEL, "•".repeat(8));
});

test("managers and routes share the one sentinel and declare no private copy", () => {
  for (const path of [ARR_UI, MEDIA_UI, MEDIA_DATA, ARR_ROUTE, MEDIA_ROUTE]) {
    const src = read(path);
    assert.match(src, /import \{ SECRET_MASK_SENTINEL \} from "@\/lib\/secret-mask";/, path);
    assert.ok(!src.includes("•".repeat(8)), `${path} spells the sentinel out itself`);
    assert.doesNotMatch(src, /MASKED_VALUE/, path);
  }
});

test("the managers validate slugs with the server's own rule, not a private regex", () => {
  const arr = read(ARR_DATA);
  const media = read(MEDIA_DATA);
  assert.match(arr, /if \(!isNamed\(d\.slug\) \|\| !isValidInstanceSlug\(d\.slug\)\) return \{ kind: "invalid", slug: d\.slug \};/);
  assert.match(read(ARR_UI), /const problem = draftsProblem\(drafts\);/);
  assert.match(media, /if \(!isNamed\(d\.slug\) \|\| !isValidMediaInstanceSlug\(d\.slug\)\) return \{ kind: "invalid", slug: d\.slug \};/);
  assert.match(read(MEDIA_UI), /const problem = draftsProblem\(drafts\);/);
  for (const src of [arr, media]) assert.doesNotMatch(src, /\/\^\[a-z\]\[a-z0-9\]/, "no local copy of the slug regex");
  assert.match(read(MEDIA_ROUTE), /const INSTANCE_NAME_MAX_LEN = MEDIA_INSTANCE_NAME_MAX_LEN;/, "the route's name cap is the registry's");
});

for (const [label, path] of [["arr", ARR_UI], ["media", MEDIA_UI]] as const) {
  test(`${label} manager: the editors, Add and Refresh are disabled while a save is in flight, and edits can't clear "saving"`, () => {
    const src = read(path);
    assert.match(src, /const saving = status === "saving";/);
    // The media manager also locks while a reload is in flight (its answer
    // replaces every draft too): `locked` is saving or refreshing.
    const lock = label === "media" ? "locked" : "saving";
    if (label === "media") assert.match(src, /const locked = saving \|\| refreshing;/);
    assert.match(src, new RegExp(`<fieldset disabled=\\{${lock}\\} className="min-w-0 space-y-4">\\s*\\{drafts\\.map\\(`), "the draft cards sit in a disabled fieldset");
    assert.match(src, new RegExp(`onClick=\\{addInstance\\} disabled=\\{${lock}( \\|\\| loadFailed)?\\}`));
    assert.match(src, new RegExp(`onClick=\\{\\(\\) => \\(dirty \\? setConfirmRefresh\\(true\\) : load\\(\\)\\)\\} disabled=\\{${lock}\\}`));
    assert.match(src, /const clearStatus = \(\) => setStatus\(\(s\) => \(s === "saving" \? s : "idle"\)\);/);
    const editors = src.slice(src.indexOf("const update = "), src.indexOf("async function save()"));
    assert.ok(editors.length > 0);
    assert.ok(!editors.includes('setStatus("idle")'), "update/add/remove go through clearStatus");
  });

  test(`${label} manager: the loaded version is sent back as baseVersion and replaced by the save's`, () => {
    const src = read(path);
    assert.match(src, /init: jsonInit\("POST", \{ service, instances, \.\.\.\(version !== undefined \? \{ baseVersion: version \} : \{\}\) \}\),/);
    assert.match(src, /readInstancesGet\(res\.data, service\)/, "taken from GET's versions");
    if (label === "arr") {
      // Both answers are read by one helper; applyList stores its version.
      assert.match(src, /setVersion\(list\.version\);/);
      assert.match(src, /readSaveAnswer\(body\)/, "and from the POST's answer");
      return;
    }
    assert.match(src, /setVersion\(list\.version\);/);
    assert.match(src, /readSaveAnswer\(res\.data\)/, "and from the POST's answer");
    assert.match(src, /setVersion\(answer\.version\);/);
  });
}

test("arr manager: an answer's list is shape-checked whole, and the version rides along", async () => {
  const { readInstancesGet, readSaveAnswer, instancesPayload, draftsProblem, newDraft, toDraft } = await import("../src/components/settings/arr-instances-data.ts");
  const view = {
    slug: "anime", name: "Anime", restricted: false, serverAll: false, skipLibraryCheck: false, autoRoute: { animeOnly: true },
    url: "http://r:7878", rootFolder: "/m", qualityProfileId: "4", minimumAvailability: "", languageProfileId: "",
    hasApiKey: true, hasWebhookSecret: false,
  };
  const got = readInstancesGet({ radarr: [view, { ...view, slug: "" }], versions: { radarr: "v1" } }, "radarr");
  assert.deepEqual(got?.named.map((i) => i.slug), ["anime"], "the default instance is not managed here");
  assert.equal(got?.version, "v1");
  assert.equal(readInstancesGet({ radarr: [view], versions: { radarr: 3 } }, "radarr")?.version, undefined);
  // One malformed entry refuses the whole list: saving a filtered list would delete what was dropped.
  assert.equal(readInstancesGet({ radarr: [view, { slug: "x" }] }, "radarr"), null);
  assert.equal(readInstancesGet({ radarr: "nope" }, "radarr"), null);
  assert.deepEqual(readInstancesGet({}, "sonarr")?.named, [], "an absent list is an empty one");
  const saved = readSaveAnswer({ ok: true, instances: [view], version: "v2", testResults: { anime: { version: "5.1" } }, removed: [{ slug: "old", openRequests: 2 }, { slug: "gone", openRequests: 0 }] });
  assert.equal(saved?.version, "v2");
  assert.deepEqual(saved?.testResults, { anime: { version: "5.1" } });
  assert.deepEqual(saved?.stranded, [{ slug: "old", openRequests: 2 }]);
  const draft = toDraft(view);
  const [payload] = instancesPayload([draft], "radarr");
  assert.equal(payload.apiKey, SECRET_MASK_SENTINEL, "a blank key over a saved one keeps it");
  assert.equal("id" in payload, false, "the draft id is client-only");
  assert.equal("languageProfileId" in payload, false, "radarr sends no language profile");
  assert.deepEqual(payload.autoRoute, { animeOnly: true });
  assert.deepEqual(draftsProblem([draft, { ...draft, id: draft.id + 1 }]), { kind: "duplicate", slug: "anime" });
  assert.deepEqual(draftsProblem([newDraft("s")]), { kind: "invalid", slug: "" });
  assert.equal(draftsProblem([draft]), null);
});

test("media manager: a reload clears the last save's connection badges", () => {
  const src = read(MEDIA_UI);
  const start = src.indexOf("const load = useCallback(");
  const load = src.slice(start, src.indexOf("useEffect(() => {", start));
  assert.ok(load.length > 0);
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
  assert.match(src, /<InstanceCard\s+key=\{d\.id\}/);
  assert.doesNotMatch(src, /key=\{idx\}/);
  // The tick lives in the card, which the draft id keys; it resets on its own timer.
  const card = src.slice(src.indexOf("function InstanceCard("));
  assert.match(card, /const \{ copied, copy \} = useCopyFeedback\(\);/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => setCopied/);
  assert.match(src, /confirmingRemove=\{confirmRemove === d\.id\}/);
  assert.match(src, /onRemove=\{\(\) => removeInstance\(d\.id\)\}/);
  assert.doesNotMatch(src, /\b(update|removeInstance|copyHook)\(idx\b/);
  // The id is client-only: the POST body maps named fields, never the draft.
  const data = read(ARR_DATA);
  const body = data.slice(data.indexOf("export function instancesPayload("));
  assert.doesNotMatch(body, /\bid:/);
});

test("arr manager: the options are narrowed once, with no casts or non-null assertions", () => {
  const src = read(ARR_UI);
  assert.match(src, /const ready: ArrOptions \| null = opts && typeof opts === "object" \? opts : null;/);
  assert.doesNotMatch(src, /\(opts as ArrOptions\)/);
  assert.doesNotMatch(src, /languageProfiles!/);
});
