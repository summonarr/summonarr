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

// ── runResyncHoldingLock: when the caller is answered ────────────────────────
{
  const { Client } = await import("pg");
  const { runResyncHoldingLock } = await import("../src/lib/library-resync.ts");
  const calls: string[] = [];
  const pgProto = Client.prototype as unknown as {
    connect: () => Promise<void>;
    query: (t: string) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
  pgProto.connect = async () => {};
  pgProto.query = async (text) => {
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (text.includes("pg_advisory_unlock")) calls.push("unlock");
    return { rows: [] };
  };
  pgProto.end = async () => {};

  // A run whose held work finishes only when `finish` is called.
  const runWith = (answer?: "early" | "onRelease") => {
    let finish!: () => void;
    const heldWork = new Promise<void>((r) => { finish = r; });
    const answered = runResyncHoldingLock(
      4242,
      async (_signal, hold) => { hold(heldWork); return Response.json({ ok: true }); },
      () => Response.json({ skipped: true }),
      answer,
    ).then((res) => { calls.push("answered"); return res; });
    return { answered, finish };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("by default the caller is answered while the held work still keeps the lock", async () => {
    calls.length = 0;
    const { answered, finish } = runWith();
    await answered;
    assert.deepEqual(calls, ["answered"]);
    finish();
    await settle();
    assert.deepEqual(calls, ["answered", "unlock"]);
  });

  test("a background job is answered only once the lock is released, so the next server's request can take it", async () => {
    calls.length = 0;
    const { answered, finish } = runWith("onRelease");
    await settle();
    assert.deepEqual(calls, [], "answered while the held work still had the lock");
    finish();
    const res = await answered;
    assert.deepEqual(calls, ["unlock", "answered"]);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("both Resync routes run their background job to the lock's release", () => {
    for (const svc of ["plex", "jellyfin"]) {
      const src = readFileSync(new URL(`../src/app/api/sync/${svc}/route.ts`, import.meta.url), "utf8");
      assert.match(src, /startLibraryJob\([^\n]*\(\) => run\("onRelease"\)\)/, `${svc} job answers early`);
    }
  });
}
