// The request queue row's rules (src/components/admin/request-action-rules.ts)
// and the admin sync buttons' result line (src/components/admin/sync-summary.ts).
// The components are .tsx the unit loader can't render; these are the pure
// decisions they make.
import { test } from "node:test";
import assert from "node:assert/strict";

const rules = await import("../src/components/admin/request-action-rules.ts");
const { syncRunNote, SyncRunAnswer } = await import("../src/components/admin/sync-summary.ts");
const { check } = await import("../src/lib/validate.ts");
const { createTranslator } = await import("../src/lib/i18n/translate.ts");
const { CATALOGS } = await import("../src/lib/i18n/catalogs.ts");
const t = createTranslator("en", CATALOGS.en, CATALOGS.en);

test("a status the row doesn't know gets no decision controls", () => {
  for (const s of ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"]) assert.equal(rules.parseRequestStatus(s), s);
  for (const s of ["", "approved", "PENDNG", "PROCESSING"]) assert.equal(rules.parseRequestStatus(s), null, s);
});

test("a decision's answer: no push failure keeps the optimistic status, a failed push drops it, an unanswered one keeps it", () => {
  assert.deepEqual(rules.decisionOutcome({}), { arrError: null, keepOptimistic: true });
  assert.deepEqual(rules.decisionOutcome({ arrError: null }), { arrError: null, keepOptimistic: true });
  assert.deepEqual(rules.decisionOutcome({ arrError: "Radarr refused" }), { arrError: "Radarr refused", keepOptimistic: false });
  assert.deepEqual(rules.decisionOutcome({ arrError: "no answer", pushOutcomeUnknown: true }), { arrError: "no answer", keepOptimistic: true });
  assert.deepEqual(rules.decisionOutcome({ arrError: "no answer", pushOutcomeUnknown: false }), { arrError: "no answer", keepOptimistic: false });
});

test("a refusal's arrError is read only when it is a non-empty string", () => {
  assert.equal(rules.arrErrorOf({ arrError: "Nothing missing" }), "Nothing missing");
  for (const body of [null, "x", [], {}, { arrError: "" }, { arrError: 3 }]) assert.equal(rules.arrErrorOf(body), null, JSON.stringify(body));
});

test("the answers the row reads are checked, not cast", () => {
  assert.ok(check(rules.DecisionAnswer, { id: "r1", status: "APPROVED", arrError: null }).ok, "the row's own fields pass and are dropped");
  assert.ok(check(rules.DecisionAnswer, { arrError: "x", arrPushOutcomeUnknown: true }).ok);
  assert.equal(check(rules.DecisionAnswer, { arrError: 5 }).ok, false);
  assert.ok(check(rules.QualityProfilesAnswer, { qualityProfiles: [{ id: 1, name: "HD" }], defaultId: null }).ok);
  assert.equal(check(rules.QualityProfilesAnswer, { qualityProfiles: [{ id: 1 }], defaultId: 1 }).ok, false, "a profile with no name");
  assert.equal(check(rules.QualityProfilesAnswer, { qualityProfiles: null, defaultId: 1 }).ok, false);
});

test("Sync now: a skip, a wind-down, per-server counts never summed, a degraded source named", () => {
  assert.deepEqual(syncRunNote({ skipped: true }, t), { text: t("adminQueue.sync.alreadyRunning"), isError: false });
  assert.deepEqual(syncRunNote({ windDown: true, error: "Stopped early" }, t), { text: "Stopped early", isError: true });
  assert.deepEqual(syncRunNote({ plexMarked: 2, jellyfinMarked: 1 }, t), { text: "Plex 2 · Jellyfin 1", isError: false });
  assert.deepEqual(
    syncRunNote({ plexMarked: 2, failedSources: ["jellyfin", "radarr"], skippedSources: [] }, t),
    { text: `Plex 2 · ${t("adminQueue.sync.sourceFailed", { name: "Jellyfin" })} · ${t("adminQueue.sync.sourceFailed", { name: "Radarr" })}`, isError: true },
  );
  assert.deepEqual(syncRunNote({ plexMarked: 4, skippedSources: ["jellyfin"] }, t), { text: "Plex 4", isError: false }, "an unconfigured server is left out");
  assert.deepEqual(syncRunNote({ skippedSources: ["plex", "jellyfin"] }, t), { text: t("adminQueue.sync.noServers"), isError: false });
  assert.ok(check(SyncRunAnswer, { skipped: true, reason: "sync already running" }).ok, "the skip answer");
});

test("the row shows the route's own reason for a refusal, and each call's busy state is its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/admin/request-actions.tsx", import.meta.url), "utf8");
  // fetchJson's error is the route's `message`, then its `error` (a 422 "not configured", a 409, a 429).
  assert.match(src, /return res\.kind === "http" \|\| res\.kind === "invalid" \? res\.error : t\("shared\.thread\.networkError"\);/);
  assert.equal(src.match(/setArrError\(failureText\(/g)?.length, 2, "a decision and a delete");
  // No shared loading slot: a reply finishing never re-enables a decision still out.
  assert.doesNotMatch(src, /useState<LoadingKind \| null>|setLoading\(null\)/);
  for (const kind of ["NOTE", "DELETE", "SEARCH", "RETRY"]) assert.ok(src.includes(`"${kind}"`), kind);
  assert.match(src, /function begin\(\): boolean \{\s*if \(action\.anyBusy\) return false;\s*setArrError\(null\);\s*setRetryOk\(false\);/, "every call starts from a clean line, one at a time");
  for (const head of ["async function saveReply(", "async function deleteRequest(", "async function updateStatus(", "async function patchRequestAction("]) {
    const at = src.indexOf(head);
    assert.match(src.slice(at, at + 400), /if \(!begin\(\)\) return/, `${head} clears the last failure first`);
  }
});
