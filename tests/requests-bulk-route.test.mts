// Structural pins for POST /api/requests/bulk (src/app/api/requests/bulk/route.ts
// and its item pipeline, src/lib/request-bulk.ts).
//
// The route has no in-memory harness yet (it fans out over user, Setting,
// mediaRequest, both library tables, both *arr-available tables, the blacklist,
// TMDB meta and a Serializable tx), so these pins read the SOURCE and hold the
// shape of three decisions the single create path already makes:
//
//   1. A MIRRORED ROW IS NEVER CREATED AVAILABLE. An item only reaches the create
//      tx after the already-available gate found it absent from the target's
//      visible libraries AND the routed instance's *arr-available cache, which is
//      exactly the case request-create.ts refuses to copy AVAILABLE for
//      (guardrail 35: the peer may be AVAILABLE off a restricted server this
//      target holds no grant for). The mirror is therefore APPROVED, with no
//      availableAt stamp, and phase 3 reports it "auto-approved" — the only
//      "already-available" verdict is the pre-create gate's.
//   2. A PRESENT, non-string onBehalfOfUserId is a 400, never "no target".
//   3. The per-call limit reads the admin's rateLimitRequests Setting, and a
//      zero-row batch answers 200 (201 only when something was created).
//   4. A peer stamped `cleanedUpAt` (a deliberate removal, guardrail 14b) is
//      never mirrored — here, in request-create.ts and on the Discord path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
// The route (HTTP half) then its item pipeline (src/lib/request-bulk.ts), in
// run order, so the order pins below read across both.
const SRC = readFileSync(join(ROOT, "src/app/api/requests/bulk/route.ts"), "utf8") +
  "\n" + readFileSync(join(ROOT, "src/lib/request-bulk.ts"), "utf8");
// Code only: comments explain the rules and would otherwise satisfy the scans.
const CODE = SRC.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

test("bulk: the create tx never writes availableAt — a mirrored peer is APPROVED, not AVAILABLE", () => {
  assert.doesNotMatch(CODE, /availableAt\s*:/, "no row is created AVAILABLE, so none carries availableAt");
  // The status literal is a peer-blind binary: greenlit OR auto-approve → APPROVED.
  assert.match(CODE, /const status = mirror \|\| p\.autoApprove \? "APPROVED" : "PENDING"/);
  // "AVAILABLE" survives only inside the greenlit lookup predicate; copying a
  // peer's status (`g.status as "APPROVED" | "AVAILABLE"`, `mirror === "AVAILABLE"`)
  // would add occurrences.
  const availableLiterals = CODE.match(/"AVAILABLE"/g) ?? [];
  assert.equal(availableLiterals.length, 1, `expected the lone in-predicate literal, got ${availableLiterals.length}`);
  assert.match(CODE, /status: \{ in: \["APPROVED", "AVAILABLE"\] \}/);
});

test("bulk: a peer stamped cleanedUpAt is a removal, never a greenlight to mirror (guardrail 14b)", () => {
  // Without the term, "Request all" on a collection copies a deliberately
  // removed title's stamped AVAILABLE row as APPROVED, and the sync re-pushes it.
  assert.match(CODE, /const greenlit = await tx\.mediaRequest\.findMany\(\{\s*where: \{ status: \{ in: \["APPROVED", "AVAILABLE"\] \}, cleanedUpAt: null, OR: createPairs \}/);
});

test("every 'already greenlit' mirror lookup in src/ excludes stamped (cleanedUpAt) rows", () => {
  // request-create.ts (web, watchlist auto-request and the Discord /request
  // pick) and bulk each copy a greenlit peer's status. One copy without the
  // term re-opens the re-download path for a removed title.
  const files = ["src/lib/request-create.ts", "src/lib/request-bulk.ts"];
  for (const f of files) {
    const code = readFileSync(join(ROOT, f), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const lookups = code.split("\n").filter((l) =>
      l.includes('status: { in: ["APPROVED", "AVAILABLE"] }') || l.includes("status: { in: greenlitPeerStatuses("));
    assert.ok(lookups.length >= 1, `${f}: the mirror lookup moved — update this pin`);
    for (const l of lookups) assert.match(l, /cleanedUpAt: null/, `${f}: ${l.trim()}`);
  }
});

test("bulk: 'already-available' is produced ONLY by the pre-create gate; a mirrored row reads 'auto-approved'", () => {
  const verdicts = CODE.match(/return "already-available"/g) ?? [];
  assert.equal(verdicts.length, 1, "one already-available verdict: the gate before the create tx");
  assert.doesNotMatch(CODE, /result: "already-available"/, "no outcome is built as already-available after the gate");
  assert.match(CODE, /if \(mirroredKeys\.has\(key\)\) \{\s*outcomeByKey\.set\(key, \{ tmdbId: p\.tmdbId, mediaType: p\.mediaType, result: "auto-approved" \}\);/);
});

test("bulk: a present non-string onBehalfOfUserId is refused with 400 before any target is resolved", () => {
  const guard = CODE.indexOf('typeof onBehalfOfUserId !== "string") {');
  const resolve_ = CODE.indexOf("const onBehalfId =");
  assert.ok(guard > 0 && resolve_ > guard, "the type guard precedes the target resolution");
  assert.match(CODE, /onBehalfIdInvalid"\) \}, \{ status: 400 \}/);
});

test("bulk: the per-call limit honours rateLimitRequests and a zero-row batch is 200", () => {
  assert.match(CODE, /key: "rateLimitRequests"/);
  assert.match(CODE, /parseRateLimit\(rlRow\?\.value, 10\)/);
  assert.match(CODE, /checkRateLimit\(`bulk:\$\{session\.user\.id\}`, bulkLimit, 60_000\)/);
  assert.match(CODE, /\{ status: createdCount > 0 \? 201 : 200 \}/);
});

test("bulk: an INT4-overflowing tmdbId is a 400 before any keyed read (no per-item _token to bound it)", () => {
  const range = CODE.indexOf("isTmdbIdInRange(tmdbId)");
  const firstKeyedRead = CODE.indexOf("prisma.mediaRequest.findMany");
  assert.ok(range > 0 && firstKeyedRead > range, "the range check precedes the first tmdbId-keyed query");
  assert.match(CODE, /tmdbIdOutOfRange"\) \}, \{ status: 400 \}/);
});

test("bulk: the *arr-available cache short-circuits only for an auto-approver, like request-create.ts and Discord", () => {
  // Bulk used to answer "already-available" from the arr cache for EVERY
  // requester, so a non-auto-approver could not file (or be notified for) a
  // title the single route and Discord both let them request.
  assert.match(CODE, /const arrCounts = arrAvailSet\.has\(k\) && canAutoApproveInstance\(targetPerms, inst, grants, it\.mediaType\)/);
  assert.doesNotMatch(CODE, /\|\| arrAvailSet\.has\(k\)\)/, "a bare arrAvailSet verdict is the old ungated shape");
});

test("bulk: an on-behalf create also clears the filer's deletion vote, not only the target's", () => {
  assert.match(
    CODE,
    /userId: \{ in: isOnBehalf \? \[targetUserId, session\.user\.id\] : \[targetUserId\] \}/,
  );
});

test("bulk: an on-behalf non-ADMIN filer must hold the named-instance request/auto-approve grants and sees only servers they can view", () => {
  assert.match(CODE, /const filerChecked = isOnBehalf && !hasPermission\(session\.user\.permissions, Permission\.ADMIN\)/);
  // Every instance gate the target passes also runs the filer's own check.
  assert.equal((CODE.match(/filerMay\(/g) ?? []).length >= 4, true, "request gate, remap, and both auto-approve sites");
  assert.match(CODE, /canAutoApproveInstance\(session\.user\.permissions, inst, filerGrants/);
  assert.match(CODE, /targetVisible\.plex\.filter\(\(x\) => filerVisible\.plex\.includes\(x\)\)/);
});

test("bulk: an AVAILABLE peer is a greenlight only with the routed instance's *arr-available row (greenlitPeerStatuses)", () => {
  // AVAILABLE is not an approval: the library pass flips a PENDING request
  // AVAILABLE off a restricted server or the HD copy of a 4K request. Mirrored as
  // APPROVED without the *arr holding it, the sync's re-push downloads it with no
  // admin decision. The lookup still reads both statuses (the *arr answer differs
  // per item); the filter decides per key.
  assert.match(CODE, /import \{ greenlitPeerStatuses \} from "@\/lib\/request-mirror"/);
  assert.match(
    CODE,
    /for \(const g of greenlit\) \{\s*const k = keyOf\(g\.tmdbId, g\.mediaType\);\s*if \(\(greenlitPeerStatuses\(arrAvailSet\.has\(k\)\) as string\[\]\)\.includes\(g\.status\)\) greenlitKeys\.add\(k\);\s*\}/,
  );
  assert.doesNotMatch(CODE, /for \(const g of greenlit\) greenlitKeys\.add/, "an unfiltered add is the old mirror-any-peer shape");
});

test("bulk: a re-requested DECLINED row's comment thread moves to the row created for the same key", () => {
  // The stale rows are deleted to free the unique key and RequestComment cascades
  // with them; without the carry the decline conversation is lost. The drop goes
  // through the shared helper (read the threads, then ONE CAS deleteMany), BEFORE
  // the insert, and only a row THIS call created takes a thread.
  assert.match(CODE, /import \{ dropStaleDeclinedMany, restoreThread \} from "@\/lib\/request-comment-carry"/);
  assert.doesNotMatch(CODE, /tx\.mediaRequest\.deleteMany\(/, "a bare stale-row delete cascades the threads");
  const drop = CODE.indexOf("const carriedThreads = await dropStaleDeclinedMany(tx, staleDeclinedIds);");
  const insert = CODE.indexOf("await tx.mediaRequest.createMany(");
  assert.ok(drop > 0 && insert > drop, "threads are dropped (and read) before the insert");
  assert.match(
    CODE,
    /const created = after\.filter\(\(r\) => !beforeIds\.has\(r\.id\)\);\s*for \(const r of created\) \{\s*const staleId = staleDeclinedIdByKey\.get\(keyOf\(r\.tmdbId, r\.mediaType\)\);\s*if \(staleId\) await restoreThread\(tx, r\.id, carriedThreads\.get\(staleId\)\);\s*\}\s*return \{ created, mirroredKeys \};/,
  );
});

test("bulk: an auto-approval whose push failed is marked pushFailed and goes to ONE admin alert after the loop, never one per row", () => {
  // The row rolls back to PENDING with its backstop cleared, so without an alert
  // it sits in the queue unnoticed; one per row would flood every admin channel
  // on a 50-item "Request all" (the header's rule). The result stays "created".
  // Only a rollback that LANDED counts: the shared state machine reports a
  // failure whose row moved on as "failed", which is not PENDING.
  assert.match(CODE, /if \(outcome\.kind === "rolled-back"\) awaitingReview\.set\(row\.key, row\.id\);/);
  assert.match(CODE, /result: "created" \}\);\s*awaitingReview\.set\(key, row\.id\);/, "a row created PENDING is announced too");
  assert.match(CODE, /outcome\.kind === "rolled-back"\s*\? \{ tmdbId: row\.tmdbId, mediaType: [^}]*result: "created", pushFailed: true \}/);
  const alerts = CODE.match(/alertAdminsNewRequest\(/g) ?? [];
  assert.equal(alerts.length, 1, "one alert call site");
  const loopEnd = CODE.indexOf('scheduleDownloadChecks(downloadChecksFor(settled), { name: "requests/bulk:90s-download-check" });');
  const alert = CODE.indexOf("alertAdminsNewRequest(");
  assert.ok(loopEnd > 0 && alert > loopEnd, "the alert runs once, after the push loop");
  // The first awaiting row admins have NOT already heard about: a title someone
  // else already has pending was announced when theirs was filed.
  assert.match(CODE, /const firstAwaiting = await firstUnannounced\(prepared\.filter\(\(p\) => awaitingReview\.has\(keyOf\(p\.tmdbId, p\.mediaType\)\)\), awaitingReview\);\s*if \(firstAwaiting\) \{\s*alertAdminsNewRequest\(/);
  assert.match(CODE, /o\.createdAt < createdAt \|\| \(o\.createdAt\.getTime\(\) === createdAt\.getTime\(\) && o\.id < id\)/, "earlier by (createdAt, id), as hasEarlierPending orders it");
  assert.doesNotMatch(CODE, /notifyAdminsNewRequest/, "per-channel admin notifiers stay behind the shared alert");
});

test("bulk: the auto-approve push is the shared state machine's — no push or rollback of its own", () => {
  // A timeout, a dropped connection or a gateway 502/504 AFTER the add was sent
  // may have landed: the rollback (and its pushFailed mark) is for a definite
  // refusal, or a failure before the add went out (AddProgress). That rule is
  // request-transition.ts's (pinned in tests/request-transition.test.mts); bulk
  // must not carry a second copy.
  assert.match(CODE, /const settled = await pushApprovals\(toPush, "Bulk auto-approve"\);/);
  assert.doesNotMatch(CODE, /addMovieToRadarr|addSeriesToSonarr|arrWriteOutcomeUnknown/, "bulk pushes only through pushApprovals");
  assert.doesNotMatch(CODE, /data: \{ status: "PENDING"/, "bulk rolls nothing back itself");
  // Bulk has no profile picker: every pushed row carries none.
  assert.match(CODE, /requestedBy: targetUserId, qualityProfileId: null,/);
});

test("bulk: a title whose content rating could not be verified is filed but never auto-approved (ratingCapsVerdict)", () => {
  // A TMDB outage must neither refuse every item of a capped target nor let a
  // title past the cap straight into Radarr/Sonarr — the single route's rule.
  assert.match(CODE, /verdict: await ratingCapsVerdict\(caps, routing\.detailsOf\(it\)\)/);
  assert.match(CODE, /const unverifiedKeys = new Set\(checked\.filter\(\(c\) => c\.verdict === "unverified"\)/);
  assert.match(CODE, /autoApprove:\s*!unverifiedKeys\.has\(keyOf\(r\.it\.tmdbId, r\.it\.mediaType\)\) &&/);
  assert.match(CODE, /prepareItems\(ctx, capped\.toCreate, routing, staleDeclinedIdByKey, capped\.unverifiedKeys\)/);
});

test("bulk: the on-behalf audit row keeps counts and the filed titles, never the whole per-item result list", () => {
  assert.match(CODE, /created: createdCount, resultCounts: countResults\(results\), filed: filedTitles\(outcomes\) \}/);
  assert.doesNotMatch(CODE, /created: createdCount, results \}/, "a 50-row array in every audit row");
});
