// Unit tests for createInAppNotification (src/lib/in-app-notify.ts) — the shared
// best-effort writer behind the in-app inbox (header bell + /notifications).
// The contracts pinned here are the WIRING ones, not the field-shaping matrix
// (that lives in tests/notification-data.test.mts, which owns buildNotificationData):
//
//   - fire-and-forget: the call returns void SYNCHRONOUSLY and issues exactly
//     one prisma.notification.create per invocation — the caller (an approve
//     route, the sync orchestrator's notify pass, an issue reply) is never
//     blocked on the inbox write;
//   - the row written is buildNotificationData's output (title/body caps and
//     mediaType enum-normalization applied) — proof the shared shaper is used,
//     not a drifting local copy; the batch path in request-notifications relies
//     on both writers shaping identically;
//   - a FAILED write is swallowed and logged with the [notify] scope — never a
//     throw, never an unhandled rejection (an unhandled rejection would crash
//     this very test process, so every green run enforces it), and never a
//     poisoned next call. "A failed inbox write must never break the triggering
//     action" is the module's whole reason to exist.
//
// No DB: the `notification` delegate is shadowed in-memory (tests/_helpers.mts).
// console.error is captured before the module graph loads.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── console capture ─────────────────────────────────────────────────────────
const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/console stubs above genuinely precede the
// module-graph load (static imports would hoist above them).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

type CreateArgs = { data: Record<string, unknown> };
const creates: CreateArgs[] = [];
let createImpl: (args: CreateArgs) => Promise<unknown> = async (args) => args.data;

shadowPrismaModel(prisma, "notification", {
  create: (args: CreateArgs) => {
    creates.push(args);
    return createImpl(args);
  },
});

const { createInAppNotification } = await import("../src/lib/in-app-notify.ts");

// The write is intentionally unawaited by the caller; settle its promise chain
// (including the .catch handler) before asserting.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  creates.length = 0;
  errors.length = 0;
  createImpl = async (args) => args.data;
});

test("returns void synchronously and issues exactly one create with the fully shaped row", async () => {
  const result = createInAppNotification("user-1", {
    type: "REQUEST_AVAILABLE",
    title: "Dune",
    body: "Your movie request is now available.",
    tmdbId: 438631,
    mediaType: "MOVIE",
    posterPath: "/dune.jpg",
  });
  assert.equal(result, undefined); // void, not a promise handed back to the caller
  assert.equal(creates.length, 1); // the write fires on invocation, not deferred
  assert.deepEqual(creates[0].data, {
    userId: "user-1",
    type: "REQUEST_AVAILABLE",
    title: "Dune",
    body: "Your movie request is now available.",
    tmdbId: 438631,
    mediaType: "MOVIE",
    posterPath: "/dune.jpg",
  });
  await flush();
  assert.deepEqual(errors, []); // silent success (guardrail 7)
});

test("minimal input: optionals default to null and a non-enum mediaType collapses to null", async () => {
  // Shaping matrix lives in tests/notification-data.test.mts; this pins that the
  // writer routes through the shared shaper (null defaults, enum normalization).
  createInAppNotification("user-2", { type: "ISSUE_REPLY", title: "Re: audio", body: "Fixed." });
  createInAppNotification("user-2", {
    type: "ISSUE_REPLY",
    title: "t",
    body: "b",
    mediaType: "movie", // lowercase ≠ the MOVIE enum member
  });
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].data, {
    userId: "user-2",
    type: "ISSUE_REPLY",
    title: "Re: audio",
    body: "Fixed.",
    tmdbId: null,
    mediaType: null,
    posterPath: null,
  });
  assert.equal(creates[1].data.mediaType, null);
  await flush();
});

test("title/body flow through the VarChar caps (500/1000) — the shared shaper shapes the row", async () => {
  createInAppNotification("user-3", {
    type: "REQUEST_APPROVED",
    title: "t".repeat(600),
    body: "b".repeat(1200),
  });
  assert.equal((creates[0].data.title as string).length, 500);
  assert.equal((creates[0].data.body as string).length, 1000);
  await flush();
});

test("a failed write is swallowed and logged with the [notify] scope — never a throw", async () => {
  createImpl = async () => { throw new Error("connection refused"); };
  // A synchronous throw or an unhandled rejection here would fail this test
  // process; the green run is the enforcement of the swallow contract.
  createInAppNotification("user-4", { type: "REQUEST_DECLINED", title: "t", body: "b" });
  await flush();
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("[notify] in-app write failed:"), `scoped prefix, got: ${errors[0]}`);
  assert.ok(errors[0].includes("connection refused"), "Error rejections log err.message");
});

test("a non-Error rejection value is logged raw", async () => {
  createImpl = () => Promise.reject("P2002 shaped string");
  createInAppNotification("user-5", { type: "REQUEST_APPROVED", title: "t", body: "b" });
  await flush();
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("P2002 shaped string"));
});

test("fire-and-forget: the caller is not blocked on a slow write", async () => {
  let settle!: () => void;
  let settled = false;
  createImpl = () =>
    new Promise<unknown>((resolve) => {
      settle = () => { settled = true; resolve({}); };
    });
  createInAppNotification("user-6", { type: "REQUEST_APPROVED", title: "t", body: "b" });
  // Control is back here while the write is still pending — the create was
  // issued, but nothing awaited its settlement.
  assert.equal(creates.length, 1);
  assert.equal(settled, false);
  settle();
  await flush();
  assert.deepEqual(errors, []);
});

test("a failed write does not poison the next notification", async () => {
  createImpl = async () => { throw new Error("first write down"); };
  createInAppNotification("user-7", { type: "REQUEST_APPROVED", title: "one", body: "b" });
  await flush();

  createImpl = async (args) => args.data;
  createInAppNotification("user-7", { type: "REQUEST_AVAILABLE", title: "two", body: "b" });
  await flush();

  assert.equal(creates.length, 2);
  assert.equal(creates[1].data.title, "two");
  assert.equal(errors.length, 1); // only the first write logged
});

test("each call writes exactly one row for its own user", async () => {
  createInAppNotification("u-a", { type: "T", title: "a", body: "x" });
  createInAppNotification("u-b", { type: "T", title: "b", body: "x" });
  createInAppNotification("u-c", { type: "T", title: "c", body: "x" });
  assert.deepEqual(creates.map((c) => c.data.userId), ["u-a", "u-b", "u-c"]);
  await flush();
  assert.deepEqual(errors, []);
});
