// Structural pins for POST /api/requests/bulk (src/app/api/requests/bulk/route.ts).
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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SRC = readFileSync(join(ROOT, "src/app/api/requests/bulk/route.ts"), "utf8");
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

test("bulk: 'already-available' is produced ONLY by the pre-create gate; a mirrored row reads 'auto-approved'", () => {
  const verdicts = CODE.match(/result: "already-available"/g) ?? [];
  assert.equal(verdicts.length, 1, "one already-available verdict: the gate before the create tx");
  assert.match(CODE, /if \(mirroredKeys\.has\(keyOf\(p\.tmdbId, p\.mediaType\)\)\) \{\s*return \{ tmdbId: p\.tmdbId, mediaType: p\.mediaType, result: "auto-approved" \};/);
});

test("bulk: a present non-string onBehalfOfUserId is refused with 400 before any target is resolved", () => {
  const guard = CODE.indexOf('typeof body.onBehalfOfUserId !== "string") {');
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
