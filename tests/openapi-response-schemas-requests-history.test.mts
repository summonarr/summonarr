// OpenAPI response schemas for the request, issue, vote and play-history reads
// and writes: each documented shape is pinned to the handler (or the interface,
// select or prisma model it answers with), so a handler that adds, drops or
// renames a field goes red here instead of leaving a stale contract.

import {
  getSpec,
  handlerSource,
  interfaceFields,
  jsonBodyKeys,
  keysOf,
  libSource,
  prismaModelFields,
  readRepo,
  responseSchema,
  routeSource,
  type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

// ── local AST helpers ────────────────────────────────────────────────────────

const parse = (src: string) => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)
  ) e = e.expression;
  return e;
}

/** The object literal an expression evaluates to: a literal, a `.map(x => ({ … }))`, the `?` branch of a conditional, or a call's first object argument. */
function objectOf(e: ts.Expression): ts.ObjectLiteralExpression | null {
  e = unwrap(e);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isConditionalExpression(e)) return objectOf(e.whenTrue) ?? objectOf(e.whenFalse);
  if (ts.isCallExpression(e)) {
    const fn = e.arguments[0];
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      if (!ts.isBlock(fn.body)) return objectOf(fn.body);
      let found: ts.ObjectLiteralExpression | null = null;
      const visit = (n: ts.Node) => {
        if (!found && ts.isReturnStatement(n) && n.expression) found = objectOf(n.expression);
        if (!found && !ts.isFunctionLike(n)) ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn.body, visit);
      return found;
    }
    for (const a of e.arguments) if (ts.isObjectLiteralExpression(unwrap(a))) return unwrap(a) as ts.ObjectLiteralExpression;
  }
  return null;
}

/** The sorted keys of an object literal (spreads as `...<expr>`). */
function keysOfObject(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties.map((p) => {
    if (ts.isSpreadAssignment(p)) return `...${p.expression.getText()}`;
    const n = p.name;
    return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : "?";
  }).sort();
}

/** Descends an object literal along property names (each step through objectOf). */
function objectAt(obj: ts.ObjectLiteralExpression, path: string[]): ts.ObjectLiteralExpression {
  let cur = obj;
  for (const step of path) {
    const p = cur.properties.find((x) => ts.isPropertyAssignment(x) && (x.name as ts.Identifier).text === step);
    assert.ok(p && ts.isPropertyAssignment(p), `no property ${step} (path ${path.join(".")})`);
    const next = objectOf(p.initializer);
    assert.ok(next, `${step} is not an object literal (path ${path.join(".")})`);
    cur = next;
  }
  return cur;
}

/** The object literal a `const <name> = …` evaluates to (see objectOf). */
function varObject(src: string, name: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      found = objectOf(n.initializer);
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(parse(src));
  assert.ok(found, `const ${name} = { … } not found`);
  return found;
}

/** The object literals passed to `NextResponse.json(…)` in a source, in order. */
function jsonObjects(src: string): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText() === "NextResponse.json") {
      const arg = n.arguments[0] && unwrap(n.arguments[0]);
      if (arg && ts.isObjectLiteralExpression(arg)) out.push(arg);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(src));
  return out;
}

/** The one `NextResponse.json({ … })` body carrying `key`. */
function jsonObjectWith(src: string, key: string): ts.ObjectLiteralExpression {
  const hits = jsonObjects(src).filter((o) => keysOfObject(o).includes(key));
  assert.ok(hits.length >= 1, `no NextResponse.json({ ${key}, … })`);
  return hits[hits.length - 1];
}

/** The string literals of a `type X = | "a" | "b"` union. */
function unionLiterals(src: string, name: string): string[] {
  const m = new RegExp(`type ${name} =([^;]*);`).exec(src);
  assert.ok(m, `type ${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const prop = (schema: SchemaNode | undefined, ...path: string[]): SchemaNode => {
  let cur = schema;
  for (const step of path) {
    cur = step === "[]" ? cur?.items : cur?.properties?.[step];
    assert.ok(cur, `no ${path.join(".")}`);
  }
  return cur as SchemaNode;
};
const sorted = (xs: string[]) => [...xs].sort();
const OK_TRUE = { type: "object", required: ["ok"], properties: { ok: { type: "boolean", enum: [true] } } };

// ── requests and issues ─────────────────────────────────────────────────────

test("plain acknowledgements: a grabbed release and a filed report answer { ok: true }", async () => {
  for (const [path, method] of [["/requests/{id}/releases", "post"], ["/report", "post"]] as const) {
    assert.deepEqual(await responseSchema(path, method, "200"), OK_TRUE, path);
    const bodies = jsonBodyKeys(handlerSource(path, method));
    assert.deepEqual(bodies[bodies.length - 1], ["ok"], `${path}: the handler's success answer`);
  }
});

test("the request pickers document what their handlers answer: quality profiles, named instances, on-behalf users", async () => {
  const qp = await responseSchema("/requests/quality-profiles", "get", "200");
  assert.deepEqual(keysOf(qp), jsonBodyKeys(handlerSource("/requests/quality-profiles", "get")).at(-1));
  // listQualityProfiles projects { id, name } and keeps at most MAX_QUALITY_PROFILES.
  const arr = libSource("arr.ts");
  assert.match(arr, /profiles\.push\(\{ id: p\.id, name: /);
  assert.deepEqual(keysOf(prop(qp, "qualityProfiles", "[]")), ["id", "name"]);
  assert.equal(prop(qp, "qualityProfiles").maxItems, Number(/export const MAX_QUALITY_PROFILES = (\d+);/.exec(arr)?.[1]));

  const inst = await responseSchema("/requests/instances", "get", "200");
  assert.deepEqual(keysOf(inst), jsonBodyKeys(handlerSource("/requests/instances", "get")).at(-1));
  assert.deepEqual(keysOf(prop(inst, "instances", "[]")), interfaceFields(libSource("named-instance-targets.ts"), "NamedInstanceTarget"));

  const users = await responseSchema("/requests/users", "get", "200");
  const usersSrc = routeSource("/requests/users");
  assert.deepEqual(keysOf(users), jsonBodyKeys(usersSrc).at(-1));
  const pushed = /users\.push\((\{[^)]*\})\)/.exec(usersSrc)?.[1] ?? "";
  assert.deepEqual(keysOf(prop(users, "users", "[]")), sorted([...pushed.matchAll(/(\w+): u\./g)].map((m) => m[1])));
  assert.equal(prop(users, "users").maxItems, Number(/const MAX_USERS = (\d+);/.exec(usersSrc)?.[1]));
});

test("POST /requests/bulk documents one answer for 200 and 201, item for item the CreateOutcome", async () => {
  const created = await responseSchema("/requests/bulk", "post", "201");
  assert.deepEqual(await responseSchema("/requests/bulk", "post", "200"), created);
  const src = routeSource("/requests/bulk");
  for (const body of jsonBodyKeys(src).filter((k) => k.includes("results"))) assert.deepEqual(keysOf(created), body);
  const lib = libSource("request-bulk.ts");
  const item = prop(created, "results", "[]");
  assert.deepEqual(keysOf(item), interfaceFields(lib, "CreateOutcome"));
  assert.deepEqual(prop(item, "result").enum, unionLiterals(lib, "ItemResult"));
});

test("POST /issues/{id}/claim documents the re-read row the handler answers", async () => {
  const schema = await responseSchema("/issues/{id}/claim", "post", "200");
  const select = objectAt(varObject(routeSource("/issues/{id}/claim"), "updated"), ["select"]);
  assert.deepEqual(keysOf(schema), keysOfObject(select));
  assert.deepEqual(keysOf(prop(schema, "claimedUser")), keysOfObject(objectAt(select, ["claimedUser", "select"])));
});

// Security-relevant: the author's email reaches only the thread's managers
// (guardrail 14e), so the spec must not promise it to everyone.
test("request comments and issue messages document the row, its author, and email as managers-only", async () => {
  const threads = [
    { path: "/requests/{id}/comments", model: "RequestComment", parent: "request", bit: "MANAGE_REQUESTS" },
    { path: "/issues/{id}/messages", model: "IssueMessage", parent: "issue", bit: "MANAGE_ISSUES" },
  ];
  for (const { path, model, parent, bit } of threads) {
    const list = await responseSchema(path, "get", "200");
    const created = await responseSchema(path, "post", "201");
    assert.deepEqual(list.items, created, `${path}: the list item and the created entry are one shape`);
    assert.deepEqual(keysOf(created), sorted([...prismaModelFields(model, [parent, "author"]), "author"]), path);
    const author = prop(created, "author");
    assert.deepEqual(keysOf(author), ["email", "name", "role"], path);
    assert.ok(!(author.required ?? []).includes("email"), `${path}: email must not be promised to every caller`);
    assert.match(author.properties?.email.description ?? "", new RegExp(bit));
    assert.equal(list.maxItems, 500, path);

    // …and the handlers select email only under the manager check, on both methods.
    const src = routeSource(path);
    const selects = [...src.matchAll(/author: \{ select: \{ name: true, role: true, \.\.\.\((\w+) \? \{ email: true \} : \{\}\) \} \}/g)];
    assert.equal(selects.length, 2, `${path}: both methods' author selects`);
    for (const [, flag] of selects) {
      assert.match(src, new RegExp(`const ${flag} = hasPermission\\(session\\.user\\.permissions, Permission\\.${bit}\\)`), `${path}: ${flag}`);
    }
    assert.match(src, /take: (500|MAX_THREAD_MESSAGES)/);
  }
});

test("GET /issues/{id}/files documents the answer, the scope kinds, and each file without its paths", async () => {
  const schema = await responseSchema("/issues/{id}/files", "get", "200");
  const getBody = jsonBodyKeys(handlerSource("/issues/{id}/files", "get")).find((k) => k.includes("files"));
  assert.deepEqual(keysOf(schema), getBody);

  const replace = libSource("issue-replace.ts");
  const scopeType = /export type ReplaceScope =([\s\S]*?);\n/.exec(replace)?.[1] ?? "";
  assert.deepEqual(prop(schema, "scope", "kind").enum, [...scopeType.matchAll(/kind: "(\w+)"/g)].map((m) => m[1]));

  const title = libSource("arr-title.ts");
  const file = prop(schema, "files", "[]");
  const titleFile = interfaceFields(title, "TitleFile");
  // Every TitleFile field but its two paths, plus the grab (ReplaceableFile).
  assert.deepEqual(keysOf(file), sorted([...titleFile.filter((k) => k !== "path" && k !== "relativePath"), "grab"]));
  for (const k of ["path", "relativePath"]) {
    assert.ok(titleFile.includes(k), `TitleFile still carries ${k}`);
    assert.ok(!keysOf(file).includes(k), `the spec documents ${k}`);
  }
  assert.deepEqual(keysOf(prop(file, "media")), interfaceFields(title, "TitleFileMedia"));
  assert.deepEqual(keysOf(prop(file, "episodes", "[]")), sorted([...interfaceFields(replace, "EpisodeRef"), ...interfaceFields(replace, "ReplaceEpisode")]));
  assert.deepEqual(keysOf(prop(file, "grab")), interfaceFields(replace, "FileGrab"));
});

// ── votes ────────────────────────────────────────────────────────────────────

test("GET /votes documents each item the handler builds, and POST the created DeletionVote row", async () => {
  const src = handlerSource("/votes", "get");
  const page = await responseSchema("/votes", "get", "200");
  const items = page.allOf?.[1]?.properties?.items?.items;
  assert.ok(items);
  const built = varObject(src, "items");
  assert.deepEqual(keysOf(items), keysOfObject(built));
  // Other voters' reasons carry the vote id (for POST /report) and nothing that names the voter.
  assert.deepEqual(keysOf(prop(items, "reasonEntries", "[]")), ["id", "reason"]);
  assert.match(src, /list\.push\(\{ id: r\.id, reason \}\)/);
  assert.match(src, /if \(list\.length >= 3 \|\|/);
  assert.equal(prop(items, "reasons").maxItems, 3);
  assert.equal(prop(items, "reasonEntries").maxItems, 3);

  const vote = await responseSchema("/votes", "post", "201");
  assert.deepEqual(keysOf(vote), prismaModelFields("DeletionVote", ["user"]));
  assert.match(handlerSource("/votes", "post"), /return NextResponse\.json\(vote, \{ status: 201 \}\);/);
});

// ── play history ─────────────────────────────────────────────────────────────

const PLAY_HISTORY_COLUMNS = prismaModelFields("PlayHistory", ["mediaServerUser"]);

test("GET /play-history/{id} documents every PlayHistory column and the embedded media-server user", async () => {
  const schema = await responseSchema("/play-history/{id}", "get", "200");
  assert.deepEqual(keysOf(schema), sorted([...PLAY_HISTORY_COLUMNS, "mediaServerUser"]));
  const include = objectAt(varObject(handlerSource("/play-history/{id}", "get"), "record"), ["include", "mediaServerUser", "select"]);
  assert.deepEqual(keysOf(prop(schema, "mediaServerUser")), keysOfObject(include));
});

test("GET /play-history documents the page, both row modes and the two distinct lists", async () => {
  const schema = await responseSchema("/play-history", "get", "200");
  const [page, platforms, users] = schema.anyOf ?? [];
  assert.ok(page && platforms && users, "three answers");
  const src = routeSource("/play-history");
  const pages = jsonBodyKeys(src).filter((k) => k.includes("totalPages"));
  assert.equal(pages.length, 2, "the grouped and the ungrouped answer");
  for (const body of pages) assert.deepEqual(keysOf(page), body);

  // Each row is the PlayHistory row plus what either path adds to it.
  const added = new Set<string>();
  for (const v of ["itemsWithPosters", "items"]) {
    for (const k of keysOfObject(varObject(src, v))) if (!k.startsWith("...")) added.add(k);
  }
  assert.deepEqual(keysOf(prop(page, "items", "[]")), sorted([...new Set([...PLAY_HISTORY_COLUMNS, ...added])]));
  assert.deepEqual(platforms.items?.type, "string");
  const select = /select: \{ id: true, username: true, source: true, serverInstance: true \}/;
  assert.match(src, select);
  assert.deepEqual(keysOf(users.items), ["id", "serverInstance", "source", "username"]);
});

test("the caller's own history documents MyWatchHistoryPage, its entry detail and plays", async () => {
  const lib = libSource("my-watch-history.ts");
  const page = await responseSchema("/play-history/mine", "get", "200");
  assert.deepEqual(keysOf(page), interfaceFields(lib, "MyWatchHistoryPage"));
  assert.deepEqual(keysOf(prop(page, "items", "[]")), interfaceFields(lib, "MyWatchHistoryItem"));
  assert.deepEqual(keysOf(prop(page, "stats")), ["playSeconds", "plays"]);
  assert.match(lib, /stats: \{ plays: number; playSeconds: number \};/);

  const detail = await responseSchema("/play-history/mine/{id}", "get", "200");
  assert.deepEqual(keysOf(detail), interfaceFields(lib, "MyWatchHistoryEntryDetail"));
  assert.deepEqual(prop(detail, "item"), prop(page, "items", "[]"));
  assert.deepEqual(keysOf(prop(detail, "plays", "[]")), interfaceFields(lib, "MyWatchHistoryPlay"));
  assert.equal(prop(detail, "plays").maxItems, Number(/export const MY_ENTRY_PLAYS_CAP = (\d+);/.exec(lib)?.[1]));
});

test("the caller's own stats and Wrapped document the handlers' projections", async () => {
  const statsSrc = handlerSource("/play-history/mine/stats", "get");
  const stats = await responseSchema("/play-history/mine/stats", "get", "200");
  const statsBody = jsonObjectWith(statsSrc, "stats");
  assert.deepEqual(keysOf(stats), keysOfObject(statsBody));
  assert.deepEqual(keysOf(prop(stats, "stats")), keysOfObject(objectAt(statsBody, ["stats"])));
  assert.deepEqual(keysOf(prop(stats, "stats", "topMedia", "[]")), keysOfObject(objectAt(statsBody, ["stats", "topMedia"])));

  const wrappedSrc = handlerSource("/play-history/mine/wrapped", "get");
  const wrapped = await responseSchema("/play-history/mine/wrapped", "get", "200");
  const wrappedBody = jsonObjectWith(wrappedSrc, "data");
  assert.deepEqual(keysOf(wrapped), keysOfObject(wrappedBody));
  const data = prop(wrapped, "data");
  assert.deepEqual(keysOf(data), keysOfObject(objectAt(wrappedBody, ["data"])));
  for (const k of ["topTitles", "longestSitting"]) {
    const doc = k === "topTitles" ? prop(data, k, "[]") : prop(data, k);
    assert.deepEqual(keysOf(doc), keysOfObject(objectAt(wrappedBody, ["data", k])), k);
  }
  // The pass-through parts are WrappedBundle's own shapes.
  const bundle = /export interface WrappedBundle \{([\s\S]*?)\n\}/.exec(libSource("play-history.ts"))?.[1] ?? "";
  for (const k of ["totals", "movies", "tv", "biggestDay", "busiestMonth", "completion"]) {
    const fields = new RegExp(`\\n  ${k}: \\{([^}]*)\\}`).exec(bundle)?.[1] ?? "";
    assert.deepEqual(keysOf(prop(data, k)), sorted([...fields.matchAll(/(\w+):/g)].map((m) => m[1])), k);
  }
});

test("the admin play-history reads document their rows: active sessions, statistics, transcode offenders, export", async () => {
  const sessions = await responseSchema("/play-history/sessions", "get", "200");
  assert.deepEqual(keysOf(sessions.items), prismaModelFields("ActiveSession", ["mediaServerUser"]));
  // Every BigInt column is sent as a number (withoutBigInts).
  const model = /model ActiveSession \{([\s\S]*?)\n\}/.exec(readRepo("prisma/schema.prisma"))?.[1] ?? "";
  const bigints = [...model.matchAll(/^\s{2}(\w+)\s+BigInt/gm)].map((m) => m[1]);
  assert.ok(bigints.length >= 4, bigints.join(","));
  for (const k of bigints) assert.equal(prop(sessions, "[]", k).type, "integer", k);
  assert.match(routeSource("/play-history/sessions"), /NextResponse\.json\(sessions\.map\(withoutBigInts\)\)/);

  const lib = libSource("play-history.ts");
  assert.deepEqual(
    keysOf(await responseSchema("/play-history/stats", "get", "200")),
    interfaceFields(lib, "PlayHistoryStatsResult"),
  );

  const offenders = await responseSchema("/play-history/transcode-offenders", "get", "200");
  assert.deepEqual(keysOf(offenders), interfaceFields(lib, "TranscodeOffenders"));
  assert.match(lib, /export async function getTranscodeOffenders\(\n\s+filters: PlayHistoryStatsFilters = \{\},\n\s+limit = 6,/);
  for (const k of ["topUsers", "topTitles"]) assert.equal(prop(offenders, k).maxItems, 6, k);

  const exportOp = (await getSpec()).paths["/play-history/export"].get.responses["200"];
  assert.ok(exportOp.content?.["text/csv"], "the CSV body");
  const rows = exportOp.content?.["application/json"]?.schema;
  const exportSrc = routeSource("/play-history/export");
  assert.deepEqual(keysOf(rows?.items), keysOfObject(varObject(exportSrc, "data")));
  assert.equal(rows?.maxItems, Number(/const MAX_EXPORT_ROWS = ([\d_]+);/.exec(exportSrc)?.[1].replace(/_/g, "")));
});
