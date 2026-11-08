// The named Plex/Jellyfin server manager's data (src/components/settings/media-instances-data.ts)
// and how the manager uses it: answers are shape-checked whole, a pasted token
// is trimmed, the client-only draft id never reaches the wire, and the cards and
// pending Remove follow that id rather than a position.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECRET_MASK_SENTINEL } from "../src/lib/secret-mask.ts";
import {
  draftsProblem,
  instancesPayload,
  newDraft,
  readInstancesGet,
  readSaveAnswer,
  toDraft,
} from "../src/components/settings/media-instances-data.ts";

const plexView = {
  slug: "remote", name: "Remote", restricted: false, serverUrl: "http://p:32400", adminEmail: "a@b.c",
  hasAdminToken: true, libraries: "1,2", moviePathStripPrefix: "", tvPathStripPrefix: "",
};

test("a GET's list is shape-checked whole, the default server left out, the version kept", () => {
  const got = readInstancesGet({ plex: [plexView, { ...plexView, slug: "" }], jellyfin: [], versions: { plex: "v1" } }, "plex");
  assert.deepEqual(got?.named.map((i) => i.slug), ["remote"]);
  assert.equal(got?.version, "v1");
  // One malformed entry refuses the whole list: saving a filtered list would delete what was dropped.
  assert.equal(readInstancesGet({ plex: [plexView, { slug: 3 }] }, "plex"), null);
  assert.equal(readInstancesGet({ plex: "nope" }, "plex"), null);
  assert.equal(readInstancesGet(null, "plex"), null);
  assert.deepEqual(readInstancesGet({}, "jellyfin")?.named, [], "an absent list is an empty one");
});

test("a POST's answer counts only with ok: true and a well-formed list", () => {
  const saved = readSaveAnswer({ ok: true, instances: [plexView], testResults: { remote: { ok: true } }, version: "v2" });
  assert.equal(saved?.version, "v2");
  assert.deepEqual(saved?.testResults, { remote: { ok: true } });
  assert.equal(readSaveAnswer({ instances: [plexView] }), null, "a 2xx without ok: true is not a save");
  assert.equal(readSaveAnswer({ ok: true, instances: [{ slug: "x" }] }), null);
  assert.deepEqual(readSaveAnswer({ ok: true, instances: [], testResults: "x" })?.testResults, {});
});

// The payload's per-service fields, read as plain records.
const payloadOf = (...args: Parameters<typeof instancesPayload>) => instancesPayload(...args) as Record<string, unknown>[];

test("a pasted token is sent trimmed; blank over a saved one keeps it; the draft id stays client-side", () => {
  const draft = { ...toDraft(plexView, "plex"), token: "  abc123\n" };
  const [payload] = payloadOf([draft], "plex");
  assert.equal(payload.adminToken, "abc123");
  assert.equal("id" in payload, false);
  const [kept] = payloadOf([{ ...draft, token: "   " }], "plex");
  assert.equal(kept.adminToken, SECRET_MASK_SENTINEL, "whitespace alone is no new token");
  const jelly = toDraft({ slug: "jf", name: "JF", url: "http://j:8096", hasApiKey: false }, "jellyfin");
  const [j] = payloadOf([{ ...jelly, token: " key " }], "jellyfin");
  assert.equal(j.apiKey, "key");
  assert.equal(j.restrictSignIn, true, "an absent policy fails closed");
  assert.equal(payloadOf([jelly], "jellyfin")[0].apiKey, undefined);
});

test("drafts get distinct ids; slugs are checked with the server's rule", () => {
  const a = newDraft();
  const b = newDraft();
  assert.notEqual(a.id, b.id);
  assert.deepEqual(draftsProblem([a]), { kind: "invalid", slug: "" });
  const r = toDraft(plexView, "plex");
  assert.deepEqual(draftsProblem([r, { ...r, id: r.id + 1000 }]), { kind: "duplicate", slug: "remote" });
  assert.equal(draftsProblem([r]), null);
});

test("a NEW server whose slug derives a main-server setting key is refused; a saved one is kept", () => {
  const fresh = { ...newDraft(), slug: "movie" };
  assert.deepEqual(draftsProblem([fresh]), { kind: "reserved", slug: "movie" });
  assert.equal(draftsProblem([{ ...fresh, slug: "remote" }]), null);
  const saved = { ...toDraft(plexView, "plex"), slug: "movie" };
  assert.equal(saved.isNew, false);
  assert.equal(draftsProblem([saved]), null, "an already-registered slug stays editable");
});

test("the manager keys its cards and pending Remove by the draft id, and locks while a reload runs", () => {
  const src = readFileSync(new URL("../src/components/settings/media-instances-manager.tsx", import.meta.url), "utf8");
  assert.match(src, /<InstanceCard\s+key=\{d\.id\}/);
  assert.doesNotMatch(src, /key=\{idx\}/);
  assert.match(src, /confirmingRemove=\{confirmRemove === d\.id\}/);
  assert.match(src, /onRemove=\{\(\) => removeInstance\(d\.id\)\}/);
  assert.match(src, /const refreshing = action\.busy\("load"\);/);
  // A failed load shows no "none configured" line and offers no Add.
  assert.match(src, /\{drafts\.length === 0 && !loadFailed && /);
  // The save and load outcomes are live regions.
  assert.match(src, /\{status === "ok" && <p role="status"/);
  assert.match(src, /\{status === "error" && <p role="alert"/);
});
