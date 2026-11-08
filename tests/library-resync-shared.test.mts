// The tail both per-source Resync routes share: when the orchestrator's
// success stamp is earned, and the audit row + answer body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "library-resync-shared-secret-0123456";

const { stampsOrchestratorSuccess, finishResync } = await import("../src/lib/library-resync.ts");

test("only a full replace of the lone default server earns the orchestrator's success stamp", () => {
  const ok = { instance: "", recentOnly: false, registeredServers: 1 };
  assert.equal(stampsOrchestratorSuccess(ok), true);
  assert.equal(stampsOrchestratorSuccess({ ...ok, registeredServers: 0 }), true);
  assert.equal(stampsOrchestratorSuccess({ ...ok, instance: "remote" }), false);
  assert.equal(stampsOrchestratorSuccess({ ...ok, recentOnly: true }), false);
  assert.equal(stampsOrchestratorSuccess({ ...ok, registeredServers: 2 }), false);
});

test("finishResync answers the scanned counts and the full flag", async () => {
  const res = finishResync("plex", { trigger: "cron", userId: null, userName: "system" } as never, {
    movies: 3, tv: 2, checked: 5, marked: 1, recentOnly: true,
  });
  assert.deepEqual(await res.json(), { scanned: { movies: 3, tv: 2 }, checked: 5, marked: 1, full: false });
});

test("both Resync routes finish through the shared helpers, not their own copies", () => {
  for (const src of ["src/app/api/sync/plex/route.ts", "src/app/api/sync/jellyfin/route.ts"]) {
    const text = readFileSync(new URL(`../${src}`, import.meta.url), "utf8");
    assert.match(text, /finishResync\(/, `${src} finishes through finishResync`);
    assert.match(text, /stampResyncSuccess\(/, `${src} stamps through stampResyncSuccess`);
    assert.doesNotMatch(text, /LIBRARY_SYNC/, `${src} writes no audit row of its own`);
  }
});
