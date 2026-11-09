// OpenAPI response schemas of the admin configuration surfaces — user writes,
// the OIDC allowlist, media server instances, never watched, watch sync, cleanup
// protection, notification channels, /admin/stats and /settings — each pinned
// to the handler, interface or model it describes, so a field added to or
// dropped from an answer goes red here instead of leaving the spec stale.

import {
  handlerSource,
  interfaceFields,
  jsonBodyKeys,
  keysOf,
  libSource,
  objectLiteralKeys,
  prismaModelFields,
  responseSchema,
  routeSource,
  type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const parse = (src: string) => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Unwraps `(…)`, `x as T` and `x satisfies T`. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** The object literal an expression evaluates to: a literal, `xs.map((x) => ({ … }))`, or an IIFE returning one. */
function literalOf(e: ts.Expression): ts.ObjectLiteralExpression | null {
  e = unwrap(e);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    const fn = ts.isArrowFunction(callee) || ts.isFunctionExpression(callee) ? callee : e.arguments[0];
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      if (!ts.isBlock(fn.body)) return literalOf(fn.body);
      const ret = fn.body.statements.find(ts.isReturnStatement);
      return ret?.expression ? literalOf(ret.expression) : null;
    }
  }
  return null;
}

/**
 * The keys of the object literal at `path` inside the first success
 * `NextResponse.json({ … })` (not an `{ error }` answer) that has it:
 * `["library"]` → the keys of `library: { … }`.
 */
function answerKeysAt(src: string, path: string[]): string[] {
  const sf = parse(src);
  let found: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "NextResponse.json" && n.arguments[0]) {
      let obj = literalOf(n.arguments[0]);
      if (obj && objectLiteralKeys(obj, sf).includes("error")) obj = null;
      for (const key of path) {
        const prop = obj?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === key);
        obj = prop ? literalOf(prop.initializer) : null;
      }
      if (obj) found = objectLiteralKeys(obj, sf);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `no answer literal at ${path.join(".")}`);
  return found;
}

/** The keys of every object literal a named function returns, in source order. */
function returnedLiteralKeys(src: string, fnName: string): string[][] {
  const sf = parse(src);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName && n.body) {
      const walk = (m: ts.Node) => {
        if (ts.isReturnStatement(m) && m.expression) {
          const obj = literalOf(m.expression);
          if (obj) out.push(objectLiteralKeys(obj, sf));
        }
        if (!ts.isFunctionLike(m) || m === n) ts.forEachChild(m, walk);
      };
      walk(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(out.length > 0, `function ${fnName} returns no object literal`);
  return out;
}

/** The string members of `[export] type <name> = "a" | "b" | …`. */
function unionMembers(src: string, name: string): string[] {
  const m = new RegExp(`type ${name} =([^;]*);`).exec(src);
  assert.ok(m, `type ${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

/** The success bodies of a handler: every `NextResponse.json({ … })` that isn't an `{ error }` answer. */
const successBodies = (src: string) => jsonBodyKeys(src).filter((keys) => !keys.includes("error"));

const props = (s: SchemaNode | undefined) => s?.properties ?? {};
const itemsOf = (s: SchemaNode | undefined) => s?.items;

test("admin user PATCH answers { id } plus the one field group it applied; disable, re-enable, purge and 2FA reset answer { ok: true }", async () => {
  const src = handlerSource("/admin/users/{id}", "patch");
  // The editable field lists live beside the route (admin-user-fields.ts).
  const fields = libSource("admin-user-fields.ts");
  const sf = parse(src);
  const fieldKeys = new Set<string>(["id"]);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "commitField") {
      // commitField(ctx, write, audit, answer, opts?)
      const arg = n.arguments[3];
      assert.ok(arg && ts.isObjectLiteralExpression(arg), "commitField's answer is an object literal");
      for (const k of objectLiteralKeys(arg, sf)) {
        if (k === "[quotaField]") ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"].forEach((q) => fieldKeys.add(q));
        else if (k === "[notifKey]") {
          const notif = /export const USER_NOTIF_KEYS = \[([^\]]*)\] as const;/.exec(fields)?.[1] ?? "";
          assert.ok(notif, "the notification switches are listed in USER_NOTIF_KEYS");
          for (const m of notif.matchAll(/"(\w+)"/g)) fieldKeys.add(m[1]);
        } else fieldKeys.add(k);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // The quota handler's field is one of USER_QUOTA_FIELDS; the role handler answers { id, role }.
  assert.match(fields, /export const USER_QUOTA_FIELDS = \["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"\] as const;/);
  assert.match(src, /return commitField\([\s\S]*?\{ \[quotaField\]: nextVal \}/);
  assert.ok(jsonBodyKeys(src).some((k) => k.join() === "id,role"), "the role branch answers { id, role }");
  fieldKeys.add("role");
  const patch = await responseSchema("/admin/users/{id}", "patch", "200");
  assert.deepEqual(keysOf(patch), [...fieldKeys].sort());
  assert.deepEqual(patch.required, ["id"]);
  assert.equal(props(patch).permissions?.type, "string", "permissions answer as a decimal string");
  assert.match(src, /\{ permissions: parsed\.toString\(\) \}/);

  for (const [path, method] of [
    ["/admin/users/{id}", "delete"],
    ["/admin/users/{id}/reactivate", "post"],
    ["/admin/users/{id}/purge", "post"],
    ["/admin/users/{id}/mfa", "delete"],
  ] as const) {
    const bodies = successBodies(handlerSource(path, method));
    assert.ok(bodies.length > 0, `${method} ${path}`);
    for (const keys of bodies) assert.deepEqual(keys, ["ok"], `${method} ${path}`);
    const schema = await responseSchema(path, method, "200");
    assert.deepEqual(keysOf(schema), ["ok"], `${method} ${path}`);
    assert.deepEqual(props(schema).ok?.enum, [true], `${method} ${path}`);
  }
});

test("PATCH /admin/oidc-allowlist answers the policy as saved with unreadable: false", async () => {
  const schema = await responseSchema("/admin/oidc-allowlist", "patch", "200");
  const src = handlerSource("/admin/oidc-allowlist", "patch");
  assert.deepEqual(keysOf(schema), successBodies(src).at(-1));
  assert.match(src, /NextResponse\.json\(\{ allowlist: result\.value, unreadable: false \}\)/);
  assert.deepEqual(props(schema).unreadable?.enum, [false]);
  assert.equal(props(schema).allowlist?.$ref, "#/components/schemas/OidcAllowlist");
});

test("media server instances document the view the route builds — credentials only as has* flags", async () => {
  const src = routeSource("/admin/media-instances");
  const [plexView, jellyfinView] = returnedLiteralKeys(src, "instanceView");
  const get = await responseSchema("/admin/media-instances", "get", "200");
  const post = await responseSchema("/admin/media-instances", "post", "200");
  assert.deepEqual(keysOf(get), answerKeysAt(handlerSource("/admin/media-instances", "get"), []));
  assert.deepEqual(keysOf(post), successBodies(handlerSource("/admin/media-instances", "post")).at(-1));
  const plex = itemsOf(props(get).plex);
  const jellyfin = itemsOf(props(get).jellyfin);
  assert.deepEqual(keysOf(plex), plexView);
  assert.deepEqual(keysOf(jellyfin), jellyfinView);
  // Every key is always sent, and each shape is told apart by its own required keys.
  assert.deepEqual([...(plex?.required ?? [])].sort(), plexView);
  assert.deepEqual([...(jellyfin?.required ?? [])].sort(), jellyfinView);
  assert.deepEqual(itemsOf(props(post).instances)?.oneOf, [plex, jellyfin]);
  assert.deepEqual(keysOf(props(get).versions), ["jellyfin", "plex"]);
  assert.equal(props(post).version?.pattern, "^[0-9a-f]{64}$");
  assert.match(src, /createHash\("sha256"\)[\s\S]*?\.digest\("hex"\)/);

  // No credential is ever documented or sent — only whether one is stored.
  const credential = /token|apikey|secret|password/i;
  for (const keys of [plexView, jellyfinView, keysOf(plex), keysOf(jellyfin)]) {
    for (const k of keys) assert.ok(!credential.test(k) || /^has[A-Z]/.test(k), `credential field ${k}`);
  }
  assert.ok(plexView.includes("hasAdminToken") && jellyfinView.includes("hasApiKey"));
  assert.match(src, /hasAdminToken: !!map\[plexSettingKey\(slug, "AdminToken"\)\]/);
  assert.match(src, /hasApiKey: !!map\[jellyfinSettingKey\(slug, "ApiKey"\)\]/);
});

test("the never-watched page documents its title and season rows, the applied query and the summary, field for field", async () => {
  const report = libSource("never-watched-report.ts");
  const verdict = libSource("never-watched.ts");
  const get = await responseSchema("/admin/never-watched", "get", "200");
  const reportFields = interfaceFields(report, "NeverWatchedReport").filter((k) => k !== "titles" && k !== "seasons");
  assert.match(handlerSource("/admin/never-watched", "get"), /const \{ titles: _titles, seasons: _seasons, \.\.\.summary \} = report;\s*return NextResponse\.json\(\{ \.\.\.summary, query, rows, total \}\);/);
  assert.deepEqual(keysOf(get), [...reportFields, "query", "rows", "total"].sort());
  const [titleRow, seasonRow] = itemsOf(props(get).rows)?.oneOf ?? [];
  assert.deepEqual(keysOf(titleRow), interfaceFields(report, "NwTitleRow"));
  assert.deepEqual(keysOf(seasonRow), interfaceFields(report, "NwSeasonRow"));
  assert.deepEqual(props(titleRow).kind?.enum, ["title"]);
  assert.deepEqual(props(seasonRow).kind?.enum, ["season"]);
  assert.match(report, /cleanup: \{ matched: CleanupRule\[\]; excludedBy: CleanupExclusion\[\]; candidate: boolean \};/);
  assert.deepEqual(keysOf(props(titleRow).cleanup), ["candidate", "excludedBy", "matched"]);
  assert.deepEqual(keysOf(itemsOf(props(titleRow).arr)), interfaceFields(report, "NwArrCopy"));
  assert.deepEqual(keysOf(props(get).query), interfaceFields(verdict, "NwQuery"));

  // Watched titles and seasons are left out of the report, so no row is `watched`.
  assert.match(report, /if \(t\.watch\.state === "watched"\) \{[\s\S]*?continue;/);
  assert.match(report, /if \(s\.state === "watched"\) continue;/);
  const states = unionMembers(verdict, "NwState").filter((s) => s !== "watched");
  assert.deepEqual([...(props(titleRow).state?.enum ?? [])].sort(), states);
  assert.deepEqual([...(props(seasonRow).state?.enum ?? [])].sort(), states);
  assert.deepEqual((props(titleRow).reason?.enum ?? []).filter((r) => r !== null).sort(), unionMembers(verdict, "NwReason"));
  // The rule and exclusion unions live in the zero-import list module library-cleanup.ts re-exports.
  const cleanup = libSource("library-cleanup-keys.ts");
  assert.deepEqual([...(itemsOf(props(props(titleRow).cleanup).matched)?.enum ?? [])].sort(), unionMembers(cleanup, "CleanupRule"));
  assert.deepEqual([...(itemsOf(props(props(titleRow).cleanup).excludedBy)?.enum ?? [])].sort(), unionMembers(cleanup.replace(/\/\/[^\n]*/g, ""), "CleanupExclusion"));

  // The refresh (and its job poll) answers the walk's UpstreamRefreshResult.
  const upstream = libSource("upstream-watch-data.ts");
  const refresh = await responseSchema("/admin/never-watched/refresh", "post", "200");
  assert.deepEqual(await responseSchema("/admin/never-watched/refresh", "get", "200"), refresh);
  assert.deepEqual(keysOf(refresh), interfaceFields(upstream, "UpstreamRefreshResult"));
  assert.deepEqual(keysOf(itemsOf(props(refresh).servers)), interfaceFields(upstream, "UpstreamServerResult"));
  assert.deepEqual([...(props(itemsOf(props(refresh).servers)).health?.enum ?? [])].sort(), unionMembers(verdict, "NwUpstreamHealth"));
  assert.match(routeSource("/admin/never-watched/refresh"), /const result = await refreshUpstreamWatch\(\{ signal \}\);[\s\S]*?return NextResponse\.json\(result\);/);
});

test("watch sync documents the page's pairs, accounts, suggestions and run state, and a run's result, field for field", async () => {
  const data = libSource("watch-sync-data.ts");
  const handler = handlerSource("/admin/watch-sync", "get");
  const get = await responseSchema("/admin/watch-sync", "get", "200");
  assert.deepEqual(keysOf(get), answerKeysAt(handler, []));
  const pair = itemsOf(props(get).pairs);
  assert.deepEqual(keysOf(pair), answerKeysAt(handler, ["pairs"]));
  assert.deepEqual(keysOf(props(get).run), answerKeysAt(handler, ["run"]));
  // The page's account and suggestion shapes are built in watch-sync-view.ts.
  const view = libSource("watch-sync-view.ts");
  const serverUser = interfaceFields(view, "ServerUserOut");
  for (const s of [props(pair).plex, props(pair).jellyfin, itemsOf(props(get).plexUsers), itemsOf(props(get).jellyfinUsers)]) {
    assert.deepEqual(keysOf(s), serverUser);
  }
  assert.match(handler, /plexUsers: plexUsers\.map\(out\)/);
  assert.match(handler, /suggestions: watchSyncSuggestions\(/);
  assert.deepEqual(keysOf(itemsOf(props(get).suggestions)), interfaceFields(view, "WatchSyncSuggestion"));
  const counts = props(pair).counts;
  assert.deepEqual(keysOf(counts), interfaceFields(data, "WatchSyncPairCounts"));
  assert.deepEqual(keysOf(props(counts).toJellyfin), interfaceFields(data, "WatchSyncMarkCounts"));

  // A run answers runWatchSync's result; a pair stores the same per-pair shape.
  const run = await responseSchema("/admin/watch-sync/run", "get", "200");
  assert.match(routeSource("/admin/watch-sync/run"), /NextResponse\.json\(await runWatchSync\(\{ signal \}\)\)/);
  // The stored result is a plain JSON copy of the pair's run result.
  assert.match(data, /lastResult: toJsonValue\(r\)/);
  assert.match(data, /function toJsonValue\(r: WatchSyncPairResult\)[^{]*\{\s*return JSON\.parse\(JSON\.stringify\(r\)\)/);
  assert.deepEqual(keysOf(run), interfaceFields(data, "WatchSyncRunResult"));
  const pairResult = itemsOf(props(run).pairs);
  assert.deepEqual(keysOf(pairResult), interfaceFields(data, "WatchSyncPairResult"));
  assert.deepEqual(keysOf(props(pair).lastResult), keysOf(pairResult));
  assert.deepEqual(keysOf(props(pairResult).toJellyfin), interfaceFields(data, "WatchSyncDirectionResult"));
  assert.deepEqual(keysOf(props(pairResult).progress), interfaceFields(data, "WatchSyncProgressResult"));

  assert.deepEqual(keysOf(await responseSchema("/admin/watch-sync", "post", "201")), successBodies(handlerSource("/admin/watch-sync", "post"))[0]);
  for (const method of ["patch", "delete"]) {
    for (const keys of successBodies(handlerSource("/admin/watch-sync/{id}", method))) assert.deepEqual(keys, ["ok"], method);
    assert.deepEqual(keysOf(await responseSchema("/admin/watch-sync/{id}", method, "200")), ["ok"], method);
  }
});

test("cleanup protection answers the saved row and the removed count", async () => {
  const post = await responseSchema("/admin/cleanup/protect", "post", "201");
  // The upsert answers the whole row (no select), so the item is the model.
  assert.match(handlerSource("/admin/cleanup/protect", "post"), /const item = await prisma\.cleanupProtection\.upsert\(\{\s*where:[^}]*\}[^}]*\},\s*create:[^\n]*\n\s*update: sent,\s*\}\);/);
  assert.deepEqual(keysOf(post), ["item"]);
  assert.deepEqual(keysOf(props(post).item), prismaModelFields("CleanupProtection"));
  const del = await responseSchema("/admin/cleanup/protect", "delete", "200");
  assert.deepEqual(keysOf(del), successBodies(handlerSource("/admin/cleanup/protect", "delete"))[0]);
});

test("notification channels answer toPublicAgent's shape everywhere: hasSecret, never the secret", async () => {
  const lib = libSource("notify-agents-admin.ts");
  const publicKeys = returnedLiteralKeys(lib, "toPublicAgent")[0];
  assert.ok(!publicKeys.includes("secret") && publicKeys.includes("hasSecret"), publicKeys.join());
  assert.match(lib, /hasSecret: !!row\.secret,/);
  const list = itemsOf(props(await responseSchema("/admin/notification-agents", "get", "200")).agents);
  const created = props(await responseSchema("/admin/notification-agents", "post", "201")).agent;
  const updated = props(await responseSchema("/admin/notification-agents/{id}", "patch", "200")).agent;
  assert.deepEqual(keysOf(list), publicKeys);
  assert.deepEqual(created, list);
  assert.deepEqual(updated, list);
  for (const k of keysOf(list)) assert.ok(!/secret|token|password/i.test(k) || k === "hasSecret", `documents ${k}`);
  assert.match(routeSource("/admin/notification-agents"), /agents: rows\.map\(toPublicAgent\)/);
  assert.match(handlerSource("/admin/notification-agents", "post"), /\{ agent: toPublicAgent\(row\) \}, \{ status: 201 \}/);
  assert.match(handlerSource("/admin/notification-agents/{id}", "patch"), /\{ agent: toPublicAgent\(row\) \}/);

  // `config` names every field any channel kind stores.
  const events = libSource("notify-events.ts");
  const configFields = new Set(["WebhookConfig", "NtfyConfig", "GotifyConfig"].flatMap((n) => interfaceFields(events, n)));
  assert.deepEqual(keysOf(props(list).config), [...configFields].sort());
  for (const keys of successBodies(handlerSource("/admin/notification-agents/{id}", "delete"))) assert.deepEqual(keys, ["ok"]);
  assert.deepEqual(keysOf(await responseSchema("/admin/notification-agents/{id}", "delete", "200")), ["ok"]);
});

test("/admin/stats documents its library, requester, disk, fulfillment and queue figures — and no disk path", async () => {
  const handler = handlerSource("/admin/stats", "get");
  const statsLib = libSource("admin-stats-data.ts");
  const arrStats = libSource("arr-stats.ts");
  const stats = await responseSchema("/admin/stats", "get", "200");
  assert.deepEqual(keysOf(stats), answerKeysAt(handler, []));
  const library = props(stats).library;
  assert.deepEqual(keysOf(library), answerKeysAt(handler, ["library"]));
  const breakdown = /const serverBreakdown = [\s\S]*?return (\{[\s\S]*?\});/.exec(handler)?.[1] ?? "";
  const breakdownKeys = [...breakdown.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keysOf(props(library).plexBreakdown), breakdownKeys);
  assert.deepEqual(props(library).jellyfinBreakdown, props(library).plexBreakdown);
  assert.deepEqual(keysOf(props(library).unique), ["movies", "series"]);
  assert.match(statsLib, /unique: \{ movies: number; series: number \};/);
  assert.deepEqual(keysOf(itemsOf(props(stats).topRequesters)), answerKeysAt(handler, ["topRequesters"]));
  const recentSelect = /take: 10,\s*select: \{([^}]*)\}/.exec(handler)?.[1] ?? "";
  assert.deepEqual(keysOf(itemsOf(props(stats).recentRequests)), [...recentSelect.matchAll(/(\w+): true/g)].map((m) => m[1]).sort());

  const disk = props(stats).diskSpace;
  assert.deepEqual(keysOf(disk), interfaceFields(arrStats, "ArrDiskSpace"));
  assert.deepEqual(keysOf(itemsOf(props(disk).extra)), interfaceFields(arrStats, "ArrInstanceDiskSpace"));
  const entryFields = interfaceFields(arrStats, "DiskSpaceEntry");
  assert.ok(entryFields.includes("path"));
  for (const entry of [itemsOf(props(disk).radarr), itemsOf(props(disk).sonarr), itemsOf(props(itemsOf(props(disk).extra)).entries)]) {
    // Every field but the mount path, which — like every filesystem path — is left out.
    assert.deepEqual(keysOf(entry), entryFields.filter((k) => k !== "path"));
  }
  const unreachable = /unreachable: Array<\{([^}]*)\}>/.exec(arrStats)?.[1] ?? "";
  assert.deepEqual(keysOf(itemsOf(props(disk).unreachable)), [...unreachable.matchAll(/(\w+):/g)].map((m) => m[1]).sort());

  const fulfillment = props(stats).fulfillment;
  assert.deepEqual(keysOf(fulfillment), interfaceFields(statsLib, "FulfillmentStats"));
  const duration = interfaceFields(statsLib, "DurationStat");
  for (const k of ["approve", "download"]) assert.deepEqual(keysOf(props(fulfillment)[k]), duration, k);
  assert.deepEqual(keysOf(props(fulfillment).total), [...duration, "avgSeconds"].sort());
  assert.match(statsLib, /total: DurationStat & \{ avgSeconds: number \| null \};/);
  assert.deepEqual(keysOf(props(stats).pendingQueue), interfaceFields(statsLib, "PendingQueue"));
});

test("/settings documents its masked map, the save's test results and the option lists — webhook tokens included", async () => {
  const settings = routeSource("/settings");
  const get = await responseSchema("/settings", "get", "200");
  assert.equal(get.type, "object");
  assert.deepEqual(get.additionalProperties, { type: "string" });
  assert.match(get.description ?? "", /mask/);
  assert.match(handlerSource("/settings", "get"), /rows\.map\(\(r\) => \[r\.key, presentSettingValue\(r\.key, r\.value\)\]\)/);
  const registry = libSource("settings-registry.ts");
  assert.match(registry, /if \(def\?\.sensitive\) return value \? MASKED_VALUE : "";/);
  assert.match(registry, /if \(def\?\.type\.kind === "url" && value\) return stripUrlUserinfo\(value\);/);

  // A 200 carries only passing tests (a failed one answers 422): each probe's
  // okKey, the email test's smtpTested, and the additive `ignored`.
  const patchSrc = handlerSource("/settings", "patch");
  assert.match(patchSrc, /if \(testFailed\) \{[\s\S]*?\{ status: 422 \}/);
  assert.match(settings, /testResults\.smtpTested = true;/);
  assert.match(patchSrc, /const extra = ignored\.length > 0 \? \{ ignored \} : \{\};/);
  const okKeys = [...settings.matchAll(/okKey: "(\w+)"/g)].map((m) => m[1]);
  assert.ok(okKeys.length >= 5, okKeys.join());
  const patch = await responseSchema("/settings", "patch", "200");
  assert.deepEqual(keysOf(patch), ["ok", ...okKeys, "smtpTested", "ignored"].sort());
  for (const k of keysOf(patch)) assert.ok(!k.endsWith("Error"), `a 200 never carries ${k}`);

  const arr = await responseSchema("/settings/arr-options", "get", "200");
  const arrSrc = handlerSource("/settings/arr-options", "get");
  assert.match(arrSrc, /NextResponse\.json\(\{ rootFolders, qualityProfiles, \.\.\.\(languageProfiles \? \{ languageProfiles \} : \{\}\) \}\)/);
  assert.match(arrSrc, /\.map\(\(f\) => \(\{ path: f\.path \}\)\)/);
  assert.deepEqual(keysOf(arr), ["languageProfiles", "qualityProfiles", "rootFolders"]);
  assert.deepEqual(keysOf(itemsOf(props(arr).rootFolders)), ["path"]);
  assert.deepEqual(keysOf(itemsOf(props(arr).qualityProfiles)), interfaceFields(libSource("arr-title.ts"), "Choice"));

  const plexLib = await responseSchema("/settings/plex/libraries", "get", "200");
  assert.deepEqual(keysOf(itemsOf(plexLib)), interfaceFields(libSource("plex-library.ts"), "PlexSection"));
  assert.match(libSource("plex-library.ts"), /\.filter\(\(d\) => d\.type === "movie" \|\| d\.type === "show"\)/);
  const jfLib = await responseSchema("/settings/jellyfin/libraries", "get", "200");
  assert.deepEqual(keysOf(itemsOf(jfLib)), interfaceFields(libSource("jellyfin-library.ts"), "JellyfinMediaFolder"));
  assert.match(libSource("jellyfin-library.ts"), /\.filter\(\(f\) => f\.CollectionType === "movies" \|\| f\.CollectionType === "tvshows"\)/);
  assert.deepEqual(props(itemsOf(jfLib)).collectionType?.enum, ["movies", "tvshows"]);

  const ratingBodies = successBodies(handlerSource("/settings/test-ratings", "post")).filter((k) => !k.includes("error"));
  for (const keys of ratingBodies) assert.deepEqual(keys, keysOf(await responseSchema("/settings/test-ratings", "post", "200")));

  // The webhook tokens: exactly the four the route answers, each a plaintext token or null.
  const hooks = await responseSchema("/settings/webhook-urls", "get", "200");
  // The route answers one field per entry of its SLOTS table.
  const slotFields = [...routeSource("/settings/webhook-urls").matchAll(/\{ field: "(\w+)", service:/g)].map((m) => m[1]).sort();
  assert.deepEqual(keysOf(hooks), slotFields);
  assert.match(handlerSource("/settings/webhook-urls", "get"), /Object\.fromEntries\(shown\.map\(/);
  for (const k of keysOf(hooks)) assert.equal(props(hooks)[k].nullable, true, k);
  assert.match(hooks.description ?? "", /ADMIN only/);
  assert.match(routeSource("/settings/webhook-urls"), /export const GET = withAdmin\(/);
});

test("PATCH /admin/server-users/{id} documents every answer its handler sends, and the ADMIN-only link", async () => {
  const schema = await responseSchema("/admin/server-users/{id}", "patch", "200");
  const src = routeSource("/admin/server-users/{id}");
  const answers = jsonBodyKeys(src).filter((k) => !k.includes("error"));
  // The two ternary branches of the policy answer are one conditional, so read them from the source.
  assert.match(src, /\{ ok: true, pushed: true \}/);
  assert.match(src, /\{ ok: true, pushed: false, warning: t\(/);
  assert.deepEqual(answers, [["ok"]], "the link's answer");
  assert.deepEqual(keysOf(schema), ["ok", "pushed", "warning"]);
  assert.deepEqual(schema.required, ["ok"]);
  assert.match(src, /hasPermission\(session\.user\.permissions, Permission\.ADMIN\)\) \{\n\s+return NextResponse\.json\(\{ error: t\("apiAdmin\.serverUsers\.onlyAdminLink"\) \}, \{ status: 403 \}\);/);
});

test("the secrets an admin settings write takes are writeOnly, and no admin success answer documents them", async () => {
  const { getSpec } = await import("./_openapi-spec.mts");
  const spec = await getSpec();
  const SECRET = new Set(["apiKey", "webhookSecret", "adminToken", "secret"]);
  const writes: string[] = [];
  const leaks: string[] = [];
  const walk = (node: SchemaNode | undefined, at: string, inResponse: boolean) => {
    if (!node) return;
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      if (SECRET.has(k)) (inResponse ? leaks : writes).push(`${at}.${k}${v.writeOnly === true ? "" : " (not writeOnly)"}`);
      walk(v, `${at}.${k}`, inResponse);
    }
    walk(node.items, `${at}[]`, inResponse);
    for (const part of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) walk(part, at, inResponse);
  };
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      walk(op.requestBody?.content["application/json"]?.schema, `${method.toUpperCase()} ${path} body`, false);
      for (const [status, res] of Object.entries(op.responses)) {
        // Only the admin surfaces store secrets; a TOTP setup or QuickConnect answers its own one-time secret by design.
        if (status.startsWith("2") && /^\/(admin|settings)(\/|$)/.test(path)) {
          walk(res.content?.["application/json"]?.schema, `${method.toUpperCase()} ${path} ${status}`, true);
        }
      }
    }
  }
  assert.ok(writes.length >= 6, writes.join("\n"));
  assert.deepEqual(writes.filter((w) => w.endsWith("(not writeOnly)")), []);
  assert.deepEqual(leaks, []);
});
