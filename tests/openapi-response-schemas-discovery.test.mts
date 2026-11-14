// The discovery reads' response schemas in the OpenAPI document are pinned to
// the types and handlers they describe: the shared TmdbMedia component to
// TmdbMedia (src/lib/tmdb-types.ts), each list's envelope to the object its
// handler answers, and the detail/person/season payloads to their interfaces.
// A field added to or dropped from one side goes red here.

import {
  getSpec,
  responseSchema,
  keysOf,
  handlerSource,
  routeSource,
  libSource,
  interfaceFields,
  jsonBodyKeys,
  type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const TMDB_REF = "#/components/schemas/TmdbMedia";
const tmdbTypes = libSource("tmdb-types.ts");

/** The success body's keys: the one `NextResponse.json({ … })` that isn't `{ error }`. */
function successKeys(path: string, method = "get"): string[] {
  const bodies = jsonBodyKeys(handlerSource(path, method)).filter((k) => !(k.length === 1 && k[0] === "error"));
  assert.equal(bodies.length, 1, `${path}: expected one success body, found ${JSON.stringify(bodies)}`);
  return bodies[0];
}

/** A property's type node inside `interface <iface>` of a source file. */
function memberType(src: string, iface: string, prop: string): ts.TypeNode {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.TypeNode | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === iface) {
      for (const m of n.members) {
        if (ts.isPropertySignature(m) && (m.name as ts.Identifier).text === prop) found = m.type;
      }
    } else ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `${iface}.${prop} not found`);
  return found;
}
/** The type literal inside a type node (through `T[]`, `T | null`). */
function literalOf(node: ts.TypeNode): ts.TypeLiteralNode {
  if (ts.isTypeLiteralNode(node)) return node;
  if (ts.isArrayTypeNode(node)) return literalOf(node.elementType);
  if (ts.isUnionTypeNode(node)) {
    const lit = node.types.find((t) => ts.isTypeLiteralNode(t) || ts.isArrayTypeNode(t));
    assert.ok(lit, "no type literal in the union");
    return literalOf(lit);
  }
  assert.fail(`not a type literal: ${ts.SyntaxKind[node.kind]}`);
}
const literalKeys = (lit: ts.TypeLiteralNode) =>
  lit.members.filter(ts.isPropertySignature).map((m) => (m.name as ts.Identifier).text).sort();
function literalMember(lit: ts.TypeLiteralNode, name: string): ts.TypeNode {
  const m = lit.members.filter(ts.isPropertySignature).find((x) => (x.name as ts.Identifier).text === name);
  assert.ok(m?.type, `member ${name} not found`);
  return m.type;
}
/** The string literals of a union type node, e.g. `"a" | "b"`. */
const unionStrings = (node: ts.TypeNode): string[] =>
  (ts.isUnionTypeNode(node) ? [...node.types] : [node])
    .filter((t): t is ts.LiteralTypeNode => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
    .map((t) => (t.literal as ts.StringLiteral).text);

/** The non-optional members of an interface (what a body always carries), sorted. */
function requiredFields(src: string, iface: string): string[] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let out: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === iface) {
      out = n.members.filter((m) => ts.isPropertySignature(m) && !m.questionToken).map((m) => (m.name as ts.Identifier).text).sort();
    } else ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(out, `interface ${iface} not found`);
  return out;
}

test("the TmdbMedia component documents every TmdbMedia field the availability chokepoint can send", async () => {
  const spec = await getSpec();
  const media = spec.components.schemas.TmdbMedia;
  assert.ok(media, "components.schemas.TmdbMedia");
  // arrInstances survives only a direct attachArrPending call; attachAllAvailability,
  // which every discovery read goes through, never copies it — so it is left out.
  assert.doesNotMatch(libSource("attach-all.ts"), /arrInstances/);
  assert.deepEqual(keysOf(media), interfaceFields(tmdbTypes, "TmdbMedia").filter((k) => k !== "arrInstances"));
  assert.deepEqual([...(media.required ?? [])].sort(), requiredFields(tmdbTypes, "TmdbMedia"));

  const p = media.properties ?? {};
  assert.deepEqual(keysOf(p.seasons.items), interfaceFields(tmdbTypes, "TmdbSeason"));
  for (const k of ["watchProviders", "studioList", "genreList", "keywordList"]) {
    assert.deepEqual(keysOf(p[k].items), literalKeys(literalOf(memberType(tmdbTypes, "TmdbMedia", k))), k);
  }
  assert.deepEqual(p.watchProviders.items?.properties?.type.enum,
    unionStrings(literalMember(literalOf(memberType(tmdbTypes, "TmdbMedia", "watchProviders")), "type")));

  const because = literalOf(memberType(tmdbTypes, "TmdbMedia", "recommendedBecause"));
  assert.deepEqual(keysOf(p.recommendedBecause), literalKeys(because));
  assert.deepEqual(p.recommendedBecause.properties?.source.enum, unionStrings(literalMember(because, "source")));
  const seeds = literalOf(literalMember(because, "seeds"));
  assert.deepEqual(keysOf(p.recommendedBecause.properties?.seeds.items), literalKeys(seeds));
  assert.deepEqual(p.recommendedBecause.properties?.seeds.items?.properties?.source.enum, unionStrings(literalMember(seeds, "source")));
  assert.deepEqual(p.matchTier.enum, unionStrings(memberType(tmdbTypes, "TmdbMedia", "matchTier")));
  assert.deepEqual(p.mediaType.enum, unionStrings(
    (ts.createSourceFile("x.ts", tmdbTypes, ts.ScriptTarget.Latest, true).statements
      .find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "MediaType"))!.type,
  ));
});

test("each discovery list documents the envelope its handler answers, its titles as TmdbMedia", async () => {
  const lists: Array<[string, string[]]> = [
    ["/browse", ["items"]],
    ["/home", ["featured"]],
    ["/recommendations", ["items"]],
    ["/upcoming", ["items"]],
    ["/top-rated", ["movies", "tv"]],
  ];
  for (const [path, titleLists] of lists) {
    const schema = await responseSchema(path, "get", "200");
    assert.deepEqual(keysOf(schema), successKeys(path), path);
    assert.deepEqual([...(schema.required ?? [])].sort(), successKeys(path), `${path} required`);
    for (const k of titleLists) assert.equal(schema.properties?.[k].items?.$ref, TMDB_REF, `${path} ${k}`);
  }

  // /home's rails: each { id, title, items } as the handler builds them, and every
  // rail id it can send named in the description.
  const home = await responseSchema("/home", "get", "200");
  const rail = home.properties?.carousels.items;
  assert.equal(rail?.properties?.items.items?.$ref, TMDB_REF);
  const homeSrc = handlerSource("/home", "get");
  // Rails built inline (`{ id, title: t(…), items }`) and the TMDB rails' table
  // (`{ id, titleKey, raw }`, each mapped to `{ id: r.id, title: t(r.titleKey), items }`).
  const railBodies = [
    ...[...homeSrc.matchAll(/\{ id: "([\w-]+)", title: t\([^)]*\), items: /g)].map((m) => m[1]),
    ...[...homeSrc.matchAll(/\{ id: "([\w-]+)", titleKey: "[\w.]+", raw: /g)].map((m) => m[1]),
  ];
  assert.match(homeSrc, /tmdbRails\.map\(\(r\) => \(\{ id: r\.id, title: t\(r\.titleKey\), items: /);
  assert.ok(railBodies.length >= 9, railBodies.join(","));
  assert.deepEqual(keysOf(rail), ["id", "items", "title"]);
  const described = home.properties?.carousels.description ?? "";
  for (const id of railBodies) assert.match(described, new RegExp(`\\b${id}\\b`), id);

  // /top-rated's sortBy is the TopRatedSort the query parser falls back within.
  const topRated = await responseSchema("/top-rated", "get", "200");
  const sortType = /export type TopRatedSort = ([^;]+);/.exec(libSource("top-rated.ts"))?.[1] ?? "";
  assert.deepEqual(topRated.properties?.sortBy.enum, [...sortType.matchAll(/"(\w+)"/g)].map((m) => m[1]));
});

test("GET /search documents its results as TmdbMedia, the chokepoint's output, without ratings", async () => {
  const schema = await responseSchema("/search", "get", "200");
  assert.equal(schema.type, "array");
  assert.equal(schema.items?.$ref, TMDB_REF);
  const src = handlerSource("/search", "get");
  assert.match(src, /const enriched = await attachAllAvailability\(results, session\.user\.id, \{ skipRatings: true, show4k, includeHidden: true \}\);/);
  assert.match(src, /return NextResponse\.json\(enriched\);/);
});

test("/popular documents its envelope, its sort set and each title's play counts", async () => {
  const schema = await responseSchema("/popular", "get", "200");
  assert.deepEqual(keysOf(schema), successKeys("/popular"));
  const src = routeSource("/popular");
  const sorts = /POPULAR_SORTS: readonly PopularSort\[\] = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
  assert.deepEqual([...(schema.properties?.sort.enum ?? [])].sort(), [...sorts.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort());
  for (const k of ["movies", "tv"]) {
    const item = schema.properties?.[k].items as SchemaNode;
    assert.equal(item.allOf?.[0].$ref, TMDB_REF, k);
    // Each title is resolvePopularTitles' PopularTitle (src/lib/popular-titles.ts).
    const counts = /export type PopularTitle = TmdbMedia & \{([^}]*)\}/.exec(libSource("popular-titles.ts"))?.[1] ?? "";
    assert.ok(counts.length > 0, "PopularTitle not found");
    assert.deepEqual(keysOf(item.allOf?.[1]), [...counts.matchAll(/(\w+):/g)].map((m) => m[1]).sort(), k);
  }
});

test("GET /tv/{id}/season/{n} documents TVSeasonResponse and TMDB's episode fields", async () => {
  const schema = await responseSchema("/tv/{id}/season/{n}", "get", "200");
  const src = routeSource("/tv/{id}/season/{n}");
  assert.deepEqual(keysOf(schema), interfaceFields(src, "TVSeasonResponse"));
  assert.deepEqual(keysOf(schema.properties?.episodes.items), interfaceFields(tmdbTypes, "TmdbEpisode"));
  assert.deepEqual(
    (schema.properties?.source.enum ?? []).filter((v) => v !== null),
    unionStrings(memberType(src, "TVSeasonResponse", "source")),
  );
  assert.equal(schema.properties?.source.nullable, true);
});

test("GET /person/{id} documents PersonDetails and every credit field, the request token bound to the caller", async () => {
  const schema = await responseSchema("/person/{id}", "get", "200");
  assert.deepEqual(keysOf(schema), interfaceFields(tmdbTypes, "PersonDetails"));
  assert.deepEqual([...(schema.required ?? [])].sort(), requiredFields(tmdbTypes, "PersonDetails"));
  const credit = schema.properties?.credits.items;
  assert.deepEqual(keysOf(credit), interfaceFields(tmdbTypes, "PersonCredit"));
  // The per-credit token is the caller's own `_token` for POST /requests: minted
  // for the signed-in user and the credit's title, never another account's.
  assert.match(credit?.properties?.requestToken.description ?? "", /bound to the title and the caller/);
  assert.match(libSource("person.ts"), /requestToken: generateRequestToken\(c\.id, dbType, session\.user\.id\),/);
});

test("GET /media/{type}/{tmdbId} documents the title plus every field the handler adds", async () => {
  const schema = await responseSchema("/media/{type}/{tmdbId}", "get", "200");
  assert.equal(schema.allOf?.[0].$ref, TMDB_REF);
  const extra = schema.allOf?.[1];
  const body = successKeys("/media/{type}/{tmdbId}");
  assert.ok(body.includes("...withAvailability"), body.join(","));
  const src = routeSource("/media/{type}/{tmdbId}");
  // The handler spreads two helpers' results into the body; their keys are the
  // top-level keys of each helper's returned object literal.
  const helperKeys = (fn: string) => {
    const body = new RegExp(`function ${fn}\\([^]*?\\n  return \\{\\n([^]*?)\\n  \\};`).exec(src)?.[1] ?? "";
    const keys = [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
    assert.ok(keys.length > 0, `${fn} keys not found`);
    return keys;
  };
  assert.ok(body.includes("...extras") && body.includes("...flags"), body.join(","));
  const expected = [
    ...body.filter((k) => !k.startsWith("...")),
    ...helperKeys("detailExtras"),
    ...helperKeys("viewerTitleFlags"),
  ].sort();
  assert.deepEqual(keysOf(extra), expected);

  const liteKeys = [...(/function lite\(m: TmdbMedia\) \{\s*return \{([^}]*)\};/.exec(src)?.[1] ?? "").matchAll(/(\w+):/g)]
    .map((m) => m[1]).sort();
  assert.ok(liteKeys.length >= 5, liteKeys.join(","));
  assert.deepEqual(keysOf(extra?.properties?.similar.items), liteKeys);
  assert.deepEqual(keysOf(extra?.properties?.collection.properties?.items.items), liteKeys);
  assert.deepEqual(keysOf(extra?.properties?.collection), ["id", "items", "name"]);
  assert.deepEqual(keysOf(extra?.properties?.cast.items), interfaceFields(tmdbTypes, "CastMember"));
  const providers = /\.map\(\(p\) => \(\{ ([^}]*) \}\)\)/.exec(src)?.[1] ?? "";
  assert.deepEqual(keysOf(extra?.properties?.watchProviders.items), [...providers.matchAll(/(\w+): p\./g)].map((m) => m[1]).sort());
  // requested4kByMe is sent only to a viewer who can see 4K state.
  assert.match(src, /requested4kByMe: show4k \? my4kRequest !== null : undefined,/);
  assert.ok(!extra?.required?.includes("requested4kByMe"));
});

test("GET /config/public documents every donation link the handler sends, each sanitized to http(s) or null", async () => {
  const schema = await responseSchema("/config/public", "get", "200");
  const donate = schema.properties?.donate;
  const src = handlerSource("/config/public", "get");
  const sent = [...(/donate: \{([\s\S]*?)\n {4}\},/.exec(src)?.[1] ?? "").matchAll(/^\s+(\w+): safeExternalHref\(cfg\.(\w+)\) \?\? null,$/gm)];
  assert.ok(sent.length >= 6, `found ${sent.length} sanitized donation values`);
  assert.deepEqual(keysOf(donate), sent.map((m) => m[1]).sort());
  assert.deepEqual([...(donate?.required ?? [])].sort(), sent.map((m) => m[1]).sort());
  for (const k of keysOf(donate)) assert.equal(donate?.properties?.[k].nullable, true, k);
  // …and the setting each reads is exactly the registered donation set.
  const registered = [...(/DONATION_SETTING_KEYS = \[([\s\S]*?)\]/.exec(libSource("donations.ts"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(sent.map((m) => m[2]).sort(), registered.sort());
});
