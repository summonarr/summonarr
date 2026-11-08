// The shared request-policy steps (src/lib/request-policy.ts): instance
// resolution — explicit > is4k > auto-route over configured instances > the
// default, with the default fallback that re-checks the base REQUEST bit — the
// in-transaction quota re-check, the content-rating cap, and who auto-approves
// where.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  resolveTargetInstance,
  assertQuotaInTx,
  QuotaExceededError,
  ratingCapVerdict,
  ratingCapsVerdict,
  autoApprovesOn,
  enforcedQuota,
} = await import("../src/lib/request-policy.ts");
const { Permission } = await import("../src/lib/permissions.ts");

type Inst = { slug: string; name: string; restricted: boolean; serverAll: boolean; skipLibraryCheck: boolean; autoRoute: { animeOnly?: boolean; genreIds?: number[]; originalLanguages?: string[] } | null };
const DEFAULT: Inst = { slug: "", name: "Default", restricted: false, serverAll: false, skipLibraryCheck: false, autoRoute: null };
const FOURK: Inst = { slug: "4k", name: "4K", restricted: false, serverAll: false, skipLibraryCheck: true, autoRoute: null };
const ANIME: Inst = { slug: "anime", name: "Anime", restricted: true, serverAll: false, skipLibraryCheck: false, autoRoute: { originalLanguages: ["ja"] } };
const ALL = [DEFAULT, FOURK, ANIME];
const REQUESTER = Permission.REQUEST;

function details(originalLanguage: string | null, calls: { n: number }) {
  return async () => {
    calls.n++;
    return { originalLanguage, genreList: [], originCountryCodes: [] } as never;
  };
}

function resolve(opts: Partial<Parameters<typeof resolveTargetInstance>[0]> & { calls?: { n: number } }) {
  const calls = opts.calls ?? { n: 0 };
  return resolveTargetInstance({
    instances: ALL,
    configured: new Set(["", "4k", "anime"]),
    loadDetails: details("ja", calls),
    perms: REQUESTER,
    grants: {},
    mediaType: "MOVIE",
    request4kAll: false,
    ...opts,
  });
}

test("an explicit slug wins and is validated against the registry; an unknown one is unavailable", async () => {
  assert.deepEqual(await resolve({ arrInstance: "nope", perms: Permission.ADMIN }), { ok: false, reason: "instance-unavailable" });
  const blank = await resolve({ arrInstance: " " });
  assert.equal(blank.ok && blank.instance.slug, "", "a blank slug is the default instance, explicitly");
  const r = await resolve({ arrInstance: "anime", perms: Permission.ADMIN });
  assert.equal(r.ok && r.instance.slug, "anime");
  assert.equal(r.ok && r.explicit, true);
});

test("a registered but unconfigured non-default instance is unavailable, by name", async () => {
  const r = await resolve({ arrInstance: "anime", configured: new Set([""]), perms: Permission.ADMIN });
  assert.deepEqual(r, { ok: false, reason: "instance-unavailable", instanceName: "Anime" });
});

test("is4k is shorthand for the 4k instance, and an explicit target the requester can't use is refused", async () => {
  assert.deepEqual(await resolve({ is4k: true }), { ok: false, reason: "forbidden" });
  const r = await resolve({ is4k: true, perms: REQUESTER | Permission.REQUEST_4K });
  assert.equal(r.ok && r.instance.slug, "4k");
});

test("auto-route picks a matching configured instance, and only pays the TMDB fetch when a rule exists", async () => {
  const calls = { n: 0 };
  const granted = await resolve({ grants: { anime: { request: true } }, calls });
  assert.equal(granted.ok && granted.instance.slug, "anime");
  assert.equal(granted.ok && granted.explicit, false);
  assert.equal(calls.n, 1);

  const noRules = { n: 0 };
  const plain = await resolve({ instances: [DEFAULT, FOURK], calls: noRules });
  assert.equal(plain.ok && plain.instance.slug, "");
  assert.equal(noRules.n, 0, "no auto-route rule ⇒ no TMDB details fetch");
});

test("an auto-routed instance the requester can't use falls back to the default — but never past the base REQUEST bit", async () => {
  const fallback = await resolve({});
  assert.equal(fallback.ok && fallback.instance.slug, "", "a base requester lands on the default instance");
  assert.deepEqual(await resolve({ perms: 0n }), { ok: false, reason: "forbidden" }, "no request bit ⇒ refused, not defaulted");
});

test("the in-transaction quota re-check throws a typed refusal carrying the window", async () => {
  const rq = { limit: 2, since: new Date(0), windowLabel: "week" };
  const tx = (used: number) => ({ mediaRequest: { count: async () => used } });
  await assertQuotaInTx(tx(1), "u1", "MOVIE", rq);
  await assert.rejects(assertQuotaInTx(tx(2), "u1", "MOVIE", rq), (err: unknown) => {
    assert.ok(err instanceof QuotaExceededError);
    assert.equal(err.limit, 2);
    assert.equal(err.windowLabel, "week");
    assert.equal(err.used, 2);
    return true;
  });
  // A batch counts what it adds.
  await assert.rejects(assertQuotaInTx(tx(1), "u1", "TV", rq, 2, "filer"), (err: unknown) => err instanceof QuotaExceededError && err.whose === "filer");
});

test("enforcedQuota: QUOTA_UNLIMITED and a zero limit enforce nothing", () => {
  const user = { movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null, tvQuotaDays: null };
  assert.equal(enforcedQuota(Permission.QUOTA_UNLIMITED, "MOVIE", user, { quotaLimit: "5" }), null);
  assert.equal(enforcedQuota(REQUESTER, "MOVIE", user, { quotaLimit: "0" }), null);
  assert.equal(enforcedQuota(REQUESTER, "MOVIE", user, { quotaLimit: "5", quotaPeriod: "week" })?.limit, 5);
});

test("the rating cap: only a capped non-admin pays the fetch; unknown certifications pass", async () => {
  const cert = (c: string | undefined, calls: { n: number }) => async () => {
    calls.n++;
    return { certification: c } as never;
  };
  const calls = { n: 0 };
  assert.equal(await ratingCapVerdict(REQUESTER, "PG-13", cert("R", calls)), "blocked");
  assert.equal(await ratingCapVerdict(REQUESTER, "PG-13", cert("PG", calls)), "allowed");
  assert.equal(await ratingCapVerdict(REQUESTER, "PG-13", cert(undefined, calls)), "allowed");
  const before = calls.n;
  assert.equal(await ratingCapVerdict(Permission.ADMIN, "PG-13", cert("R", calls)), "allowed");
  assert.equal(await ratingCapVerdict(REQUESTER, null, cert("R", calls)), "allowed");
  assert.equal(calls.n, before, "an admin or an uncapped user never fetches");
});

// A TMDB outage must neither block every capped user nor let a title past the
// cap and straight into Radarr/Sonarr: the request is filed, never auto-approved.
test("the rating cap: a certification that can't be read is UNVERIFIED — not allowed, not blocked", async () => {
  const down = async () => { throw new Error("tmdb down"); };
  assert.equal(await ratingCapVerdict(REQUESTER, "PG-13", down), "unverified");
  assert.equal(await ratingCapsVerdict(["PG-13", "R"], down), "unverified");
  assert.equal(await ratingCapsVerdict([], down), "allowed", "no cap, no lookup to fail");
  // Several caps (an on-behalf filer's own beside the target's): the stricter wins.
  const r = async () => ({ certification: "R" }) as never;
  assert.equal(await ratingCapsVerdict(["NC-17", "PG-13"], r), "blocked");
  assert.equal(await ratingCapsVerdict(["NC-17"], r), "allowed");
});

// A Discord auto-approve role counts as the global AUTO_APPROVE bit and nothing
// more: like that bit it never reaches the 4K instance or a restricted named one.
test("autoApprovesOn: a role grant is the global auto-approve bit — never 4K or a restricted instance", () => {
  const NAMED_OPEN: Inst = { ...ANIME, slug: "kids", restricted: false };
  for (const [inst, expected] of [[DEFAULT, true], [NAMED_OPEN, true], [FOURK, false], [ANIME, false]] as const) {
    assert.equal(autoApprovesOn(REQUESTER, inst, {}, "MOVIE", true), expected, `role grant on "${inst.slug}"`);
    assert.equal(autoApprovesOn(REQUESTER, inst, {}, "MOVIE"), false, `no grant on "${inst.slug}"`);
  }
  // The instance's own grant still opens it, role or not.
  assert.equal(autoApprovesOn(REQUESTER, ANIME, { anime: { request: true, autoApprove: true } }, "TV", true), true);
  assert.equal(autoApprovesOn(REQUESTER | Permission.AUTO_APPROVE_4K, FOURK, {}, "MOVIE", true), true);
  assert.equal(autoApprovesOn(Permission.ADMIN, ANIME, {}, "MOVIE"), true);
});
