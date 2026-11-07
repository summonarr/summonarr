// The admin tool routes' documented response bodies (audit-log export, backup,
// the /admin/debug/* dumps, the play-time backfill, fix-match, the library
// warm, path samples, schema check, cache clear, library match check and bad
// matches) stay field for field what their handlers send. Each pin reads the
// handler, or the lib type it answers with, beside the served spec.

import {
  getSpec, specOp, responseSchema, keysOf, handlerSource, routeSource, libSource,
  interfaceFields, prismaModelFields, type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const { libraryPathFor } = await import("../src/lib/library-path-view.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { MDBLIST_PLAN_CHOICES } = await import("../src/lib/mdblist-plan.ts");

// ── local readers ──────────────────────────────────────────────────────────

const parse = (src: string) => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** An object literal's keys, conditional spreads `...(c ? { a } : {})` flattened in; other spreads as `...<expr>`. */
function flatKeys(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      let e: ts.Expression = p.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isConditionalExpression(e)) {
        for (const branch of [e.whenTrue, e.whenFalse]) {
          let b: ts.Expression = branch;
          while (ts.isParenthesizedExpression(b)) b = b.expression;
          if (ts.isObjectLiteralExpression(b)) out.push(...flatKeys(b, sf));
        }
      } else out.push(`...${e.getText(sf)}`);
      continue;
    }
    const n = p.name;
    out.push(n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : (n?.getText(sf) ?? "?"));
  }
  return [...new Set(out)].sort();
}

/** The flattened keys of every object literal in the source. */
function literalKeySets(src: string): string[][] {
  const sf = parse(src);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) out.push(flatKeys(n, sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The flattened keys of each `NextResponse.json({ … })` body, in source order. */
function bodyKeys(src: string): string[][] {
  const sf = parse(src);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ["NextResponse.json", "Response.json"].includes(n.expression.getText(sf))) {
      let arg = n.arguments[0];
      while (arg && (ts.isSatisfiesExpression(arg) || ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg))) arg = arg.expression;
      if (arg && ts.isObjectLiteralExpression(arg)) out.push(flatKeys(arg, sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The string-literal members of `type <name> = "a" | "b"` or a `<name>: "a" | "b"` field. */
function unionMembers(src: string, name: string): string[] {
  const m = new RegExp(`(?:type ${name} =|\\b${name}\\??:)\\s*((?:\\s*\\|?\\s*"[^"]+")+)`).exec(src);
  assert.ok(m, `union ${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

const without = (keys: string[], ...drop: string[]) => keys.filter((k) => !drop.includes(k));
const branch = (schema: SchemaNode, i: number) => {
  const b = schema.oneOf?.[i];
  assert.ok(b, `oneOf[${i}] missing`);
  return b;
};
const prop = (schema: SchemaNode | undefined, ...path: string[]): SchemaNode => {
  let s = schema;
  for (const k of path) s = k === "[]" ? s?.items : s?.properties?.[k];
  assert.ok(s, `no ${path.join(".")}`);
  return s;
};
function assertSomeLiteral(src: string, documented: string[], what: string) {
  const sets = literalKeySets(src).map((s) => JSON.stringify(s));
  assert.ok(sets.includes(JSON.stringify(documented)), `${what}: no object literal in the handler has exactly ${documented.join(",")}`);
}

// ── audit log export and backup ────────────────────────────────────────────

test("the audit-log export documents its CSV columns and its JSON rows, as the handler writes them", async () => {
  const op = await specOp("/admin/audit-log/export", "get");
  const csv = op.responses["200"].content?.["text/csv"]?.schema;
  const documented = /`(id,[\w,]+)`/.exec(csv?.description ?? "")?.[1];
  const written = /await write\("(id,[\w,]+)\\n"\)/.exec(handlerSource("/admin/audit-log/export", "get"))?.[1];
  assert.ok(documented && written);
  assert.equal(documented, written);
  const json = op.responses["200"].content?.["application/json"]?.schema;
  assert.equal(json?.type, "array");
  // Every row is the whole prisma row (JSON.stringify(log)), the same row the paged GET lists.
  assert.match(handlerSource("/admin/audit-log/export", "get"), /JSON\.stringify\(log\)/);
  assert.deepEqual(keysOf(json?.items), prismaModelFields("AuditLog", ["user"]));
  const paged = prop(await responseSchema("/admin/audit-log", "get", "200"), "logs", "[]");
  assert.deepEqual(json?.items, paged);
});

test("the backup export is an octet-stream and the restore's two 200 bodies are importResultResponse's", async () => {
  const exp = await specOp("/admin/backup/db-export", "get");
  assert.equal(exp.responses["200"].content?.["application/octet-stream"]?.schema?.format, "binary");
  assert.match(handlerSource("/admin/backup/db-export", "get"), /const contentType = "application\/octet-stream";/);

  const schema = await responseSchema("/admin/backup/db-import", "post", "200");
  const fn = libSource("backup-routes.ts").slice(libSource("backup-routes.ts").indexOf("export function importResultResponse"));
  const bodies = bodyKeys(fn.slice(0, fn.indexOf("\n}\n"))).map((k) => without(k, "...done"));
  // [ok, summary, errors] (failed statements), [error] (a non-200), [ok, summary, warning] (restored)
  assert.deepEqual(bodies, [["errors", "ok", "summary"], ["error"], ["ok", "summary", "warning"]]);
  assert.deepEqual(keysOf(branch(schema, 0)), bodies[2]);
  assert.deepEqual(keysOf(branch(schema, 1)), bodies[0]);
  assert.deepEqual(branch(schema, 0).properties?.ok.enum, [true]);
  assert.deepEqual(branch(schema, 1).properties?.ok.enum, [false]);
  const summaryFields = interfaceFields(libSource("backup-import.ts"), "BackupImportSummary");
  assert.deepEqual(keysOf(prop(branch(schema, 0), "summary")), summaryFields);
  assert.deepEqual(keysOf(prop(branch(schema, 1), "summary")), summaryFields);
});

// ── the debug dumps ────────────────────────────────────────────────────────

test("the arr-state dump documents every key it sends, its instance rows and the wanted-table row", async () => {
  const schema = await responseSchema("/admin/debug/arr-state", "get", "200");
  const src = handlerSource("/admin/debug/arr-state", "get");
  const top = bodyKeys(src).at(-1);
  assert.deepEqual(keysOf(schema), top);
  assert.deepEqual([...(schema.required ?? [])].sort(), top);
  // The per-instance row the mapLimit callback returns.
  assertSomeLiteral(src, keysOf(prop(schema, "instances", "[]")), "instances[]");
  // The wanted-table row is the stored prisma row; both models share its columns.
  const wanted = keysOf(prop(schema, "cacheTable", "row"));
  assert.deepEqual(wanted, prismaModelFields("RadarrWantedItem"));
  assert.deepEqual(wanted, prismaModelFields("SonarrWantedItem"));
  const select = /mediaRequest\.findMany\(\{[\s\S]*?select: \{([^}]*)\}/.exec(src)?.[1] ?? "";
  assert.deepEqual(keysOf(prop(schema, "mediaRequests", "[]")), [...select.matchAll(/(\w+): true/g)].map((m) => m[1]).sort());
  assertSomeLiteral(src, keysOf(prop(schema, "tvdbInfo", "cachedMappingRow")), "tvdbInfo.cachedMappingRow");
});

test("the ratings-state dump documents its keys, the MDBList budget and the cache rows — and only whether a key is set", async () => {
  const schema = await responseSchema("/admin/debug/ratings-state", "get", "200");
  const src = routeSource("/admin/debug/ratings-state");
  const handler = handlerSource("/admin/debug/ratings-state", "get");
  assert.deepEqual(keysOf(schema), bodyKeys(handler).at(-1));
  assert.deepEqual(keysOf(prop(schema, "mdblistUsage")), interfaceFields(libSource("mdblist.ts"), "MdblistUsageSnapshot"));
  assert.deepEqual(prop(schema, "mdblistUsage", "plan").enum, [...MDBLIST_PLAN_CHOICES]);
  const cacheRow = interfaceFields(src, "RatingsCacheReport");
  assert.deepEqual(keysOf(prop(schema, "cache", "mdblist")), cacheRow);
  assert.deepEqual(keysOf(prop(schema, "cache", "omdb")), cacheRow);
  assertSomeLiteral(handler, keysOf(prop(schema, "details", "fields")), "details.fields");
  assertSomeLiteral(handler, keysOf(prop(schema, "details")), "details");
  const live = keysOf(prop(schema, "live"));
  for (const k of [...interfaceFields(libSource("omdb-availability.ts"), "UnifiedRatingsResult"), "error"]) assert.ok(live.includes(k), `live lacks ${k}`);

  // The provider keys are decrypted on read: the dump answers only whether each
  // is set (a boolean), never the value.
  const providers = prop(schema, "providers");
  assert.deepEqual(keysOf(providers), ["mdblist", "omdb", "trakt"]);
  for (const k of keysOf(providers)) assert.equal(providers.properties?.[k].type, "boolean", k);
  const providerLiteral = /providers: \{([\s\S]*?)\},/.exec(handler)?.[1] ?? "";
  assert.equal([...providerLiteral.matchAll(/^\s+(\w+): !!\w+\?\.value\.trim\(\),$/gm)].length, 3, providerLiteral);
});

test("the history-link dump documents each list's rows as the handler builds them", async () => {
  const schema = await responseSchema("/admin/debug/history-link", "get", "200");
  const src = handlerSource("/admin/debug/history-link", "get");
  assert.deepEqual(keysOf(schema), bodyKeys(src).at(-1));
  assertSomeLiteral(src, keysOf(prop(schema, "user")), "user");
  assertSomeLiteral(src, keysOf(prop(schema, "orphanedWithHistory", "[]")), "orphanedWithHistory[]");
  assertSomeLiteral(src, keysOf(prop(schema, "allServerIdentities", "[]")), "allServerIdentities[]");
  // A candidate is the selected MediaServerUser columns (minus _count) plus the verdicts.
  const select = /select: \{([\s\S]*?)_count/.exec(src)?.[1] ?? "";
  const selected = [...select.matchAll(/(\w+): true/g)].map((m) => m[1]);
  const verdicts = without(flatKeysOfReturn(src, "candidates.map"), "...r", "_count");
  assert.deepEqual(keysOf(prop(schema, "candidates", "[]")), [...selected, ...verdicts].sort());
  assert.equal(prop(schema, "allServerIdentities").maxItems, Number(/take: (\d+),/.exec(src)?.[1]));
});

/** The flattened keys of the object literal returned by the first `<anchor>((r) => { … return { … } })`. */
function flatKeysOfReturn(src: string, anchor: string): string[] {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, anchor);
  const sf = parse(src.slice(at));
  let found: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) found = flatKeys(n.expression, sf);
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `no returned object literal after ${anchor}`);
  return found;
}

test("the play-time backfill documents its dry-run and execute answers and the five-row sample", async () => {
  const schema = await responseSchema("/admin/play-history/backfill-playtime", "post", "200");
  const src = handlerSource("/admin/play-history/backfill-playtime", "post");
  const bodies = bodyKeys(src);
  assert.deepEqual(keysOf(branch(schema, 0)), bodies[0], "dry run");
  assert.deepEqual(keysOf(branch(schema, 1)), bodies.at(-1), "execute");
  assertSomeLiteral(src, keysOf(prop(branch(schema, 0), "sample", "[]")), "sample[]");
  assert.match(src, /LIMIT 5`/);
  assert.equal(prop(branch(schema, 0), "sample").maxItems, 5);
});

// ── fix-match ──────────────────────────────────────────────────────────────

test("fix-match documents its synchronous answer, the 202, the job status and the job tray as sent", async () => {
  const jobs = libSource("fix-match-jobs.ts");
  const post = handlerSource("/admin/fix-match", "post");
  // 200: the job result minus the issue flag the synchronous answer strips.
  const result = await responseSchema("/admin/fix-match", "post", "200");
  assert.deepEqual(keysOf(result), without(interfaceFields(jobs, "FixMatchJobResult"), "issueResolved"));
  assert.match(post, /const \{ issueResolved: _issueResolved, \.\.\.syncResult \} = settled\.result;/);
  // 202: the two job answers (started, joined).
  const accepted = await responseSchema("/admin/fix-match", "post", "202");
  const started = bodyKeys(post).filter((k) => k.includes("jobId"));
  assert.deepEqual(started, [["jobId", "joined", "ok", "status"], ["jobId", "ok", "status"]]);
  assert.deepEqual(keysOf(accepted), started[0]);
  assert.deepEqual([...(accepted.required ?? [])].sort(), started[1]);

  const statusEnum = unionMembers(jobs, "FixMatchJobStatus");
  const status = await responseSchema("/admin/fix-match/status", "get", "200");
  assert.deepEqual(keysOf(status), bodyKeys(handlerSource("/admin/fix-match/status", "get")).at(-1));
  assert.deepEqual([...(prop(status, "status").enum ?? [])].sort(), statusEnum);
  assert.deepEqual(keysOf(prop(status, "progress")), interfaceFields(jobs, "FixMatchProgress"));
  assert.deepEqual([...(prop(status, "progress", "phase").enum ?? [])].sort(), unionMembers(jobs, "phase"));
  const statusResult = prop(status, "result");
  assert.deepEqual([...keysOf(statusResult.allOf?.[0]), ...keysOf(statusResult.allOf?.[1])].sort(), interfaceFields(jobs, "FixMatchJobResult"));

  const tray = prop(await responseSchema("/admin/fix-match/jobs", "get", "200"), "jobs", "[]");
  const trayHandler = handlerSource("/admin/fix-match/jobs", "get");
  assertSomeLiteral(trayHandler, keysOf(tray), "jobs[]");
  assertSomeLiteral(trayHandler, keysOf(prop(tray, "progress")), "jobs[].progress");
  // Coarse by design: no ratingKey, path or job key.
  for (const k of ["key", "ratingKey", "path", "filePath", "itemKey"]) assert.ok(!keysOf(tray).includes(k), k);
});

test("fix-match candidates and file-info document every field, and their paths as the caller's view (file name for a delegate)", async () => {
  const candidatesSrc = routeSource("/admin/fix-match/candidates");
  const candidates = await responseSchema("/admin/fix-match/candidates", "get", "200");
  assert.deepEqual(keysOf(candidates), interfaceFields(candidatesSrc, "CandidatesResponse"));
  const item = prop(candidates, "candidates", "[]");
  assert.deepEqual(keysOf(item), interfaceFields(candidatesSrc, "PlexCandidate"));
  assert.deepEqual([...(prop(item, "matchLevel").enum ?? [])].sort(), unionMembers(libSource("fix-match-scoring.ts"), "CandidateMatch"));

  const fileInfoSrc = routeSource("/admin/fix-match/file-info");
  const fileInfo = await responseSchema("/admin/fix-match/file-info", "get", "200");
  assert.deepEqual(keysOf(fileInfo), interfaceFields(fileInfoSrc, "FileInfoResponse"));
  for (const k of ["plexInstances", "jellyfinInstances"]) {
    assert.deepEqual(keysOf(prop(fileInfo, k, "[]")), interfaceFields(fileInfoSrc, "FileInfoInstance"), k);
  }

  // Guardrail 37f: both routes admit a MANAGE_ISSUES delegate, so every path
  // they answer goes through libraryPathFor — and the spec says so.
  const paths: Array<[string, SchemaNode]> = [
    ["candidates.plexFilePath", prop(candidates, "plexFilePath")],
    ["candidates.jellyfinFilePath", prop(candidates, "jellyfinFilePath")],
    ["file-info.plexFilePath", prop(fileInfo, "plexFilePath")],
    ["file-info.jellyfinFilePath", prop(fileInfo, "jellyfinFilePath")],
    ["file-info.plexInstances[].filePath", prop(fileInfo, "plexInstances", "[]", "filePath")],
    ["file-info.jellyfinInstances[].filePath", prop(fileInfo, "jellyfinInstances", "[]", "filePath")],
  ];
  for (const [where, s] of paths) {
    assert.match(s.description ?? "", /MANAGE_ISSUES delegate gets the file name only/, where);
    assert.match(s.description ?? "", /guardrail 37f/, where);
  }
  assert.equal(libraryPathFor(Permission.MANAGE_ISSUES, "/mnt/media/Movies/Dune (2021)/Dune.mkv"), "Dune.mkv");
  assert.equal(libraryPathFor(Permission.ADMIN, "/mnt/media/Movies/Dune (2021)/Dune.mkv"), "/mnt/media/Movies/Dune (2021)/Dune.mkv");
  const candHandler = handlerSource("/admin/fix-match/candidates", "get");
  assert.equal([...candHandler.matchAll(/(plex|jellyfin)FilePath: libraryPathFor\(/g)].length, 4, "the Jellyfin answer and viewOf both project the two paths");
  assert.match(candHandler, /if \(cached\) return NextResponse\.json\(viewOf\(cached\)\);/);
  assert.match(candHandler, /return NextResponse\.json\(viewOf\(responseBody\)\);/);
  const fileInfoHandler = handlerSource("/admin/fix-match/file-info", "get");
  assert.match(fileInfoHandler, /plexFilePath: +libraryPathFor\(perms, plexItem\?\.filePath\)/);
  assert.match(fileInfoHandler, /jellyfinFilePath: libraryPathFor\(perms, jellyfinItem\?\.filePath\)/);
  assert.match(fileInfoHandler, /filePath: libraryPathFor\(perms, r\.filePath\)/);
});

test("the fix-match thumbnail is documented as an image, which is all the proxy passes on", async () => {
  const op = await specOp("/admin/fix-match/thumb", "get");
  assert.equal(op.responses["200"].content?.["image/*"]?.schema?.format, "binary");
  const src = routeSource("/admin/fix-match/thumb");
  assert.match(src, /const ALLOWED_IMAGE_TYPES = \["image\/[^\]]+\];/);
  assert.match(src, /if \(!ALLOWED_IMAGE_TYPES\.some\(\(t\) => contentType\.startsWith\(t\)\)\) \{\s+return new NextResponse\("Response is not an image", \{ status: 502 \}\);/);
});

// ── library tools ──────────────────────────────────────────────────────────

test("the library warm documents prewarmLibraryCache's counts, and its job poll replays the same body", async () => {
  const post = await responseSchema("/admin/library-warm", "post", "200");
  const sig = /export async function prewarmLibraryCache\([^)]*\): Promise<\{([^}]*)\}>/.exec(libSource("tmdb-prewarm.ts"))?.[1] ?? "";
  const fields = [...sig.matchAll(/(\w+): number/g)].map((m) => m[1]).sort();
  assert.ok(fields.length >= 5, sig);
  assert.deepEqual(keysOf(post), fields);
  assert.match(routeSource("/admin/library-warm"), /return NextResponse\.json\(result\);/);
  assert.deepEqual(await responseSchema("/admin/library-warm", "get", "200"), post);
});

test("the library path samples, schema check and cache clear document the bodies their handlers build", async () => {
  const samples = await responseSchema("/admin/library-sample-paths", "get", "200");
  const sampleSrc = routeSource("/admin/library-sample-paths");
  assert.deepEqual(keysOf(samples), bodyKeys(sampleSrc).at(-1));
  for (const server of ["plex", "jellyfin"]) {
    assert.deepEqual(keysOf(prop(samples, server)), ["movie", "tv"], server);
    for (const type of ["movie", "tv"]) {
      assert.deepEqual(keysOf(prop(samples, server, type)), ["mountPoint", "samples"], `${server}.${type}`);
      assert.equal(prop(samples, server, type, "samples").maxItems, Number(/const SAMPLE_COUNT = (\d+);/.exec(sampleSrc)?.[1]));
    }
  }

  const check = await responseSchema("/admin/check-schema", "get", "200");
  const checkSrc = routeSource("/admin/check-schema");
  assert.deepEqual(keysOf(check), bodyKeys(checkSrc).at(-1));
  const entry = /Record<string, \{ ([^}]*) \}> = \{\};/.exec(checkSrc)?.[1] ?? "";
  const table = check.properties?.tables.additionalProperties as SchemaNode;
  assert.deepEqual(keysOf(table), [...entry.matchAll(/(\w+): /g)].map((m) => m[1]).sort());

  const clear = await responseSchema("/admin/clear-cache", "delete", "200");
  const clearSrc = routeSource("/admin/clear-cache");
  assert.deepEqual(keysOf(clear), bodyKeys(clearSrc).at(-1));
  const sources = [...(/const SOURCE_PREFIXES = \{([\s\S]*?)\} as const/.exec(clearSrc)?.[1] ?? "").matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual([...(prop(clear, "source").enum ?? [])].sort(), [...sources, "all"].sort());
});

test("the library match check documents the stored report and the run's answers — and no item path", async () => {
  const get = await responseSchema("/admin/library/match-check", "get", "200");
  const data = libSource("library-match-data.ts");
  const rules = libSource("library-match.ts");
  const stored = branch(get, 0);
  assert.deepEqual(keysOf(stored), bodyKeys(handlerSource("/admin/library/match-check", "get")).at(-1));
  const report = prop(stored, "report");
  assert.deepEqual(keysOf(report), interfaceFields(data, "LibraryMatchReport"));
  assert.deepEqual(keysOf(prop(report, "counts")), interfaceFields(rules, "MatchCounts"));
  assert.deepEqual(keysOf(prop(report, "sources", "[]")), interfaceFields(data, "LibraryMatchSource"));
  assert.deepEqual([...(prop(report, "sources", "[]", "service").enum ?? [])].sort(), unionMembers(data, "LibraryMatchSourceService"));
  const flag = prop(report, "flags", "[]");
  // The full path is ADMIN data the item-mode fix reads; the documented flag names the folder and file only.
  assert.deepEqual(keysOf(flag), without(interfaceFields(rules, "MatchFlag"), "path"));
  assert.ok(interfaceFields(rules, "MatchFlag").includes("path"));
  assert.deepEqual(keysOf(prop(flag, "arr")), interfaceFields(rules, "MatchFlagArr"));
  assert.deepEqual([...(prop(flag, "kind").enum ?? [])].sort(), unionMembers(rules, "MatchFlagKind"));
  assert.equal(prop(report, "flags").maxItems, Number(/export const MAX_STORED_FLAGS = ([\d_]+);/.exec(data)?.[1].replace(/_/g, "")));

  // POST 200 (and the job's replay on GET ?job=): the finished run, or the abort.
  const post = await responseSchema("/admin/library/match-check", "post", "200");
  assert.deepEqual(branch(get, 1), post);
  const runBodies = bodyKeys(handlerSource("/admin/library/match-check", "post"));
  assert.deepEqual(keysOf(branch(post, 0)), runBodies.find((k) => k.includes("checkedAt")));
  assert.deepEqual(keysOf(branch(post, 1)), runBodies.find((k) => k.includes("aborted")));
});

test("the bad-match list documents BadMatchItem and its two sides, without the shared relative path", async () => {
  const schema = await responseSchema("/admin/library/bad-matches", "get", "200");
  assert.deepEqual(keysOf(schema), bodyKeys(routeSource("/admin/library/bad-matches")).find((k) => k.includes("capped")));
  const src = libSource("bad-matches.ts");
  const item = prop(schema, "badMatches", "[]");
  assert.deepEqual(keysOf(item), without(interfaceFields(src, "BadMatchItem"), "relativePath"));
  for (const side of ["plex", "jellyfin"]) assert.deepEqual(keysOf(prop(item, side)), interfaceFields(src, "BadMatchSide"), side);
});

test("every admin tool response this file pins is a real schema, not prose", async () => {
  const spec = await getSpec();
  const ops: Array<[string, string, string, string]> = [
    ["/admin/backup/db-import", "post", "200", "application/json"],
    ["/admin/debug/arr-state", "get", "200", "application/json"],
    ["/admin/debug/ratings-state", "get", "200", "application/json"],
    ["/admin/debug/history-link", "get", "200", "application/json"],
    ["/admin/play-history/backfill-playtime", "post", "200", "application/json"],
    ["/admin/fix-match", "post", "200", "application/json"],
    ["/admin/fix-match", "post", "202", "application/json"],
    ["/admin/fix-match/status", "get", "200", "application/json"],
    ["/admin/fix-match/jobs", "get", "200", "application/json"],
    ["/admin/fix-match/candidates", "get", "200", "application/json"],
    ["/admin/fix-match/file-info", "get", "200", "application/json"],
    ["/admin/fix-match/thumb", "get", "200", "image/*"],
    ["/admin/library-warm", "get", "200", "application/json"],
    ["/admin/library-warm", "post", "200", "application/json"],
    ["/admin/library-sample-paths", "get", "200", "application/json"],
    ["/admin/check-schema", "get", "200", "application/json"],
    ["/admin/clear-cache", "delete", "200", "application/json"],
    ["/admin/library/match-check", "get", "200", "application/json"],
    ["/admin/library/match-check", "post", "200", "application/json"],
    ["/admin/library/bad-matches", "get", "200", "application/json"],
    ["/admin/backup/db-export", "get", "200", "application/octet-stream"],
    ["/admin/audit-log/export", "get", "200", "text/csv"],
  ];
  for (const [path, method, status, media] of ops) {
    const schema = spec.paths[path]?.[method]?.responses[status]?.content?.[media]?.schema;
    assert.ok(schema && (schema.properties || schema.oneOf || schema.allOf || schema.type === "string" || schema.type === "array"), `${method} ${path} ${status} ${media}`);
  }
});
