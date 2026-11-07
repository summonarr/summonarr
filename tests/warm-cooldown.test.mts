// The admin warm routes' shared cooldown (src/lib/warm-cooldown.ts):
//
//   - a warm that THROWS gives its cooldown claim back, so the admin can retry
//     at once instead of being told to wait out a cooldown for work that never
//     happened — and the answer is a JSON 500, not a raw crash;
//   - the release is a compare-and-swap on the exact stamp the failed run
//     wrote, so it can never undo a newer claim;
//   - the claim's guard on the stored value is a CASE with a bounded digit
//     count, not `!~ regex OR CAST(…)`: Postgres does not promise OR's order,
//     and a 20-digit value passes `^[0-9]+$` and overflows the bigint cast;
//   - every warm route (and the play-history retention purge) goes through the
//     helper, so no copy of the old SQL survives anywhere.
//
// The in-memory Setting table below mirrors the claim's CASE and the release's
// WHERE so a claim → fail → release → re-claim sequence is observable; the SQL
// text itself is pinned structurally. No DB: the advisory lock talks to a
// patched pg Client.prototype.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype stubbed; never dialed

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

// ── advisory lock ──────────────────────────────────────────────────────────
let lockFree = true;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text) => (text.includes("pg_try_advisory_lock") ? { rows: [{ acquired: lockFree }] } : { rows: [] });
pgProto.end = async () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { runAdminWarm, claimCooldownSlot, releaseCooldownSlot, cooldownRetrySeconds } = await import("../src/lib/warm-cooldown.ts");

// ── the Setting table ──────────────────────────────────────────────────────
const settings = new Map<string, string>();
const statements: { sql: string; values: unknown[] }[] = [];
let releaseThrows = false;

shadowPrismaClientMethod(prisma, "$executeRaw", async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join("?").replace(/\s+/g, " ").trim();
  statements.push({ sql, values });
  if (sql.startsWith('INSERT INTO "Setting"')) {
    const [key, stamp, cooldownMs, now] = values as [string, string, number, number];
    const stored = settings.get(key);
    // The CASE: a 1-15 digit value is compared, anything else reads as expired.
    const expired = stored === undefined || !/^[0-9]{1,15}$/.test(stored) || Number(stored) + cooldownMs <= now;
    if (!expired) return 0;
    settings.set(key, stamp);
    return 1;
  }
  if (sql.startsWith('UPDATE "Setting"')) {
    if (releaseThrows) throw new Error("release write failed");
    const [key, claimedAt] = values as [string, string];
    if (settings.get(key) !== claimedAt) return 0;
    settings.set(key, "0");
    return 1;
  }
  throw new Error(`unexpected statement: ${sql}`);
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});

const KEY = "lastTestWarmAt";
const COOLDOWN_MS = 5 * 60 * 1000;

function warm(run: (signal: AbortSignal, claimedAt: number) => Promise<Response>, force = false) {
  return runAdminWarm({
    lockId: 9_999,
    cooldownKey: KEY,
    cooldownMs: COOLDOWN_MS,
    force,
    busyMessage: "already running",
    cooldownMessage: (seconds) => `too recently — wait ${seconds}s`,
    failedMessage: "warm failed",
    scope: "[test-warm]",
    run: run as (signal: AbortSignal, claimedAt: number) => Promise<import("next/server").NextResponse>,
  });
}
const ok = async () => Response.json({ ok: true });
const boom = async (): Promise<Response> => { throw new Error("db timeout"); };

beforeEach(() => {
  settings.clear();
  statements.length = 0;
  warns.length = 0;
  lockFree = true;
  releaseThrows = false;
});

test("a warm that throws answers a JSON 500 and gives its cooldown back — the retry runs at once", async () => {
  const failed = await warm(boom);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "warm failed" });
  assert.equal(settings.get(KEY), "0", "the claim was released");
  assert.ok(warns.some((w) => w.startsWith("[test-warm] warm failed")), "the failure is logged once, with the scope");

  let ran = false;
  const retry = await warm(async () => { ran = true; return ok(); });
  assert.equal(retry.status, 200, "an immediate retry is not a 429");
  assert.equal(ran, true);
});

test("a warm that succeeds keeps its claim: the next click inside the window is a 429 with a retry hint", async () => {
  assert.equal((await warm(ok)).status, 200);
  assert.equal(statements.filter((s) => s.sql.startsWith("UPDATE")).length, 0, "nothing is released after a success");
  const second = await warm(ok);
  assert.equal(second.status, 429);
  const body = await second.json() as { error: string; retryAfter: number };
  assert.ok(body.retryAfter >= 1 && body.retryAfter <= COOLDOWN_MS / 1000);
  assert.equal(body.error, `too recently — wait ${body.retryAfter}s`);
});

test("the release is a CAS on the failed run's own stamp — it never undoes a newer claim", async () => {
  // Another click claimed after this run's claim (e.g. once the window passed).
  settings.set(KEY, "2000");
  await releaseCooldownSlot(KEY, 1000);
  assert.equal(settings.get(KEY), "2000");
  await releaseCooldownSlot(KEY, 2000);
  assert.equal(settings.get(KEY), "0");
});

test("a release that itself fails still answers the 500, and says so in the log", async () => {
  releaseThrows = true;
  const res = await warm(boom);
  assert.equal(res.status, 500);
  assert.ok(warns.some((w) => w.includes("could not release the cooldown")));
});

test("the warm runs with the lock's AbortSignal and the claimed stamp (guardrail 41)", async () => {
  let seen: { signal: unknown; claimedAt: number } | null = null;
  const before = Date.now();
  await warm(async (signal, claimedAt) => { seen = { signal, claimedAt }; return ok(); });
  assert.ok(seen);
  const got = seen as { signal: unknown; claimedAt: number };
  assert.ok(got.signal instanceof AbortSignal);
  assert.ok(got.claimedAt >= before);
  assert.equal(settings.get(KEY), String(got.claimedAt), "the stamp the run is told about is the one stored");
});

test("a busy lock is a 409 that claims nothing", async () => {
  lockFree = false;
  const res = await warm(ok);
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("Retry-After"), "30");
  assert.equal(statements.length, 0, "no claim for a warm that never ran");
  assert.equal(settings.size, 0);
});

test("force skips the claim but stamps the slot; a FAILED forced warm gives the stamp back too", async () => {
  settings.set(KEY, String(Date.now())); // inside the cooldown
  const forced = await warm(ok, true);
  assert.equal(forced.status, 200);
  assert.equal(statements.filter((s) => s.sql.startsWith("INSERT")).length, 0, "force never runs the claim");
  assert.ok(Number(settings.get(KEY)) > 0, "the force still stamps, so a plain click right after waits");
  assert.equal((await warm(ok)).status, 429);

  const failedForce = await warm(boom, true);
  assert.equal(failedForce.status, 500);
  assert.equal(settings.get(KEY), "0");
});

test("an unreadable or over-long stored stamp reads as expired; the retry hint never shows NaN or a negative wait", async () => {
  for (const corrupt of ["not-a-number", "99999999999999999999", "1".repeat(16)]) {
    settings.set(KEY, corrupt);
    assert.equal(await claimCooldownSlot(KEY, COOLDOWN_MS, Date.now()), true, `${corrupt} must not block the claim`);
    settings.set(KEY, corrupt);
    const seconds = await cooldownRetrySeconds(KEY, COOLDOWN_MS, Date.now());
    assert.ok(Number.isInteger(seconds) && seconds >= 1, `retry hint for ${corrupt}: ${seconds}`);
  }
});

// ── structural pins ────────────────────────────────────────────────────────

test("the claim's guard is a CASE with a bounded digit count — never an OR around the CAST", async () => {
  await claimCooldownSlot(KEY, COOLDOWN_MS, Date.now());
  const claim = statements.find((s) => s.sql.startsWith('INSERT INTO "Setting"'));
  assert.ok(claim);
  assert.match(claim.sql, /WHERE CASE WHEN "Setting"\.value ~ '\^\[0-9\]\{1,15\}\$' THEN CAST\("Setting"\.value AS BIGINT\) \+ \?::bigint <= \?::bigint ELSE TRUE END/);
  assert.doesNotMatch(claim.sql, /!~/);
  assert.doesNotMatch(claim.sql, /\bOR\b/);
  // Only values are bound (guardrail 23a): key, stamp, cooldown, now.
  assert.equal(claim.values.length, 4);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("every admin warm route, and the retention purge, claims through the shared helper — no copy of the old SQL is left", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  for (const route of ["activity-warm", "library-warm", "mdblist-warm", "omdb-warm"]) {
    const src = readFileSync(join(root, "app/api/admin", route, "route.ts"), "utf8");
    assert.match(src, /runAdminWarm\(\{/, `${route} does not go through runAdminWarm`);
    assert.doesNotMatch(src, /INSERT INTO "Setting"/, `${route} carries its own cooldown SQL`);
  }
  const retention = readFileSync(join(root, "app/api/sync/play-history/route.ts"), "utf8");
  assert.match(retention, /claimCooldownSlot\("lastRetentionCheckAt", 3600_000, now\)/);
  for (const file of walk(root)) {
    if (file.includes("/generated/")) continue;
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /value !~ '\^\[0-9\]\+\$'/, `${file} still guards a CAST with an OR`);
  }
});
