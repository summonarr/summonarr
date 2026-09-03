// Review 2026-09, package P26 — resolveCurated (src/lib/trash-recommendations.ts).
//
// f128: `match.slug` is NOT a lookup key. The sync (refreshQualityProfiles in
// trash.ts) stores `parsedRaw.trash_id`, and isQualityProfilePayload requires
// that to be a non-empty string, so a stored TrashSpec.trashId can never equal a
// filename slug. Querying the slug as a trashId was a guaranteed-miss
// round-trip per slug-bearing entry on every resolveStarterPack call.
//
// f129: the partial-name fallback is APPLY-facing — POST starter-pack pushes
// every resolved curated spec to Radarr/Sonarr — and TRaSH ships superset names
// in the same (service, kind): "UHD Bluray + WEB" ⊃ "HD Bluray + WEB",
// "WEB-1080p (Alternative)" ⊃ "WEB-1080p". An unordered `findFirst … contains`
// handed whichever row Postgres yielded first to the one-click apply under the
// 1080p label. The fallback must resolve ONLY a unique partial match.
//
// No DB: prisma.trashSpec is shadowed with an in-memory stub that honours every
// filter resolveCurated/resolveStarterPack issue (trashId, name.equals,
// name.contains, kind.in, id.notIn, take).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { resolveStarterPack, STARTER_PACK } = await import("../src/lib/trash-recommendations.ts");

type Spec = {
  id: string;
  service: "RADARR" | "SONARR";
  kind: "QUALITY_PROFILE" | "NAMING" | "QUALITY_SIZE";
  trashId: string;
  name: string;
  payload: unknown;
};

let specs: Spec[] = [];
type Op = { op: string; args: Record<string, unknown> };
let ops: Op[] = [];

type Where = {
  service?: string;
  kind?: string | { in?: string[] };
  trashId?: string;
  id?: { notIn?: string[]; in?: string[] };
  name?: { equals?: string; contains?: string };
};

function filter(w: Where): Spec[] {
  return specs.filter((s) => {
    if (w.service && s.service !== w.service) return false;
    if (typeof w.kind === "string" && s.kind !== w.kind) return false;
    if (typeof w.kind === "object" && w.kind?.in && !w.kind.in.includes(s.kind)) return false;
    if (w.trashId !== undefined && s.trashId !== w.trashId) return false;
    if (w.id?.notIn && w.id.notIn.includes(s.id)) return false;
    if (w.id?.in && !w.id.in.includes(s.id)) return false;
    if (w.name?.equals !== undefined && s.name.toLowerCase() !== w.name.equals.toLowerCase()) return false;
    if (w.name?.contains !== undefined && !s.name.toLowerCase().includes(w.name.contains.toLowerCase())) return false;
    return true;
  });
}

shadowPrismaModel(prisma, "trashSpec", {
  findFirst: async (args: { where?: Where } & Record<string, unknown>) => {
    ops.push({ op: "findFirst", args });
    const hit = filter(args.where ?? {})[0];
    return hit ? { ...hit, applications: [] } : null;
  },
  findMany: async (args: { where?: Where; take?: number } & Record<string, unknown>) => {
    ops.push({ op: "findMany", args });
    let rows = filter(args.where ?? {});
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((s) => ({ ...s, applications: [] }));
  },
});

function spec(over: Partial<Spec> & { id: string; name: string }): Spec {
  return { service: "RADARR", kind: "QUALITY_PROFILE", trashId: `trash-${over.id}`, payload: {}, ...over };
}

const radarrQp = STARTER_PACK.find((i) => i.service === "RADARR" && i.kind === "QUALITY_PROFILE")!;
const sonarrQp = STARTER_PACK.find((i) => i.service === "SONARR" && i.kind === "QUALITY_PROFILE")!;

function statusOf(item: typeof radarrQp, results: Awaited<ReturnType<typeof resolveStarterPack>>) {
  const row = results.find((r) => r.item === item);
  assert.ok(row, `${item.label} missing from resolveStarterPack output`);
  return row;
}

beforeEach(() => {
  specs = [];
  ops = [];
});

// ── f128 ─────────────────────────────────────────────────────────────────────

test("f128: no lookup ever uses a pack slug as a trashId — the sync never stores one", async () => {
  await resolveStarterPack();
  const slugs = STARTER_PACK.map((i) => i.match?.slug).filter((s): s is string => Boolean(s));
  assert.ok(slugs.length > 0, "the pack still carries informational slugs this test keys on");
  const trashIdLookups = ops
    .map((o) => (o.args.where as Where | undefined)?.trashId)
    .filter((t): t is string => typeof t === "string");
  for (const slug of slugs) {
    assert.ok(!trashIdLookups.includes(slug), `slug "${slug}" was queried as a trashId`);
  }
});

test("f128: a slug-only entry (Sonarr WEB-1080p) issues no trashId query at all, and still resolves by exact name", async () => {
  specs = [spec({ id: "s-web", service: "SONARR", trashId: "72dae194fc92bf828f32cde7744e51a1", name: "WEB-1080p" })];
  const results = await resolveStarterPack();
  assert.equal(sonarrQp.match?.trashId, undefined, "precondition: the Sonarr entry declares no trashId");
  const sonarrOps = ops.filter((o) => (o.args.where as Where | undefined)?.service === "SONARR"
    && (o.args.where as Where | undefined)?.kind === "QUALITY_PROFILE");
  assert.ok(sonarrOps.every((o) => (o.args.where as Where).trashId === undefined), "no trashId probe for a slug-only entry");
  assert.equal(statusOf(sonarrQp, results).spec?.id, "s-web");
});

test("f128: the trashId path still wins over a name match", async () => {
  specs = [
    spec({ id: "by-id", trashId: radarrQp.match!.trashId!, name: "Renamed Upstream" }),
    spec({ id: "by-name", trashId: "ffffffffffffffffffffffffffffffff", name: "HD Bluray + WEB" }),
  ];
  const results = await resolveStarterPack();
  assert.equal(statusOf(radarrQp, results).spec?.id, "by-id");
});

// ── f129 ─────────────────────────────────────────────────────────────────────

test("f129: an ambiguous partial match (UHD + German supersets) resolves to NOTHING — never a 4K/language profile under the 1080p label", async () => {
  specs = [
    spec({ id: "uhd", trashId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "UHD Bluray + WEB" }),
    spec({ id: "de", trashId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "German HD Bluray + WEB" }),
  ];
  const results = await resolveStarterPack();
  const curated = statusOf(radarrQp, results);
  assert.equal(curated.spec, null, "a superset-only catalog must leave the curated entry unresolved");
  assert.equal(curated.item.recommended, true);
  // Both supersets still surface — as NON-recommended catalog rows, not as the pack entry.
  for (const id of ["uhd", "de"]) {
    const row = results.find((r) => r.spec?.id === id);
    assert.ok(row, `${id} should still be listed as a catalog row`);
    assert.equal(row.item.recommended, false, `${id} must not be marked recommended`);
  }
});

test("f129: the partial fallback is never consulted once the exact name resolved ('WEB-1080p (Alternative)' beside 'WEB-1080p')", async () => {
  // One partial hit is treated as a rename by design (accepted residual: a LONE
  // superset with no exact/trashId row does resolve). What must hold is that a
  // present exact row wins outright and the superset is never even queried.
  specs = [
    spec({ id: "alt", service: "SONARR", trashId: "cccccccccccccccccccccccccccccccc", name: "WEB-1080p (Alternative)" }),
    spec({ id: "real", service: "SONARR", trashId: "72dae194fc92bf828f32cde7744e51a1", name: "WEB-1080p" }),
  ];
  const results = await resolveStarterPack();
  // With the exact row present the exact-name path wins and the superset is never consulted.
  assert.equal(statusOf(sonarrQp, results).spec?.id, "real");
  assert.ok(
    !ops.some((o) => {
      const w = o.args.where as Where | undefined;
      return w?.service === "SONARR" && w.kind === "QUALITY_PROFILE" && w.name?.contains !== undefined;
    }),
    "the partial fallback must not run for an entry whose exact name resolved",
  );
});

test("f129: exactly one partial match still resolves (rename tolerance preserved)", async () => {
  specs = [spec({ id: "v2", trashId: "dddddddddddddddddddddddddddddddd", name: "HD Bluray + WEB v2" })];
  const results = await resolveStarterPack();
  assert.equal(statusOf(radarrQp, results).spec?.id, "v2");
});

test("f129: the partial fallback is a bounded findMany (take: 2), not an unordered findFirst", async () => {
  specs = [spec({ id: "v2", trashId: "dddddddddddddddddddddddddddddddd", name: "HD Bluray + WEB v2" })];
  await resolveStarterPack();
  const partial = ops.filter((o) => (o.args.where as Where | undefined)?.name?.contains !== undefined);
  assert.ok(partial.length > 0, "the partial fallback ran");
  for (const o of partial) {
    assert.equal(o.op, "findMany", "partial match must enumerate hits so ambiguity is detectable");
    assert.equal(o.args.take, 2, "two rows is enough to prove ambiguity — never scan the whole catalog");
  }
});
