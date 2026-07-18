// Unit tests for the TRaSH-Guides orchestration layer (src/lib/trash.ts): the
// GitHub catalog refresh, the Radarr/Sonarr apply pipelines, TrashApplication
// bookkeeping, and the runTrashSync cron entry point. Sibling files own the
// layers underneath — tests/trash-validators.test.mts the payload type guards,
// tests/trash-html.test.mts the description sanitizer,
// tests/trash-recommendations.test.mts the starter-pack registry, and
// tests/arr.test.mts the arrFetch error primitives — so this file pins what
// trash.ts composes ON TOP of them:
//   - the fetch layer: exact api.github.com tree + raw.githubusercontent.com
//     file URLs, the shared gh auth headers (token authenticates BOTH hops),
//     service-scoped .json blob filtering, sha-unchanged skip, per-file failure
//     isolation (parse/validator rejects don't sink the batch), truncation
//     persistence, and the batched upserts under { timeout: BATCH_TX_TIMEOUT };
//   - apply wiring: exact POST/PUT bodies for a representative custom format
//     (normalizeSpecFields), naming merge (full GET → merged PUT; Radarr vs the
//     nested Sonarr episodes shapes), quality-size last-writer-wins merge, and
//     the full quality-profile body build (schema carry, allowed-items mapping,
//     group cutoff id, score_set→default→0 scores, remote trash_id metadata
//     mapping, dependency-CF auto-apply);
//   - identity/recovery: remoteId-from-application beats name-match beats POST,
//     PUT-404 → POST recreate (`recreated` flag), prefetch failure fails the
//     whole batch instead of blind-POSTing duplicates ([trash]-scoped warn);
//   - bookkeeping: recordApply success resets error state, failure increments
//     errorCount through the P2025-create-P2002 race path;
//   - orchestration: applySpecs dependency ordering + group-member dedup;
//     runTrashSync's enabled/cadence gates, per-service per-instance fan-out
//     (variant slug → arrSettingKey-derived connection), kind gating, error
//     folding, and per-service refresh failure containment.
// No DB or network: prisma.setting/trashSpec/trashApplication and $transaction
// are shadowed in-memory (tests/_helpers.mts), globalThis.fetch is scripted per
// URL, dns/promises.lookup is stubbed (public address) for the GitHub hostname
// paths, and the arr instances use RFC1918 IP-literal URLs — allowed by the
// admin-configured SSRF mode with no DNS lookup at all.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "140.82.112.3", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");
const {
  describeSchemaError,
  refreshCatalog,
  applyCustomFormats,
  applyCustomFormatGroups,
  applyNaming,
  applyQualitySizes,
  applyQualityProfiles,
  applySpecs,
  runTrashSync,
  listSpecs,
  getSpecDetail,
} = await import("../src/lib/trash.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────

// Setting: plain key→value map. The delegate is shadowed, so the encryption
// extension is bypassed — values are plaintext, matching what callers read.
const settings = new Map<string, string>();
const settingUpserts: Array<{ key: string; value: string }> = [];
const settingDeletes: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k)! })),
  upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
    settingUpserts.push({ key: args.where.key, value: args.create.value });
    settings.set(args.where.key, args.create.value);
    return args.create;
  },
  deleteMany: async (args: { where: { key: string } }) => {
    settingDeletes.push(args.where.key);
    return { count: settings.delete(args.where.key) ? 1 : 0 };
  },
});

type Service = "RADARR" | "SONARR";
type SpecRow = {
  id: string;
  service: Service;
  kind: string;
  trashId: string;
  name: string;
  description: string | null;
  payload: unknown;
  upstreamPath: string;
  upstreamSha: string | null;
  fetchedAt: Date;
};
type AppRow = {
  id: string;
  trashSpecId: string;
  arrInstance: string;
  enabled: boolean;
  remoteId: number | null;
  appliedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  errorCount: number;
};

const specRows: SpecRow[] = [];
const appRows: AppRow[] = [];
let specSeq = 0;
let appSeq = 0;

function matchStr(value: string, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === "string") return value === cond;
  if (cond && typeof cond === "object" && Array.isArray((cond as { in?: unknown }).in)) {
    return ((cond as { in: string[] }).in).includes(value);
  }
  return true;
}
function specMatches(row: SpecRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return (
    matchStr(row.id, where.id) &&
    matchStr(row.service, where.service) &&
    matchStr(row.kind, where.kind) &&
    matchStr(row.trashId, where.trashId)
  );
}
function appsFor(specId: string, appWhere?: { arrInstance?: string }): AppRow[] {
  return appRows
    .filter((a) => a.trashSpecId === specId)
    .filter((a) => appWhere?.arrInstance === undefined || a.arrInstance === appWhere.arrInstance)
    .map((a) => ({ ...a }));
}

type SpecFindManyArgs = {
  where?: Record<string, unknown>;
  include?: { applications?: { where?: { arrInstance?: string } } };
};
const specUpserts: Array<{
  where: { service_kind_trashId: { service: Service; kind: string; trashId: string } };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}> = [];
shadowPrismaModel(prisma, "trashSpec", {
  findMany: async (args: SpecFindManyArgs = {}) =>
    specRows
      .filter((r) => specMatches(r, args.where))
      .map((r) =>
        args.include?.applications
          ? { ...r, applications: appsFor(r.id, args.include.applications.where) }
          : { ...r },
      ),
  findUnique: async (args: { where: { id: string }; include?: { applications?: { where?: { arrInstance?: string } } } }) => {
    const row = specRows.find((r) => r.id === args.where.id);
    if (!row) return null;
    return args.include?.applications
      ? { ...row, applications: appsFor(row.id, args.include.applications.where) }
      : { ...row };
  },
  upsert: async (args: (typeof specUpserts)[number]) => {
    specUpserts.push(args);
    const k = args.where.service_kind_trashId;
    const existing = specRows.find(
      (r) => r.service === k.service && r.kind === k.kind && r.trashId === k.trashId,
    );
    if (existing) {
      Object.assign(existing, args.update);
      return { ...existing };
    }
    const row = {
      id: `spec-${++specSeq}`,
      description: null,
      upstreamSha: null,
      ...args.create,
    } as SpecRow;
    specRows.push(row);
    return { ...row };
  },
});

function applyAppData(row: AppRow, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (k === "errorCount" && v && typeof v === "object" && typeof (v as { increment?: unknown }).increment === "number") {
      row.errorCount += (v as { increment: number }).increment;
    } else {
      (row as unknown as Record<string, unknown>)[k] = v;
    }
  }
}
function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// When set, the next trashApplication.create simulates losing a concurrent-create
// race: a "winner" row (errorCount 1) appears and the create throws P2002 —
// recordApply's fallback must then re-update so the tally reflects BOTH attempts.
let appCreateConflictOnce = false;

type AppWhereUnique = { trashSpecId_arrInstance: { trashSpecId: string; arrInstance: string } };
shadowPrismaModel(prisma, "trashApplication", {
  findMany: async (
    args: {
      where?: { enabled?: boolean; arrInstance?: string; trashSpec?: Record<string, unknown> };
      include?: { trashSpec?: boolean };
    } = {},
  ) => {
    const w = args.where ?? {};
    return appRows
      .filter((a) => w.enabled === undefined || a.enabled === w.enabled)
      .filter((a) => w.arrInstance === undefined || a.arrInstance === w.arrInstance)
      .filter((a) => {
        if (w.trashSpec === undefined) return true;
        const s = specRows.find((r) => r.id === a.trashSpecId);
        return !!s && specMatches(s, w.trashSpec);
      })
      .map((a) =>
        args.include?.trashSpec
          ? { ...a, trashSpec: { ...specRows.find((r) => r.id === a.trashSpecId)! } }
          : { ...a },
      );
  },
  upsert: async (args: { where: AppWhereUnique; update: Record<string, unknown>; create: Record<string, unknown> }) => {
    const k = args.where.trashSpecId_arrInstance;
    const existing = appRows.find(
      (a) => a.trashSpecId === k.trashSpecId && a.arrInstance === k.arrInstance,
    );
    if (existing) {
      applyAppData(existing, args.update);
      return { ...existing };
    }
    const row: AppRow = {
      id: `app-${++appSeq}`,
      trashSpecId: k.trashSpecId,
      arrInstance: k.arrInstance,
      enabled: true,
      remoteId: null,
      appliedAt: null,
      lastError: null,
      lastErrorAt: null,
      errorCount: 0,
    };
    applyAppData(row, args.create);
    appRows.push(row);
    return { ...row };
  },
  update: async (args: { where: AppWhereUnique; data: Record<string, unknown> }) => {
    const k = args.where.trashSpecId_arrInstance;
    const existing = appRows.find(
      (a) => a.trashSpecId === k.trashSpecId && a.arrInstance === k.arrInstance,
    );
    if (!existing) throw prismaError("P2025", "No record was found for an update.");
    applyAppData(existing, args.data);
    return { ...existing };
  },
  create: async (args: { data: Record<string, unknown> & { trashSpecId: string; arrInstance: string } }) => {
    if (appCreateConflictOnce) {
      appCreateConflictOnce = false;
      appRows.push({
        id: `app-${++appSeq}`,
        trashSpecId: args.data.trashSpecId,
        arrInstance: args.data.arrInstance,
        enabled: true,
        remoteId: null,
        appliedAt: null,
        lastError: "winner error",
        lastErrorAt: new Date(),
        errorCount: 1,
      });
      throw prismaError("P2002", "Unique constraint failed");
    }
    const existing = appRows.find(
      (a) => a.trashSpecId === args.data.trashSpecId && a.arrInstance === args.data.arrInstance,
    );
    if (existing) throw prismaError("P2002", "Unique constraint failed");
    const row: AppRow = {
      id: `app-${++appSeq}`,
      trashSpecId: args.data.trashSpecId,
      arrInstance: args.data.arrInstance,
      enabled: true,
      remoteId: null,
      appliedAt: null,
      lastError: null,
      lastErrorAt: null,
      errorCount: 0,
    };
    applyAppData(row, args.data);
    appRows.push(row);
    return { ...row };
  },
});

// Interactive-transaction stub: run the callback against the same shadowed
// client and record the options so the BATCH_TX_TIMEOUT pin (guardrail 4) is
// assertable.
const txCalls: Array<{ timeout?: number } | undefined> = [];
shadowPrismaClientMethod(prisma, "$transaction", (fnOrOps: unknown, opts?: { timeout?: number }) => {
  txCalls.push(opts);
  if (typeof fnOrOps === "function") return (fnOrOps as (tx: unknown) => Promise<unknown>)(prisma);
  return Promise.all(fnOrOps as Promise<unknown>[]);
});

// ── scripted fetch ──────────────────────────────────────────────────────────
type ScriptedCall = { url: URL; method: string; headers: Headers; body: string | null };
const fetchCalls: ScriptedCall[] = [];
let respond: (call: ScriptedCall) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: ScriptedCall = {
    url: new URL(String(input)),
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : null,
  };
  fetchCalls.push(call);
  return respond(call);
}) as typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function callKey(c: ScriptedCall): string {
  return `${c.method} ${c.url.origin}${c.url.pathname}`;
}
function router(routes: Record<string, (call: ScriptedCall) => Response>): (call: ScriptedCall) => Response {
  return (call) => {
    const handler = routes[callKey(call)];
    if (!handler) throw new Error(`unexpected fetch: ${callKey(call)}`);
    return handler(call);
  };
}

const TREE_KEY = "GET https://api.github.com/repos/TRaSH-Guides/Guides/git/trees/master";
const RAW_BASE = "https://raw.githubusercontent.com/TRaSH-Guides/Guides/master";

function blob(path: string, sha: string): { path: string; sha: string; type: string } {
  return { path, sha, type: "blob" };
}
// Routes for one GitHub round: the recursive tree plus raw file contents keyed
// by repo path (object values are JSON-encoded; string values served verbatim).
function ghRoutes(
  entries: Array<{ path: string; sha: string; type: string }>,
  files: Record<string, unknown>,
  opts: { truncated?: boolean } = {},
): Record<string, (call: ScriptedCall) => Response> {
  const routes: Record<string, (call: ScriptedCall) => Response> = {
    [TREE_KEY]: () => json({ tree: entries, truncated: opts.truncated ?? false }),
  };
  for (const [path, content] of Object.entries(files)) {
    routes[`GET ${RAW_BASE}/${path}`] = () =>
      typeof content === "string" ? new Response(content, { status: 200 }) : json(content);
  }
  return routes;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_ANIME = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";

function configureRadarr(): void {
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
}
function configureRadarrAnime(): void {
  settings.set("radarrAnimeUrl", RADARR_ANIME);
  settings.set("radarrAnimeApiKey", "anime-key");
}
function configureSonarr(): void {
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
}

function seedSpec(input: {
  service: Service;
  kind: string;
  trashId: string;
  name?: string;
  payload?: unknown;
  description?: string | null;
  sha?: string | null;
  path?: string;
}): SpecRow {
  const name = input.name ?? input.trashId;
  const row: SpecRow = {
    id: `spec-${++specSeq}`,
    service: input.service,
    kind: input.kind,
    trashId: input.trashId,
    name,
    description: input.description ?? null,
    payload: input.payload ?? { trash_id: input.trashId, name },
    upstreamPath: input.path ?? `docs/json/test/${input.trashId}.json`,
    upstreamSha: input.sha ?? null,
    fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  specRows.push(row);
  return row;
}
function seedApp(trashSpecId: string, arrInstance: string, extra: Partial<AppRow> = {}): AppRow {
  const row: AppRow = {
    id: `app-${++appSeq}`,
    trashSpecId,
    arrInstance,
    enabled: true,
    remoteId: null,
    appliedAt: null,
    lastError: null,
    lastErrorAt: null,
    errorCount: 0,
    ...extra,
  };
  appRows.push(row);
  return row;
}
function findApp(trashSpecId: string, arrInstance: string): AppRow | undefined {
  return appRows.find((a) => a.trashSpecId === trashSpecId && a.arrInstance === arrInstance);
}

beforeEach(() => {
  settings.clear();
  settingUpserts.length = 0;
  settingDeletes.length = 0;
  specRows.length = 0;
  appRows.length = 0;
  specUpserts.length = 0;
  txCalls.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  specSeq = 0;
  appSeq = 0;
  appCreateConflictOnce = false;
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── describeSchemaError ─────────────────────────────────────────────────────

test("describeSchemaError maps missing trash tables/enum values to db-push hints and everything else to null", () => {
  assert.match(
    describeSchemaError(new Error('relation "public.TrashSpec" does not exist')) ?? "",
    /TrashSpec\/TrashApplication tables are missing/,
  );
  assert.match(
    describeSchemaError(new Error('relation "TrashApplication" does not exist')) ?? "",
    /npx prisma db push/,
  );
  assert.match(
    describeSchemaError(Object.assign(new Error("weird driver failure"), { code: "42P01" })) ?? "",
    /relation referenced by trash-sync does not exist/,
  );
  assert.match(
    describeSchemaError(
      new Error('invalid input value for enum "TrashSpecKind": "CUSTOM_FORMAT_GROUP"'),
    ) ?? "",
    /CUSTOM_FORMAT_GROUP/,
  );
  // Non-schema errors and non-Errors are not translated.
  assert.equal(describeSchemaError(new Error("connect ECONNREFUSED")), null);
  assert.equal(describeSchemaError("relation TrashSpec does not exist"), null);
  assert.equal(describeSchemaError(null), null);
});

// ── refreshCatalog: fetch layer + TrashSpec caching ─────────────────────────

const CF_PAYLOAD = {
  trash_id: "cf-x265",
  name: "x265",
  trash_scores: { default: 100 },
  specifications: [{ name: "spec", implementation: "X", fields: [{ name: "value", value: 1 }] }],
};
const GROUP_PAYLOAD = {
  trash_id: "grp-hdr",
  name: "HDR Formats",
  trash_description: "Group of HDR formats",
  custom_formats: [{ name: "DV", trash_id: "cf-dv", required: true }],
};
const NAMING_PAYLOAD = { file: { standard: "{Movie Title}" }, folder: { default: "{Movie Folder}" } };
const QP_PAYLOAD = { trash_id: "qp-1", name: "HD Bluray + WEB", items: [], formatItems: {} };
const QS_PAYLOAD = {
  trash_id: "qs-movie",
  type: "movie",
  qualities: [{ quality: "Bluray-1080p", min: 50, max: 227 }],
};

const FULL_RADARR_TREE = [
  blob("docs/json/radarr/cf/x265.json", "sha-cf1"),
  blob("docs/json/radarr/cf-groups/hdr.json", "sha-grp1"),
  blob("docs/json/radarr/naming/radarr-naming.json", "sha-naming"),
  blob("docs/json/radarr/quality-profiles/hd-bluray-web.json", "sha-qp1"),
  blob("docs/json/radarr/quality-size/movie.json", "sha-qs1"),
  // Must all be ignored for a RADARR refresh: other service, non-json, dir entry.
  blob("docs/json/sonarr/cf/other.json", "sha-sonarr"),
  blob("docs/json/radarr/cf/readme.md", "sha-md"),
  { path: "docs/json/radarr/cf", sha: "sha-dir", type: "tree" },
];
const FULL_RADARR_FILES = {
  "docs/json/radarr/cf/x265.json": CF_PAYLOAD,
  "docs/json/radarr/cf-groups/hdr.json": GROUP_PAYLOAD,
  "docs/json/radarr/naming/radarr-naming.json": NAMING_PAYLOAD,
  "docs/json/radarr/quality-profiles/hd-bluray-web.json": QP_PAYLOAD,
  "docs/json/radarr/quality-size/movie.json": QS_PAYLOAD,
};

test("refreshCatalog pulls the exact tree + raw URLs, upserts every spec kind, and clears the truncation flag", async () => {
  respond = router(ghRoutes(FULL_RADARR_TREE, FULL_RADARR_FILES));
  const result = await refreshCatalog("RADARR");

  assert.equal(result.service, "RADARR");
  assert.deepEqual(result.customFormats, { fetched: 1, updated: 1, unchanged: 0 });
  assert.deepEqual(result.customFormatGroups, { fetched: 1, updated: 1, unchanged: 0 });
  assert.deepEqual(result.naming, { fetched: 1, updated: 1 });
  assert.deepEqual(result.qualityProfiles, { fetched: 1, updated: 1 });
  assert.deepEqual(result.qualitySizes, { fetched: 1, updated: 1 });
  assert.deepEqual(result.errors, []);
  assert.equal("validationSkipped" in result, false);

  // Wire: one recursive tree call with the gh media-type headers and NO auth.
  const tree = fetchCalls[0];
  assert.equal(callKey(tree), TREE_KEY);
  assert.equal(tree.url.searchParams.get("recursive"), "1");
  assert.equal(tree.headers.get("accept"), "application/vnd.github+json");
  assert.equal(tree.headers.get("user-agent"), "Summonarr-TrashSync/0.1");
  assert.equal(tree.headers.get("authorization"), null);
  // Exactly the five RADARR .json blobs are fetched raw — the sonarr file, the
  // .md file, and the tree entry are all filtered out.
  const rawPaths = fetchCalls
    .filter((c) => c.url.hostname === "raw.githubusercontent.com")
    .map((c) => c.url.pathname.replace("/TRaSH-Guides/Guides/master/", ""));
  assert.deepEqual(rawPaths.sort(), Object.keys(FULL_RADARR_FILES).sort());
  assert.equal(fetchCalls.length, 6);

  // DB: one row per kind with the upstream identity + payload carried through.
  const byKind = new Map(specRows.map((r) => [r.kind, r]));
  assert.equal(specRows.length, 5);
  const cf = byKind.get("CUSTOM_FORMAT")!;
  assert.equal(cf.trashId, "cf-x265");
  assert.equal(cf.name, "x265");
  assert.equal(cf.upstreamPath, "docs/json/radarr/cf/x265.json");
  assert.equal(cf.upstreamSha, "sha-cf1");
  assert.deepEqual(cf.payload, CF_PAYLOAD);
  assert.ok(cf.fetchedAt instanceof Date);
  const group = byKind.get("CUSTOM_FORMAT_GROUP")!;
  assert.equal(group.trashId, "grp-hdr");
  assert.equal(group.description, "Group of HDR formats");
  const naming = byKind.get("NAMING")!;
  assert.equal(naming.trashId, "default");
  assert.equal(naming.name, "TRaSH Standard Naming");
  assert.equal(byKind.get("QUALITY_PROFILE")!.trashId, "qp-1");
  const qs = byKind.get("QUALITY_SIZE")!;
  assert.equal(qs.trashId, "qs-movie");
  assert.equal(qs.name, "movie"); // name falls back to the payload `type`

  // Guardrail 4: every batched upsert transaction carries BATCH_TX_TIMEOUT
  // (cf, cf-group, quality-profile, quality-size; naming upserts outside a tx).
  assert.equal(txCalls.length, 4);
  for (const opts of txCalls) assert.equal(opts?.timeout, BATCH_TX_TIMEOUT);

  // A non-truncated tree clears the persisted truncation marker.
  assert.deepEqual(settingDeletes, ["trashLastRefreshTruncatedAt"]);
  assert.equal(settings.has("trashLastRefreshTruncatedAt"), false);
});

test("a configured trashGithubToken authenticates BOTH the tree call and the raw file fetches", async () => {
  settings.set("trashGithubToken", "gh-token-123");
  respond = router(
    ghRoutes([blob("docs/json/radarr/cf/x265.json", "sha-cf1")], {
      "docs/json/radarr/cf/x265.json": CF_PAYLOAD,
    }),
  );
  await refreshCatalog("RADARR");
  const treeCall = fetchCalls.find((c) => c.url.hostname === "api.github.com")!;
  const rawCall = fetchCalls.find((c) => c.url.hostname === "raw.githubusercontent.com")!;
  assert.equal(treeCall.headers.get("authorization"), "token gh-token-123");
  assert.equal(rawCall.headers.get("authorization"), "token gh-token-123");
});

test("specs whose upstreamSha is unchanged are counted but not re-upserted; a changed sha still updates", async () => {
  seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-x265", sha: "sha-cf1" });
  seedSpec({ service: "RADARR", kind: "NAMING", trashId: "default", sha: "sha-naming" });
  seedSpec({ service: "RADARR", kind: "QUALITY_PROFILE", trashId: "qp-1", sha: "sha-stale" });
  respond = router(
    ghRoutes(
      [
        blob("docs/json/radarr/cf/x265.json", "sha-cf1"),
        blob("docs/json/radarr/naming/radarr-naming.json", "sha-naming"),
        blob("docs/json/radarr/quality-profiles/hd-bluray-web.json", "sha-qp2"),
      ],
      {
        "docs/json/radarr/cf/x265.json": CF_PAYLOAD,
        "docs/json/radarr/naming/radarr-naming.json": NAMING_PAYLOAD,
        "docs/json/radarr/quality-profiles/hd-bluray-web.json": QP_PAYLOAD,
      },
    ),
  );
  const result = await refreshCatalog("RADARR");
  assert.deepEqual(result.customFormats, { fetched: 1, updated: 0, unchanged: 1 });
  assert.deepEqual(result.naming, { fetched: 1, updated: 0 });
  assert.deepEqual(result.qualityProfiles, { fetched: 1, updated: 1 }); // sha-stale → sha-qp2
  assert.equal(specUpserts.length, 1);
  assert.equal(specUpserts[0].where.service_kind_trashId.kind, "QUALITY_PROFILE");
  assert.equal(specRows.find((r) => r.kind === "QUALITY_PROFILE")!.upstreamSha, "sha-qp2");
});

test("a malformed file and a validator-rejected file are isolated per file; only shape mismatches count as validationSkipped", async () => {
  respond = router(
    ghRoutes(
      [
        blob("docs/json/radarr/cf/good.json", "sha-good"),
        blob("docs/json/radarr/cf/bad.json", "sha-bad"),
        blob("docs/json/radarr/cf/invalid.json", "sha-invalid"),
      ],
      {
        "docs/json/radarr/cf/good.json": CF_PAYLOAD,
        "docs/json/radarr/cf/bad.json": "this is not json{",
        "docs/json/radarr/cf/invalid.json": { name: "missing trash_id" },
      },
    ),
  );
  const result = await refreshCatalog("RADARR");
  // Only the good file counts as fetched and lands in the catalog.
  assert.deepEqual(result.customFormats, { fetched: 1, updated: 1, unchanged: 0 });
  assert.equal(result.validationSkipped, 1); // the shape mismatch, NOT the parse error
  assert.deepEqual(specRows.map((r) => r.trashId), ["cf-x265"]);
  const cfErrors = result.errors.filter((e) => e.startsWith("cf: "));
  assert.equal(cfErrors.length, 2);
  assert.ok(
    cfErrors.some((e) => e.includes("cf payload shape mismatch: docs/json/radarr/cf/invalid.json")),
    "the validator reject must name the offending file",
  );
  // The naming file is absent from this tree — surfaced as an error, not a throw.
  assert.ok(
    result.errors.includes("naming: upstream file missing (docs/json/radarr/naming/radarr-naming.json)"),
  );
});

test("a truncated tree warns with the [trash] scope and persists the truncation timestamp until a clean run", async () => {
  respond = router(
    ghRoutes(
      [blob("docs/json/radarr/cf/x265.json", "sha-cf1")],
      { "docs/json/radarr/cf/x265.json": CF_PAYLOAD },
      { truncated: true },
    ),
  );
  const result = await refreshCatalog("RADARR");
  assert.ok(warns.some((w) => w.includes("[trash] tree truncated for TRaSH-Guides/Guides@master")));
  assert.ok(settings.has("trashLastRefreshTruncatedAt"));
  assert.ok(!Number.isNaN(Date.parse(settings.get("trashLastRefreshTruncatedAt")!)));
  // The refresh itself still proceeds over whatever entries did arrive.
  assert.deepEqual(result.customFormats, { fetched: 1, updated: 1, unchanged: 0 });

  // A later non-truncated run clears the marker.
  respond = router(
    ghRoutes([blob("docs/json/radarr/cf/x265.json", "sha-cf1")], {
      "docs/json/radarr/cf/x265.json": CF_PAYLOAD,
    }),
  );
  await refreshCatalog("RADARR");
  assert.equal(settings.has("trashLastRefreshTruncatedAt"), false);
});

test("a non-2xx tree response makes refreshCatalog throw with the status and body excerpt", async () => {
  respond = router({
    [TREE_KEY]: () => new Response("API rate limit exceeded", { status: 403 }),
  });
  await assert.rejects(
    () => refreshCatalog("RADARR"),
    /GitHub tree fetch failed for TRaSH-Guides\/Guides@master: 403 API rate limit exceeded/,
  );
});

// ── applyCustomFormats ──────────────────────────────────────────────────────

test("a new custom format POSTs the exact normalized body and records the returned remoteId", async () => {
  configureRadarr();
  const spec = seedSpec({
    service: "RADARR",
    kind: "CUSTOM_FORMAT",
    trashId: "cf-dv",
    name: "DV",
    payload: {
      trash_id: "cf-dv",
      name: "DV",
      specifications: [
        // Object-keyed fields (a real TRaSH shape) must become the array form.
        { name: "HDR", implementation: "ReleaseTitleSpecification", fields: { value: 16 } },
        // Already-array fields pass through untouched.
        { name: "already-array", fields: [{ name: "value", value: 3 }] },
        // No fields at all → empty array, not undefined.
        { name: "no-fields" },
        // Non-object entries pass through verbatim (validator doesn't reject them).
        "loose",
      ],
    },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR}/api/v3/customformat`]: () => json({ id: 42 }),
  });

  const results = await applyCustomFormats("RADARR", [spec.id]);
  assert.deepEqual(results, [
    { specId: spec.id, kind: "CUSTOM_FORMAT", trashId: "cf-dv", name: "DV", ok: true, remoteId: 42 },
  ]);

  const post = fetchCalls.find((c) => c.method === "POST")!;
  assert.equal(post.headers.get("x-api-key"), "radarr-key");
  assert.equal(post.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(post.body!), {
    name: "DV",
    includeCustomFormatWhenRenaming: false,
    specifications: [
      { name: "HDR", implementation: "ReleaseTitleSpecification", fields: [{ name: "value", value: 16 }] },
      { name: "already-array", fields: [{ name: "value", value: 3 }] },
      { name: "no-fields", fields: [] },
      "loose",
    ],
  });

  const app = findApp(spec.id, "")!;
  assert.equal(app.remoteId, 42);
  assert.equal(app.enabled, true);
  assert.equal(app.errorCount, 0);
  assert.equal(app.lastError, null);
  assert.ok(app.appliedAt instanceof Date);
});

test("a stored remoteId and a name-matched remote CF both take the PUT path — no duplicate POST", async () => {
  configureRadarr();
  const known = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-a", name: "A",
    payload: { trash_id: "cf-a", name: "A" },
  });
  seedApp(known.id, "", { remoteId: 7 });
  const nameMatched = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-b", name: "B",
    payload: { trash_id: "cf-b", name: "B" },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([{ id: 9, name: "B" }]),
    [`PUT ${RADARR}/api/v3/customformat/7`]: () => json({ id: 7 }),
    [`PUT ${RADARR}/api/v3/customformat/9`]: () => json({ id: 9 }),
  });

  const results = await applyCustomFormats("RADARR", [known.id, nameMatched.id]);
  assert.deepEqual(
    results.map((r) => [r.trashId, r.ok, r.remoteId]),
    [["cf-a", true, 7], ["cf-b", true, 9]],
  );
  assert.equal(fetchCalls.filter((c) => c.method === "POST").length, 0);
  // PUT bodies embed the target id alongside the payload body.
  const putBodies = fetchCalls.filter((c) => c.method === "PUT").map((c) => JSON.parse(c.body!) as { id: number });
  assert.deepEqual(putBodies.map((b) => b.id), [7, 9]);
  // The name-matched spec's application now remembers the discovered remoteId.
  assert.equal(findApp(nameMatched.id, "")!.remoteId, 9);
});

test("PUT 404 recovers with a POST recreate and surfaces the recreated flag", async () => {
  configureRadarr();
  const spec = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-gone", name: "Gone",
    payload: { trash_id: "cf-gone", name: "Gone" },
  });
  seedApp(spec.id, "", { remoteId: 77 });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`PUT ${RADARR}/api/v3/customformat/77`]: () => new Response("NotFound", { status: 404 }),
    [`POST ${RADARR}/api/v3/customformat`]: () => json({ id: 88 }),
  });

  const results = await applyCustomFormats("RADARR", [spec.id]);
  assert.deepEqual(results, [
    { specId: spec.id, kind: "CUSTOM_FORMAT", trashId: "cf-gone", name: "Gone", ok: true, remoteId: 88, recreated: true },
  ]);
  // The recreate POST body must NOT carry the stale id.
  const post = fetchCalls.find((c) => c.method === "POST")!;
  assert.equal("id" in (JSON.parse(post.body!) as object), false);
  assert.equal(findApp(spec.id, "")!.remoteId, 88);
});

test("a failed remote-CF prefetch fails the whole batch instead of blind-POSTing duplicates", async () => {
  configureRadarr();
  const a = seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-a" });
  const b = seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-b" });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => new Response("boom", { status: 500 }),
  });

  const results = await applyCustomFormats("RADARR", [a.id, b.id]);
  assert.deepEqual(
    results.map((r) => [r.trashId, r.ok, r.error]),
    [
      ["cf-a", false, "Could not read existing custom formats from the *arr instance"],
      ["cf-b", false, "Could not read existing custom formats from the *arr instance"],
    ],
  );
  assert.equal(fetchCalls.length, 1); // only the prefetch — no writes were attempted
  assert.ok(warns.some((w) => w.includes("[trash] failed to prefetch remote customformat list")));
  assert.equal(findApp(a.id, "")!.errorCount, 1);
  assert.equal(findApp(b.id, "")!.lastError, "Could not read existing custom formats from the *arr instance");
});

test("one failing spec doesn't abort its siblings, and the arr validation body is formatted into the error", async () => {
  configureRadarr();
  const failing = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-p", name: "P",
    payload: { trash_id: "cf-p", name: "P" },
  });
  const passing = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-q", name: "Q",
    payload: { trash_id: "cf-q", name: "Q" },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR}/api/v3/customformat`]: (c) =>
      (JSON.parse(c.body!) as { name: string }).name === "P"
        ? json([{ propertyName: "Name", errorMessage: "Must be unique" }], 400)
        : json({ id: 5 }),
  });

  const results = await applyCustomFormats("RADARR", [failing.id, passing.id]);
  assert.deepEqual(
    results.map((r) => [r.trashId, r.ok, r.error ?? r.remoteId]),
    [["cf-p", false, "400 — Name: Must be unique"], ["cf-q", true, 5]],
  );
  assert.equal(findApp(failing.id, "")!.errorCount, 1);
  assert.ok(findApp(failing.id, "")!.lastErrorAt instanceof Date);
  assert.equal(findApp(passing.id, "")!.errorCount, 0);
});

test("the variant slug scopes settings, wire target, and application rows; unconfigured instances throw labeled errors", async () => {
  // Unconfigured: default and named instances raise distinct labels.
  await assert.rejects(() => applyCustomFormats("RADARR", []), /RADARR is not configured/);
  await assert.rejects(() => applyCustomFormats("RADARR", [], "uhd"), /RADARR \(uhd\) is not configured/);

  // Configured but no matching specs: empty result, no arr traffic.
  configureRadarr();
  assert.deepEqual(await applyCustomFormats("RADARR", ["no-such-spec"]), []);
  assert.equal(fetchCalls.length, 0);

  // The "anime" slug resolves the radarrAnime* Setting keys and stamps its own arrInstance.
  configureRadarrAnime();
  const spec = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-anime", name: "Anime CF",
    payload: { trash_id: "cf-anime", name: "Anime CF" },
  });
  respond = router({
    [`GET ${RADARR_ANIME}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR_ANIME}/api/v3/customformat`]: () => json({ id: 3 }),
  });
  const results = await applyCustomFormats("RADARR", [spec.id], "anime");
  assert.deepEqual(results.map((r) => [r.ok, r.remoteId]), [[true, 3]]);
  for (const c of fetchCalls) {
    assert.equal(c.url.origin, RADARR_ANIME);
    assert.equal(c.headers.get("x-api-key"), "anime-key");
  }
  assert.equal(findApp(spec.id, "anime")!.remoteId, 3);
  assert.equal(findApp(spec.id, ""), undefined); // never touches the default instance's rows
});

test("recordApply failure bookkeeping survives the update-P2025 → create-P2002 race and still counts this attempt", async () => {
  configureRadarr();
  const spec = seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-race" });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => new Response("down", { status: 503 }),
  });
  appCreateConflictOnce = true; // a concurrent writer wins the create between our update and create

  const results = await applyCustomFormats("RADARR", [spec.id]);
  assert.equal(results[0].ok, false);
  const app = findApp(spec.id, "")!;
  // Winner's create tallied 1; our follow-up update must increment on top of it
  // and overwrite lastError with THIS attempt's failure.
  assert.equal(app.errorCount, 2);
  assert.equal(app.lastError, "Could not read existing custom formats from the *arr instance");
});

// ── applyNaming ─────────────────────────────────────────────────────────────

test("Radarr naming merges the patch over the FULL fetched config (arr requires every field on PUT)", async () => {
  configureRadarr();
  const spec = seedSpec({
    service: "RADARR", kind: "NAMING", trashId: "default", name: "TRaSH Standard Naming",
    payload: { file: { standard: "STD-FMT" }, folder: { default: "FOLDER-FMT" } },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/config/naming`]: () =>
      json({ id: 1, colonReplacementFormat: 4, renameMovies: false, standardMovieFormat: "old", movieFolderFormat: "old-folder" }),
    [`PUT ${RADARR}/api/v3/config/naming`]: () => json({}),
  });

  const results = await applyNaming("RADARR", [spec.id]);
  assert.deepEqual(results.map((r) => [r.ok, r.trashId]), [[true, "default"]]);
  const put = fetchCalls.find((c) => c.method === "PUT")!;
  assert.deepEqual(JSON.parse(put.body!), {
    id: 1,
    colonReplacementFormat: 4, // unrelated field preserved from the GET
    renameMovies: true,
    replaceIllegalCharacters: true,
    standardMovieFormat: "STD-FMT",
    movieFolderFormat: "FOLDER-FMT",
  });
  assert.ok(findApp(spec.id, "")!.appliedAt instanceof Date);
});

test("Sonarr naming descends nested episode variants to .default, keeps string forms, and shares one failure across the batch", async () => {
  configureSonarr();
  const spec = seedSpec({
    service: "SONARR", kind: "NAMING", trashId: "default", name: "TRaSH Standard Naming",
    payload: {
      series: { default: "SER-FMT" },
      season: { default: "SEA-FMT" },
      episodes: {
        standard: { default: "STD-FMT" }, // object keyed by variant → descend to .default
        daily: "DAILY-FMT",               // legacy string form → used directly
        anime: { default: "ANI-FMT" },
      },
    },
  });
  respond = router({
    [`GET ${SONARR}/api/v3/config/naming`]: () => json({ id: 3, keep: "me", renameEpisodes: false }),
    [`PUT ${SONARR}/api/v3/config/naming`]: () => json({}),
  });

  const results = await applyNaming("SONARR", [spec.id]);
  assert.equal(results[0].ok, true);
  const put = fetchCalls.find((c) => c.method === "PUT")!;
  assert.deepEqual(JSON.parse(put.body!), {
    id: 3,
    keep: "me",
    renameEpisodes: true,
    replaceIllegalCharacters: true,
    standardEpisodeFormat: "STD-FMT",
    dailyEpisodeFormat: "DAILY-FMT",
    animeEpisodeFormat: "ANI-FMT",
    seriesFolderFormat: "SER-FMT",
    seasonFolderFormat: "SEA-FMT",
  });

  // Failure path: an object error body is formatted "status — message" and
  // recorded against every spec in the batch.
  respond = router({
    [`GET ${SONARR}/api/v3/config/naming`]: () => json({ id: 3 }),
    [`PUT ${SONARR}/api/v3/config/naming`]: () => json({ message: "kaboom" }, 500),
  });
  const failed = await applyNaming("SONARR", [spec.id]);
  assert.deepEqual(failed.map((r) => [r.ok, r.error]), [[false, "500 — kaboom"]]);
  assert.equal(findApp(spec.id, "")!.errorCount, 1);
});

// ── applyQualitySizes ───────────────────────────────────────────────────────

test("quality sizes merge into the remote definitions with last-writer-wins per quality name", async () => {
  configureRadarr();
  const first = seedSpec({
    service: "RADARR", kind: "QUALITY_SIZE", trashId: "qs-a",
    payload: {
      trash_id: "qs-a",
      qualities: [
        { quality: "Bluray-1080p", min: 10, max: 100, preferred: 50 },
        { quality: "HDTV-720p", min: 1, max: 20 }, // no preferred → key stays absent
      ],
    },
  });
  const second = seedSpec({
    service: "RADARR", kind: "QUALITY_SIZE", trashId: "qs-b",
    payload: {
      trash_id: "qs-b",
      qualities: [{ quality: "Bluray-1080p", min: 55, max: 227, preferred: 194 }],
    },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/qualitydefinition`]: () =>
      json([
        { id: 1, quality: { id: 10, name: "Bluray-1080p" }, title: "Bluray-1080p", weight: 1, minSize: 2, maxSize: 3, preferredSize: 2.5 },
        { id: 2, quality: { id: 11, name: "HDTV-720p" }, title: "HDTV-720p", weight: 2, minSize: 4, maxSize: 5 },
        { id: 3, quality: { id: 12, name: "Unknown" }, title: "Unknown", weight: 3, minSize: 0, maxSize: 1 },
      ]),
    [`PUT ${RADARR}/api/v3/qualitydefinition/update`]: () => json([]),
  });

  const results = await applyQualitySizes("RADARR", [first.id, second.id]);
  assert.deepEqual(results.map((r) => [r.trashId, r.ok]), [["qs-a", true], ["qs-b", true]]);
  const put = fetchCalls.find((c) => c.method === "PUT")!;
  assert.deepEqual(JSON.parse(put.body!), [
    // second spec overwrote the first's Bluray-1080p entry (last writer wins)
    { id: 1, quality: { id: 10, name: "Bluray-1080p" }, title: "Bluray-1080p", weight: 1, minSize: 55, maxSize: 227, preferredSize: 194 },
    { id: 2, quality: { id: 11, name: "HDTV-720p" }, title: "HDTV-720p", weight: 2, minSize: 1, maxSize: 20 },
    // qualities no spec references are passed back verbatim
    { id: 3, quality: { id: 12, name: "Unknown" }, title: "Unknown", weight: 3, minSize: 0, maxSize: 1 },
  ]);
});

// ── applyQualityProfiles / buildProfileBody ─────────────────────────────────

test("applyQualityProfiles builds the full body: schema carry, allowed items, group cutoff, scores, trash_id mapping, dep auto-apply", async () => {
  configureRadarr();
  const cfDv = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-dv", name: "DV",
    payload: { trash_id: "cf-dv", name: "DV", trash_scores: { default: 1500, "sqp-1-1080p": 1000 } },
  });
  seedApp(cfDv.id, "", { remoteId: 21 }); // already applied on this instance
  const cfBad = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-bad", name: "BadCF",
    payload: { trash_id: "cf-bad", name: "BadCF", trash_scores: { default: -10000 } },
  });
  const qp = seedSpec({
    service: "RADARR", kind: "QUALITY_PROFILE", trashId: "qp-1", name: "SQP-1",
    payload: {
      trash_id: "qp-1",
      name: "SQP-1",
      upgradeAllowed: true,
      cutoff: "WEB 1080p",
      cutoffFormatScore: 10000,
      minFormatScore: 0,
      minUpgradeFormatScore: 5000,
      language: "any",
      score_set: "sqp-1-1080p",
      items: [
        { name: "Bluray-1080p", allowed: true },
        { name: "WEB 1080p", allowed: true, items: ["WEBDL-1080p", "WEBRip-1080p"] },
        { name: "DVD", allowed: false },
      ],
      formatItems: { DV: "cf-dv", BadCF: "cf-bad" },
    },
  });

  // Remote CF list is stateful: the dependency cascade POSTs BadCF, and the
  // later remoteCfs read must see it to build formatItems.
  const remoteCfList: Array<{ id: number; name: string; specifications?: unknown[] }> = [
    { id: 21, name: "DV" },
    // A CF Summonarr never applied, carrying trash_id metadata in its spec fields.
    { id: 50, name: "External", specifications: [{ fields: [{ name: "trash_id", value: "cf-ext" }] }] },
  ];
  respond = router({
    [`GET ${RADARR}/api/v3/qualityprofile`]: () => json([]),
    [`GET ${RADARR}/api/v3/qualityprofile/schema`]: () =>
      json({
        schemaExtra: "carried",
        upgradeAllowed: false,
        minFormatScore: 99,
        items: [
          { quality: { id: 1, name: "DVD" }, allowed: false },
          { quality: { id: 2, name: "Bluray-1080p" }, allowed: false },
          {
            id: 1001, name: "WEB 1080p", allowed: false,
            items: [
              { quality: { id: 3, name: "WEBDL-1080p" }, allowed: false },
              { quality: { id: 4, name: "WEBRip-1080p" }, allowed: false },
              { quality: { id: 5, name: "WEBDL-720p" }, allowed: false },
            ],
          },
          { id: 1002, name: "Legacy Group", allowed: false, items: [{ quality: { id: 6, name: "SDTV" }, allowed: false }] },
        ],
        formatItems: [],
      }),
    [`GET ${RADARR}/api/v3/language`]: () => json([{ id: 1, name: "English" }, { id: 2, name: "Any" }]),
    [`GET ${RADARR}/api/v3/customformat`]: () => json(remoteCfList),
    [`POST ${RADARR}/api/v3/customformat`]: (c) => {
      remoteCfList.push({ id: 33, name: (JSON.parse(c.body!) as { name: string }).name });
      return json({ id: 33 });
    },
    [`POST ${RADARR}/api/v3/qualityprofile`]: () => json({ id: 61 }),
  });

  const results = await applyQualityProfiles("RADARR", [qp.id]);
  assert.deepEqual(results, [
    { specId: qp.id, kind: "QUALITY_PROFILE", trashId: "qp-1", name: "SQP-1", ok: true, remoteId: 61 },
  ]);

  const post = fetchCalls.find((c) => callKey(c) === `POST ${RADARR}/api/v3/qualityprofile`)!;
  const body = JSON.parse(post.body!) as Record<string, unknown>;
  assert.equal(body.schemaExtra, "carried"); // schema fields not overridden survive
  assert.equal(body.name, "SQP-1");
  assert.equal(body.upgradeAllowed, true);
  assert.equal(body.minFormatScore, 0); // profile value beats the schema's 99
  assert.equal(body.cutoffFormatScore, 10000);
  assert.equal(body.minUpgradeFormatScore, 5000);
  assert.equal(body.cutoff, 1001); // the WEB 1080p GROUP id, not a quality id
  assert.deepEqual(body.language, { id: 2, name: "Any" });
  assert.deepEqual(body.items, [
    { quality: { id: 1, name: "DVD" }, allowed: false },
    { quality: { id: 2, name: "Bluray-1080p" }, allowed: true },
    {
      id: 1001, name: "WEB 1080p", allowed: true,
      items: [
        { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
        { quality: { id: 4, name: "WEBRip-1080p" }, allowed: true },
        { quality: { id: 5, name: "WEBDL-720p" }, allowed: false }, // sub not named by the profile
      ],
    },
    { id: 1002, name: "Legacy Group", allowed: false, items: [{ quality: { id: 6, name: "SDTV" }, allowed: false }] },
  ]);
  assert.deepEqual(body.formatItems, [
    { format: 21, name: "DV", score: 1000 },       // score_set beats default (1500)
    { format: 50, name: "External", score: 0 },    // trash_id-mapped but unreferenced → 0
    { format: 33, name: "BadCF", score: -10000 },  // no score_set entry → default
  ]);

  // The missing dependency CF was auto-applied on this instance before the profile.
  assert.equal(findApp(cfBad.id, "")!.remoteId, 33);
  assert.equal(findApp(qp.id, "")!.remoteId, 61);
});

test("a failed remote-profile prefetch fails the profile batch with its own sentinel error", async () => {
  configureRadarr();
  const qp = seedSpec({
    service: "RADARR", kind: "QUALITY_PROFILE", trashId: "qp-1", name: "SQP-1",
    payload: { trash_id: "qp-1", name: "SQP-1" },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/qualityprofile`]: () => new Response("down", { status: 503 }),
  });
  const results = await applyQualityProfiles("RADARR", [qp.id]);
  assert.deepEqual(
    results.map((r) => [r.ok, r.error]),
    [[false, "Could not read existing quality profiles from the *arr instance"]],
  );
  assert.equal(fetchCalls.length, 1); // schema/language/cf reads never happen
  assert.ok(warns.some((w) => w.includes("[trash] failed to prefetch remote qualityprofile list")));
});

// ── applyCustomFormatGroups ─────────────────────────────────────────────────

test("a group cascades its member CFs through one apply batch and records only the group result", async () => {
  configureRadarr();
  const memberDv = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-dv", name: "DV",
    payload: { trash_id: "cf-dv", name: "DV" },
  });
  const memberOpt = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-opt", name: "Opt",
    payload: { trash_id: "cf-opt", name: "Opt" },
  });
  const group = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-hdr", name: "HDR Formats",
    payload: {
      trash_id: "grp-hdr",
      name: "HDR Formats",
      custom_formats: [
        { name: "DV", trash_id: "cf-dv", required: true },
        { name: "Opt", trash_id: "cf-opt", required: false },
      ],
    },
  });
  let nextId = 100;
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR}/api/v3/customformat`]: () => json({ id: ++nextId }),
  });

  const results = await applyCustomFormatGroups("RADARR", [group.id]);
  // Only the group's own result is returned — member results are internal.
  assert.deepEqual(results, [
    { specId: group.id, kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-hdr", name: "HDR Formats", ok: true },
  ]);
  // Both members were pushed exactly once.
  const postedNames = fetchCalls
    .filter((c) => c.method === "POST")
    .map((c) => (JSON.parse(c.body!) as { name: string }).name);
  assert.deepEqual(postedNames.sort(), ["DV", "Opt"]);
  assert.ok(findApp(memberDv.id, "")!.remoteId);
  assert.ok(findApp(memberOpt.id, "")!.remoteId);
  const groupApp = findApp(group.id, "")!;
  assert.equal(groupApp.remoteId, null); // groups have no arr-side resource
  assert.ok(groupApp.appliedAt instanceof Date);
});

test("group rollup: a required member failure fails the group; an optional member failure does not", async () => {
  configureRadarr();
  seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-reqok", name: "ReqOk", payload: { trash_id: "cf-reqok", name: "ReqOk" } });
  seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-optfail", name: "OptFail", payload: { trash_id: "cf-optfail", name: "OptFail" } });
  seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-reqfail", name: "ReqFail", payload: { trash_id: "cf-reqfail", name: "ReqFail" } });
  const g1 = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-1", name: "G1",
    payload: {
      trash_id: "grp-1", name: "G1",
      custom_formats: [
        { name: "ReqOk", trash_id: "cf-reqok", required: true },
        { name: "OptFail", trash_id: "cf-optfail", required: false },
      ],
    },
  });
  const g2 = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-2", name: "G2",
    payload: {
      trash_id: "grp-2", name: "G2",
      custom_formats: [{ name: "ReqFail", trash_id: "cf-reqfail", required: true }],
    },
  });
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR}/api/v3/customformat`]: (c) =>
      (JSON.parse(c.body!) as { name: string }).name === "ReqOk"
        ? json({ id: 11 })
        : new Response("boom", { status: 500 }),
  });

  const results = await applyCustomFormatGroups("RADARR", [g1.id, g2.id]);
  assert.deepEqual(
    results.map((r) => [r.trashId, r.ok, r.error]),
    [
      ["grp-1", true, undefined],
      ["grp-2", false, "Required CF apply failed: ReqFail"],
    ],
  );
  assert.equal(findApp(g2.id, "")!.errorCount, 1);
});

test("a group whose members are entirely absent from the catalog fails with the refresh hint and no arr traffic", async () => {
  // Deliberately NO radarr configuration: the missing-members path never
  // resolves an arr config, so it must work (and fail cleanly) regardless.
  const group = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-ghost", name: "Ghost",
    payload: {
      trash_id: "grp-ghost", name: "Ghost",
      custom_formats: [
        { name: "A", trash_id: "cf-ghost-a", required: true },
        { name: "B", trash_id: "cf-ghost-b", required: false },
      ],
    },
  });
  const results = await applyCustomFormatGroups("RADARR", [group.id]);
  assert.deepEqual(
    results.map((r) => [r.ok, r.error]),
    [[false, "No member custom formats found in catalog (2 expected). Refresh Catalog first."]],
  );
  assert.equal(fetchCalls.length, 0);
});

// ── applySpecs: kind ordering + member dedup ────────────────────────────────

test("applySpecs runs kinds in dependency order and dedups member CFs already cascaded by their group", async () => {
  configureRadarr();
  const member = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-member", name: "Member",
    payload: { trash_id: "cf-member", name: "Member" },
  });
  const solo = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-solo", name: "Solo",
    payload: { trash_id: "cf-solo", name: "Solo" },
  });
  const group = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT_GROUP", trashId: "grp-1", name: "G",
    payload: {
      trash_id: "grp-1", name: "G",
      custom_formats: [{ name: "Member", trash_id: "cf-member", required: true }],
    },
  });
  const naming = seedSpec({
    service: "RADARR", kind: "NAMING", trashId: "default", name: "TRaSH Standard Naming",
    payload: { file: { standard: "X" } },
  });
  const size = seedSpec({
    service: "RADARR", kind: "QUALITY_SIZE", trashId: "qs-1",
    payload: { trash_id: "qs-1", qualities: [{ quality: "Bluray-1080p", min: 5, max: 10 }] },
  });
  let nextId = 200;
  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([]),
    [`POST ${RADARR}/api/v3/customformat`]: () => json({ id: ++nextId }),
    [`GET ${RADARR}/api/v3/config/naming`]: () => json({ id: 1 }),
    [`PUT ${RADARR}/api/v3/config/naming`]: () => json({}),
    [`GET ${RADARR}/api/v3/qualitydefinition`]: () =>
      json([{ id: 1, quality: { id: 10, name: "Bluray-1080p" }, title: "t", weight: 1 }]),
    [`PUT ${RADARR}/api/v3/qualitydefinition/update`]: () => json([]),
  });

  // Pass everything, member CF included — the group's cascade must absorb it.
  const results = await applySpecs([group.id, member.id, solo.id, naming.id, size.id]);

  // Wire order pins the dependency ordering: group cascade first, then the
  // remaining standalone CF, then naming, then quality sizes.
  assert.deepEqual(
    fetchCalls.map((c) => `${c.method} ${c.url.pathname}`),
    [
      "GET /api/v3/customformat",              // group cascade prefetch
      "POST /api/v3/customformat",             // member CF (via the group)
      "GET /api/v3/customformat",              // standalone CF prefetch
      "POST /api/v3/customformat",             // solo CF
      "GET /api/v3/config/naming",
      "PUT /api/v3/config/naming",
      "GET /api/v3/qualitydefinition",
      "PUT /api/v3/qualitydefinition/update",
    ],
  );
  // The member CF was applied exactly once (by the cascade) and reports no
  // standalone result of its own.
  const postedNames = fetchCalls
    .filter((c) => c.method === "POST")
    .map((c) => (JSON.parse(c.body!) as { name: string }).name);
  assert.deepEqual(postedNames, ["Member", "Solo"]);
  assert.deepEqual(
    results.map((r) => r.trashId),
    ["grp-1", "cf-solo", "default", "qs-1"],
  );
});

// ── runTrashSync ────────────────────────────────────────────────────────────

test("runTrashSync is a no-op with the exact disabled sentinel when trashGuidesEnabled is not 'true'", async () => {
  const result = await runTrashSync();
  assert.deepEqual(result, { refreshed: [], applied: [], errors: ["trashGuidesEnabled is off"] });
  assert.equal(fetchCalls.length, 0);
});

test("the hourly cadence gate skips GitHub when the last refresh is fresh, and refreshes + restamps when stale", async () => {
  settings.set("trashGuidesEnabled", "true");
  const fresh = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  settings.set("trashLastRefreshAt", fresh);
  // No instances configured → the apply phase is also a no-op; ANY fetch throws.
  const gated = await runTrashSync();
  assert.deepEqual(gated, { refreshed: [], applied: [], errors: [] });
  assert.equal(fetchCalls.length, 0);
  assert.equal(settings.get("trashLastRefreshAt"), fresh); // not restamped on a gated run

  // Stale timestamp: both services refresh (one tree call each) and the stamp updates.
  settings.set("trashLastRefreshAt", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  respond = router(ghRoutes([], {}));
  const refreshedRun = await runTrashSync();
  assert.deepEqual(refreshedRun.refreshed.map((r) => r.service), ["RADARR", "SONARR"]);
  assert.equal(fetchCalls.filter((c) => c.url.hostname === "api.github.com").length, 2);
  // An empty tree still surfaces the per-service missing-naming errors, namespaced.
  assert.deepEqual(refreshedRun.errors, [
    "RADARR: naming: upstream file missing (docs/json/radarr/naming/radarr-naming.json)",
    "SONARR: naming: upstream file missing (docs/json/sonarr/naming/sonarr-naming.json)",
  ]);
  const stamped = settings.get("trashLastRefreshAt")!;
  assert.notEqual(stamped, fresh);
  assert.ok(Date.now() - Date.parse(stamped) < 60_000, "stamp must be from this run");
});

test("runTrashSync fans out per service and per configured instance, honors kind gating and enabled flags, and folds apply errors", async () => {
  settings.set("trashGuidesEnabled", "true");
  settings.set("trashLastRefreshAt", new Date().toISOString()); // gate the refresh — apply only
  settings.set("trashSyncNaming", "false"); // NAMING kind disabled for this run
  configureRadarr();
  configureRadarrAnime();
  configureSonarr();
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));

  const rcf = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-r", name: "R-CF",
    payload: { trash_id: "cf-r", name: "R-CF" },
  });
  seedApp(rcf.id, "", { remoteId: 5 });
  seedApp(rcf.id, "anime", { remoteId: 9 });
  const disabled = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-off", name: "Off",
    payload: { trash_id: "cf-off", name: "Off" },
  });
  seedApp(disabled.id, "", { enabled: false, remoteId: 6 });
  const rnaming = seedSpec({
    service: "RADARR", kind: "NAMING", trashId: "default", name: "TRaSH Standard Naming",
    payload: { file: { standard: "X" } },
  });
  seedApp(rnaming.id, ""); // enabled, but its kind is gated off
  const scf = seedSpec({
    service: "SONARR", kind: "CUSTOM_FORMAT", trashId: "cf-s", name: "S-CF",
    payload: { trash_id: "cf-s", name: "S-CF" },
  });
  seedApp(scf.id, "", { remoteId: 7 });

  respond = router({
    [`GET ${RADARR}/api/v3/customformat`]: () => json([{ id: 5, name: "R-CF" }]),
    [`PUT ${RADARR}/api/v3/customformat/5`]: () => json({ id: 5 }),
    [`GET ${RADARR_ANIME}/api/v3/customformat`]: () => json([]),
    [`PUT ${RADARR_ANIME}/api/v3/customformat/9`]: () => json({ id: 9 }),
    [`GET ${SONARR}/api/v3/customformat`]: () => json([]),
    [`PUT ${SONARR}/api/v3/customformat/7`]: () => json({ message: "kaboom" }, 500),
  });

  const result = await runTrashSync();
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(
    result.applied.map((r) => [r.trashId, r.ok, r.remoteId ?? r.error]),
    [
      ["cf-r", true, 5],           // radarr default instance
      ["cf-r", true, 9],           // radarr "anime" instance, its own remoteId
      ["cf-s", false, "500 — kaboom"], // sonarr default instance
    ],
  );
  assert.deepEqual(result.errors, ["apply cf-s: 500 — kaboom"]);

  // The disabled application and the gated NAMING kind never reach the wire.
  assert.equal(fetchCalls.some((c) => c.url.pathname.includes("config/naming")), false);
  assert.equal(fetchCalls.some((c) => c.body?.includes("Off")), false);
  // Each instance pass talks to its own base URL with its own key.
  const putOrigins = fetchCalls.filter((c) => c.method === "PUT").map((c) => c.url.origin);
  assert.deepEqual(putOrigins, [RADARR, RADARR_ANIME, SONARR]);
  assert.equal(findApp(scf.id, "")!.errorCount, 1);
  assert.ok(findApp(rcf.id, "anime")!.appliedAt instanceof Date);
});

test("a per-service refresh throw is contained: the other service still refreshes and partial success stamps the gate", async () => {
  settings.set("trashGuidesEnabled", "true"); // no trashLastRefreshAt → refresh due
  let treeCalls = 0;
  respond = (call) => {
    if (call.url.hostname === "api.github.com") {
      treeCalls++;
      return treeCalls === 1
        ? new Response("boom", { status: 500 }) // RADARR pass fails
        : json({ tree: [] });                   // SONARR pass succeeds
    }
    throw new Error(`unexpected fetch: ${callKey(call)}`);
  };

  const result = await runTrashSync();
  assert.deepEqual(result.refreshed.map((r) => r.service), ["SONARR"]);
  assert.ok(
    result.errors.some((e) => /^RADARR refresh: GitHub tree fetch failed .* 500 boom/.test(e)),
    `expected a namespaced RADARR refresh error, got: ${JSON.stringify(result.errors)}`,
  );
  // Partial success is deliberate: the gate records "we recently tried".
  assert.ok(settings.has("trashLastRefreshAt"));
});

// ── listSpecs / getSpecDetail ───────────────────────────────────────────────

test("listSpecs and getSpecDetail map rows per variant with ISO dates, null application, and null on a missing id", async () => {
  const spec = seedSpec({
    service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-a", name: "A",
    description: "desc", sha: "sha-1", path: "docs/json/radarr/cf/a.json",
    payload: { trash_id: "cf-a", name: "A" },
  });
  const appliedAt = new Date("2026-02-01T10:00:00.000Z");
  const lastErrorAt = new Date("2026-02-02T11:00:00.000Z");
  const defaultApp = seedApp(spec.id, "", {
    remoteId: 4, appliedAt, lastError: "old failure", lastErrorAt, errorCount: 2,
  });
  seedApp(spec.id, "anime", { remoteId: 8 });
  const bare = seedSpec({ service: "RADARR", kind: "CUSTOM_FORMAT", trashId: "cf-b", name: "B" });

  const list = await listSpecs("RADARR"); // default variant "hd" → the "" instance rows
  const a = list.find((s) => s.id === spec.id)!;
  assert.deepEqual(a.application, {
    id: defaultApp.id,
    enabled: true,
    remoteId: 4,
    appliedAt: "2026-02-01T10:00:00.000Z",
    lastError: "old failure",
    lastErrorAt: "2026-02-02T11:00:00.000Z",
    errorCount: 2,
  });
  assert.equal(a.fetchedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(a.description, "desc");
  assert.equal(list.find((s) => s.id === bare.id)!.application, null);

  // The variant filter selects that instance's application row.
  const animeList = await listSpecs("RADARR", "anime");
  assert.equal(animeList.find((s) => s.id === spec.id)!.application!.remoteId, 8);

  const detail = await getSpecDetail(spec.id);
  assert.equal(detail!.upstreamPath, "docs/json/radarr/cf/a.json");
  assert.equal(detail!.upstreamSha, "sha-1");
  assert.deepEqual(detail!.payload, { trash_id: "cf-a", name: "A" });
  assert.equal(detail!.application!.remoteId, 4);
  assert.equal(await getSpecDetail("no-such-id"), null);
});
