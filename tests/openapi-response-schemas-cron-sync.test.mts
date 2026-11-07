// The /cron/*, /sync/* and arr webhook 200s in the OpenAPI document are real
// schemas, each pinned here to the handler that sends the body (and to the lib
// type it spreads), so a field added to or dropped from a run's answer turns
// this red instead of leaving the document stale.

import {
  getSpec, specOp, responseSchema, keysOf, handlerSource, routeSource, libSource,
  interfaceFields, jsonBodyKeys, constObjectKeys, type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

// ── helpers ─────────────────────────────────────────────────────────────────

/** The one JSON body (key list) of a handler that carries `marker`. */
function bodyWith(src: string, marker: string): string[] {
  const bodies = jsonBodyKeys(src).filter((keys) => keys.includes(marker));
  assert.equal(bodies.length, 1, `expected one body with \`${marker}\`, found ${bodies.length}`);
  return bodies[0];
}

/**
 * A body's keys with its spreads expanded: `...<name>` from `spreads`, and a
 * conditional `...(cond ? { a: … } : {})` to the keys of its object literal.
 */
function expand(keys: string[], spreads: Record<string, string[]> = {}): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    if (!k.startsWith("...")) { out.add(k); continue; }
    const expr = k.slice(3);
    if (expr in spreads) { for (const f of spreads[expr]) out.add(f); continue; }
    const inner = conditionalBranchKeys(expr);
    assert.ok(inner.length > 0, `unexpanded spread ${k}`);
    for (const f of inner) out.add(f);
  }
  return [...out].sort();
}

/** The top-level keys of the object literals a `cond ? { … } : { … }` expression picks between. */
function conditionalBranchKeys(expr: string): string[] {
  const sf = parse(`const __x = ${expr};`);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
  let init = decl.initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (!init || !ts.isConditionalExpression(init)) return [];
  const keys: string[] = [];
  for (const branch of [init.whenTrue, init.whenFalse]) {
    let b: ts.Expression = branch;
    while (ts.isParenthesizedExpression(b)) b = b.expression;
    if (!ts.isObjectLiteralExpression(b)) continue;
    for (const p of b.properties) if (p.name && ts.isIdentifier(p.name)) keys.push(p.name.text);
  }
  return keys;
}

/** The member names of a type node: a type literal, an array of one, or either `| null`. */
function literalMembers(node: ts.TypeNode | undefined): string[] {
  assert.ok(node, "no type");
  if (ts.isUnionTypeNode(node)) {
    const rest = node.types.filter((t) => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword));
    assert.equal(rest.length, 1);
    return literalMembers(rest[0]);
  }
  if (ts.isArrayTypeNode(node)) return literalMembers(node.elementType);
  if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1) return literalMembers(node.typeArguments[0]);
  assert.ok(ts.isTypeLiteralNode(node), `not a type literal: ${ts.SyntaxKind[node.kind]}`);
  return node.members.filter(ts.isPropertySignature).map((m) => (m.name as ts.Identifier).text).sort();
}

const parse = (src: string) => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The members of an inline type an interface member declares (`events: { … }`, `errors: Array<{ … }>`). */
function memberLiteralFields(src: string, iface: string, member: string): string[] {
  let found: ts.TypeNode | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === iface) {
      const m = n.members.find((x) => ts.isPropertySignature(x) && (x.name as ts.Identifier).text === member);
      if (m && ts.isPropertySignature(m)) found = m.type;
    } else ts.forEachChild(n, visit);
  };
  visit(parse(src));
  return literalMembers(found);
}

/** The members of the inline `Promise<{ … }>` an exported async function returns. */
function returnedLiteralFields(src: string, fn: string): string[] {
  let found: ts.TypeNode | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fn) found = n.type;
    else ts.forEachChild(n, visit);
  };
  visit(parse(src));
  return literalMembers(found);
}

/** The string literals of `type <name> = "a" | "b"`. */
function unionLiterals(src: string, name: string): string[] {
  const m = new RegExp(`type ${name} =([^;]*);`).exec(src);
  assert.ok(m, `type ${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

const oneOf = (schema: SchemaNode) => {
  assert.ok(schema.oneOf, "not a oneOf");
  return schema.oneOf;
};
/** The run branch of a run-or-skip answer. */
async function runBranch(path: string, method = "post"): Promise<SchemaNode> {
  return oneOf(await responseSchema(path, method, "200"))[0];
}
const sub = (schema: SchemaNode, key: string): SchemaNode => {
  const s = schema.properties?.[key];
  assert.ok(s, `no property ${key}`);
  return s;
};

// ── the run-or-skip answers ─────────────────────────────────────────────────

const SKIPPING_ROUTES = [
  "/cron/arr-watch", "/cron/refresh-arr-snapshots", "/cron/purge-auth-sessions", "/cron/purge-notifications",
  "/cron/scrub-audit-pii", "/cron/warm-activity", "/cron/refresh-upstream-watch", "/cron/watch-sync",
  "/cron/warm-library", "/cron/warm-mdblist", "/cron/warm-omdb", "/cron/warm-recommendations",
  "/sync/plex", "/sync/jellyfin", "/sync/upcoming", "/sync/ratings",
];

test("every cron/sync route that can answer a skip documents run-or-skip, and only those", async () => {
  const skipKeys = jsonBodyKeys(libSource("cron-history.ts"), ["Response.json"]).find((k) => k.includes("skipped"));
  assert.deepEqual(skipKeys, ["reason", "skipped"], "cronSkippedResponse's body");
  const spec = await getSpec();
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!/^\/(cron|sync)\//.test(path) || !methods.post) continue;
    const schema = methods.post.responses["200"]?.content?.["application/json"]?.schema;
    if (!schema) continue; // documented by another pin (not this group's)
    const skips = /cronSkippedResponse\(/.test(routeSource(path));
    assert.equal(!!schema.oneOf, skips, `${path}: oneOf ${!!schema.oneOf}, handler skips ${skips}`);
    if (!skips) continue;
    const [run, skip] = oneOf(schema);
    assert.deepEqual(keysOf(skip), skipKeys, `${path} skip branch`);
    assert.deepEqual([...(skip.required ?? [])].sort(), ["reason", "skipped"]);
    assert.deepEqual(skip.properties?.skipped.enum, [true]);
    // The run must require a key a skip never sends, or a validator matches both.
    assert.ok((run.required ?? []).some((k) => !skipKeys.includes(k)), `${path}: the run branch requires nothing a skip lacks`);
  }
  for (const path of SKIPPING_ROUTES) assert.match(routeSource(path), /cronSkippedResponse\(/, path);
});

test("a recorded cron run's trigger enum is CronActor's", async () => {
  const declared = [...(/trigger: ("[^;]+");/.exec(libSource("cron-auth.ts"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(declared, ["admin", "cron"]);
  for (const path of ["/cron/arr-watch", "/cron/refresh-arr-snapshots", "/cron/refresh-upstream-watch", "/cron/watch-sync"]) {
    assert.deepEqual(sub(await runBranch(path), "trigger").enum, declared, path);
  }
});

// ── the crons that spread a lib result ──────────────────────────────────────

test("the monitor crons document exactly what their handler sends, the spread result field for field", async () => {
  const cases: Array<[string, string, string]> = [
    ["/cron/arr-watch", "arr-watch-data.ts", "ArrWatchResult"],
    ["/cron/refresh-arr-snapshots", "arr-snapshot.ts", "RefreshResult"],
    ["/cron/refresh-upstream-watch", "upstream-watch-data.ts", "UpstreamRefreshResult"],
    ["/cron/watch-sync", "watch-sync-data.ts", "WatchSyncRunResult"],
  ];
  for (const [path, lib, iface] of cases) {
    const sent = expand(bodyWith(handlerSource(path, "post"), "ok"), { result: interfaceFields(libSource(lib), iface) });
    assert.deepEqual(keysOf(await runBranch(path)), sent, path);
  }

  const watch = libSource("arr-watch-data.ts");
  const arrWatch = await runBranch("/cron/arr-watch");
  assert.deepEqual(keysOf(sub(arrWatch, "events")), memberLiteralFields(watch, "ArrWatchResult", "events"));
  assert.deepEqual(keysOf(sub(arrWatch, "errors").items), memberLiteralFields(watch, "ArrWatchResult", "errors"));
  assert.deepEqual(sub(sub(arrWatch, "errors").items ?? {}, "part").enum, unionLiterals(watch, "ArrWatchPart").sort());
  assert.deepEqual(keysOf(sub(arrWatch, "summary")), interfaceFields(libSource("arr-watch.ts"), "ArrWatchCounts"));

  const upstream = await runBranch("/cron/refresh-upstream-watch");
  assert.deepEqual(keysOf(sub(upstream, "servers").items), interfaceFields(libSource("upstream-watch-data.ts"), "UpstreamServerResult"));
  assert.deepEqual(
    [...(sub(sub(upstream, "servers").items ?? {}, "health").enum ?? [])].sort(),
    unionLiterals(libSource("never-watched.ts"), "NwUpstreamHealth"),
  );

  const ws = libSource("watch-sync-data.ts");
  const pair = sub(await runBranch("/cron/watch-sync"), "pairs").items ?? {};
  assert.deepEqual(keysOf(pair), interfaceFields(ws, "WatchSyncPairResult"));
  assert.deepEqual(keysOf(sub(pair, "toJellyfin")), interfaceFields(ws, "WatchSyncDirectionResult"));
  assert.deepEqual(keysOf(sub(pair, "toPlex")), interfaceFields(ws, "WatchSyncDirectionResult"));
  assert.deepEqual(keysOf(sub(pair, "progress")), interfaceFields(ws, "WatchSyncProgressResult"));
});

test("the warm crons document exactly what their handler sends, nested results included", async () => {
  const prewarm = libSource("tmdb-prewarm.ts");
  const library = await runBranch("/cron/warm-library");
  assert.deepEqual(
    keysOf(library),
    expand(bodyWith(handlerSource("/cron/warm-library", "post"), "ok"), { result: returnedLiteralFields(prewarm, "prewarmLibraryCache") }),
  );
  assert.deepEqual(keysOf(sub(library, "edges")), interfaceFields(libSource("recommendation-graph.ts"), "SuggestionEdgePrewarmResult"));
  assert.deepEqual(keysOf(sub(library, "translations")), returnedLiteralFields(libSource("tmdb-localize.ts"), "prewarmTitleTranslations"));

  assert.deepEqual(
    keysOf(await runBranch("/cron/warm-mdblist")),
    expand(bodyWith(handlerSource("/cron/warm-mdblist", "post"), "ok"), { result: returnedLiteralFields(libSource("mdblist-prewarm.ts"), "prewarmMdblistCache") }),
  );
  assert.deepEqual(
    keysOf(await runBranch("/cron/warm-omdb")),
    expand(bodyWith(handlerSource("/cron/warm-omdb", "post"), "ok"), { result: interfaceFields(libSource("omdb-prewarm.ts"), "OmdbPrewarmResult") }),
  );

  const recs = await runBranch("/cron/warm-recommendations");
  assert.deepEqual(
    keysOf(recs),
    expand(bodyWith(handlerSource("/cron/warm-recommendations", "post"), "ok"), { result: interfaceFields(libSource("recommendations.ts"), "WarmRecommendationsResult") }),
  );
  assert.deepEqual(keysOf(sub(recs, "graph")), interfaceFields(libSource("recommendation-graph.ts"), "GraphRefreshResult"));
  assert.deepEqual(keysOf(sub(recs, "serverHistory")), interfaceFields(libSource("server-watch-history-data.ts"), "ServerHistoryImportResult"));
});

test("the purge, scrub and activity crons document exactly the body they send", async () => {
  for (const path of ["/cron/purge-auth-sessions", "/cron/purge-notifications", "/cron/scrub-audit-pii", "/cron/warm-activity"]) {
    // The 200 body: the one carrying `timestamp` (a failed purge-notifications answers 500 { ok, error }).
    assert.deepEqual(keysOf(await runBranch(path)), bodyWith(handlerSource(path, "post"), "timestamp"), path);
  }
  const deleted = sub(await runBranch("/cron/purge-auth-sessions"), "deleted");
  assert.deepEqual(keysOf(deleted), unionLiterals(routeSource("/cron/purge-auth-sessions"), "PurgeKey"));
});

// ── the sync routes ─────────────────────────────────────────────────────────

test("a Plex or Jellyfin resync documents its answer once, and the job poll replays it", async () => {
  const answer = await responseSchema("/sync/plex", "post", "200");
  for (const path of ["/sync/plex", "/sync/jellyfin"]) {
    assert.deepEqual(await responseSchema(path, "post", "200"), answer, `${path} POST`);
    assert.deepEqual(await responseSchema(path, "get", "200"), answer, `${path} GET`);
    const sent = bodyWith(routeSource(path), "scanned");
    assert.deepEqual(keysOf(oneOf(answer)[0]), sent, path);
    assert.match(handlerSource(path, "get"), /libraryJobResponse\(/, `${path} GET replays the job`);
    assert.match(routeSource(path), /scanned: \{ movies: movieIds\.size, tv: tvIds\.size \}/, path);
  }
  assert.deepEqual(keysOf(sub(oneOf(answer)[0], "scanned")), ["movies", "tv"]);
  // The poll answers the stored run's own status and body.
  assert.match(libSource("library-sync-jobs.ts"), /return \{ status: res\.status, body: await res\.json\(\)/);
  assert.match(libSource("release-search-jobs.ts"), /return NextResponse\.json\(poll\.answer\.body, \{ status: poll\.answer\.status \}\);/);
});

test("the Radarr/Sonarr cache syncs document both of their 200 bodies", async () => {
  for (const path of ["/sync/radarr", "/sync/sonarr"]) {
    const schema = await responseSchema(path, "post", "200");
    const bodies = jsonBodyKeys(handlerSource(path, "post")).filter((k) => k.includes("wanted"));
    assert.equal(bodies.length, 2, path);
    assert.deepEqual(keysOf(schema), [...new Set(bodies.flat())].sort(), path);
    // Required: what every 200 carries.
    assert.deepEqual([...(schema.required ?? [])].sort(), bodies.reduce((a, b) => a.filter((k) => b.includes(k))), path);
  }
});

test("/sync/upcoming and /sync/ratings document their run, and ratings' no-key answer is the skip shape", async () => {
  const upcoming = await runBranch("/sync/upcoming");
  assert.deepEqual(keysOf(upcoming), expand(bodyWith(handlerSource("/sync/upcoming", "post"), "movies")));
  assert.deepEqual(keysOf(sub(upcoming, "calendar")), interfaceFields(libSource("calendar-feed.ts"), "CalendarWarmResult"));
  assert.match(routeSource("/sync/upcoming"), /let calendar: CalendarWarmResult \| null = null;/);
  assert.equal(sub(upcoming, "calendar").nullable, true);

  const ratings = await responseSchema("/sync/ratings", "post", "200");
  const src = handlerSource("/sync/ratings", "post");
  assert.deepEqual(keysOf(oneOf(ratings)[0]), bodyWith(src, "total"));
  // The no-key answer (recorded, no header) and the busy skip share the skip branch.
  assert.deepEqual(bodyWith(src, "reason"), keysOf(oneOf(ratings)[1]));
  assert.equal(sub(oneOf(ratings)[0], "skipped").type, "integer");
});

test("/sync/play-history documents its per-server map, `purged` and the disabled answer", async () => {
  const schema = await responseSchema("/sync/play-history", "post", "200");
  const src = routeSource("/sync/play-history");
  assert.deepEqual(keysOf(schema), ["message", "purged"]);
  assert.match(src, /results\.purged = purged;/);
  assert.deepEqual(bodyWith(src, "message"), ["message"]);
  const entry = schema.additionalProperties;
  assert.ok(entry && typeof entry === "object", "a server's entry is documented");
  const syncResult = [...(/type SyncResult = \{([^}]*)\}/.exec(src)?.[1] ?? "").matchAll(/(\w+): number/g)].map((m) => m[1]);
  assert.equal(syncResult.length, 3);
  assert.deepEqual(keysOf(entry), [...syncResult, "error"].sort());
  assert.match(src, /results\[label\] = \{ error: msg \};/);
  assert.match(src, /results\[`post-sync:\$\{step\}`\] = \{ error: msg \};/);
  assert.match(src, /return NextResponse\.json\(\s*results,/);
});

test("/sync/tv-episodes documents its results object", async () => {
  const schema = await responseSchema("/sync/tv-episodes", "post", "200");
  const src = routeSource("/sync/tv-episodes");
  assert.deepEqual(keysOf(schema), constObjectKeys(src, "results"));
  assert.match(src, /return NextResponse\.json\(results\);/);
  assert.deepEqual(sub(schema, "skipped").items?.enum, ["plex", "jellyfin"]);
  assert.match(src, /results\.skipped\.push\("plex"\)/);
  assert.match(src, /results\.skipped\.push\("jellyfin"\)/);
});

// ── the arr webhooks ────────────────────────────────────────────────────────

test("each arr webhook documents every 200 field its deliveries answer, and every reason", async () => {
  const shared = jsonBodyKeys(libSource("arr-webhook.ts")).filter((k) => k.includes("ok"));
  assert.ok(shared.length >= 2, "Test and Health acknowledgements");
  for (const service of ["radarr", "sonarr"]) {
    const path = `/webhooks/${service}`;
    const schema = await responseSchema(path, "post", "200");
    const src = routeSource(path);
    const own = jsonBodyKeys(src).filter((k) => k.includes("ok"));
    assert.deepEqual(keysOf(schema), [...new Set([...shared, ...own].flat())].sort(), path);
    assert.deepEqual(schema.required, ["ok"]);
    assert.deepEqual(sub(schema, "ok").enum, [true]);
    const reasons = new Set<string>();
    for (const m of src.matchAll(/(?:reason: |const reason = )([^\n]*)/g)) {
      for (const lit of m[1].matchAll(/"([a-z_]+)"/g)) reasons.add(lit[1]);
    }
    assert.ok(reasons.size >= 3, `${path}: ${[...reasons]}`);
    assert.deepEqual([...(sub(schema, "reason").enum ?? [])].sort(), [...reasons].sort(), path);
  }
  // Nothing in an acknowledgement names the webhook token (guardrail 2a).
  const text = JSON.stringify([(await specOp("/webhooks/radarr", "post")).responses["200"], (await specOp("/webhooks/sonarr", "post")).responses["200"]]);
  assert.doesNotMatch(text, /token|secret/i);
});
