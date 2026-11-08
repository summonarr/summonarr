// OpenAPI response schemas of the admin Radarr/Sonarr surface — the instance
// registry, the Download Queue's actions, the title manager, the history and
// blocklist writes, the arr calendar, the monitor setting and the Arr System
// tabs — pinned to the projections and handlers they describe, so a field a
// handler adds or drops (or a secret the spec starts advertising) goes red here.

import {
  getSpec,
  responseSchema,
  keysOf,
  handlerSource,
  routeSource,
  libSource,
  interfaceFields,
  jsonBodyKeys,
  objectLiteralKeys,
  type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const parse = (src: string) => ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The keys of the object literal `function <name>` returns (its first `return { … }`), sorted. */
function returnedObjectKeys(src: string, fn: string): string[] {
  const sf = parse(src);
  let keys: string[] | null = null;
  const visit = (n: ts.Node, inside: boolean) => {
    if (keys) return;
    const here = inside || (ts.isFunctionDeclaration(n) && n.name?.text === fn);
    if (here && ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
      keys = objectLiteralKeys(n.expression, sf);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, here));
  };
  visit(sf, false);
  assert.ok(keys, `function ${fn} returns no object literal`);
  return keys;
}

/** The string literals of `export type <name> = "a" | "b" | …`, in source order. */
function unionLiterals(src: string, name: string): string[] {
  const sf = parse(src);
  let out: string[] | null = null;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === name && ts.isUnionTypeNode(n.type)) {
      out = n.type.types.map((t) => {
        assert.ok(ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal), `${name} has a non-string member`);
        return (t.literal as ts.StringLiteral).text;
      });
    }
  });
  assert.ok(out, `type ${name} not found`);
  return out;
}

/** The key list of the one object literal a handler answers that contains `key`. */
function bodyWith(src: string, key: string): string[] {
  const bodies = jsonBodyKeys(src).filter((k) => k.includes(key));
  assert.equal(bodies.length, 1, `expected one answer carrying \`${key}\`, found ${bodies.length}`);
  return bodies[0];
}

const without = (keys: string[], ...drop: string[]) => keys.filter((k) => !drop.includes(k));
const prop = (schema: SchemaNode | undefined, ...path: string[]): SchemaNode | undefined =>
  path.reduce<SchemaNode | undefined>((s, k) => (k === "[]" ? s?.items : s?.properties?.[k]), schema);
const SECRETISH = /apikey|secret|token|password|credential/i;

test("the arr instance lists send only has* flags for secrets, field for field the instance view", async () => {
  const get = await responseSchema("/admin/arr-instances", "get", "200");
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr-instances", "get"))[0], ["radarr", "sonarr", "versions"]);
  assert.deepEqual(keysOf(get), ["radarr", "sonarr", "versions"]);
  const view = keysOf(prop(get, "radarr", "[]"));
  // instanceView builds every listed instance's answer, GET and the save alike.
  const projected = returnedObjectKeys(routeSource("/admin/arr-instances"), "instanceView");
  assert.deepEqual(view, projected);
  assert.deepEqual(prop(get, "sonarr", "[]"), prop(get, "radarr", "[]"));
  const post = await responseSchema("/admin/arr-instances", "post", "200");
  assert.deepEqual(prop(post, "instances", "[]"), prop(get, "radarr", "[]"));
  assert.deepEqual(bodyWith(handlerSource("/admin/arr-instances", "post"), "testResults"), ["instances", "ok", "removed", "testResults", "version"]);
  // Secrets are never projected nor documented — only whether one is stored.
  for (const keys of [view, projected]) {
    assert.deepEqual(keys.filter((k) => SECRETISH.test(k)), ["hasApiKey", "hasWebhookSecret"]);
  }
});

// The save's connection tests are keyed by slug (`Record<slug, { version } | { error }>`),
// not a list: the spec once documented an array of { slug, ok, message } nobody sent.
test("the arr instance save documents testResults as the slug-keyed map the handler builds", async () => {
  const post = await responseSchema("/admin/arr-instances", "post", "200");
  const tr = prop(post, "testResults");
  assert.equal(tr?.type, "object");
  assert.deepEqual(keysOf(tr?.additionalProperties as SchemaNode | undefined).sort(), ["error", "version"]);
  assert.match(handlerSource("/admin/arr-instances", "post"), /const testResults: Record<string, \{ version\?: string; error\?: string \}> = \{\};/);
});

test("the title manager documents one ArrTitle shape everywhere, field for field the projection — minus the title's folder", async () => {
  const fields = interfaceFields(libSource("arr-title.ts"), "ArrTitle");
  assert.ok(fields.includes("path"), "ArrTitle still projects `path`");
  const get = await responseSchema("/admin/arr/title", "get", "200");
  const title = prop(get, "title");
  assert.deepEqual(keysOf(title), without(fields, "path"));
  assert.deepEqual(keysOf(prop(title, "seasons", "[]")), interfaceFields(libSource("arr-title.ts"), "TitleSeason"));
  assert.deepEqual(keysOf(get), interfaceFields(libSource("arr-title-data.ts"), "TitleState"));
  // The same shape after an edit, an episode monitor change and in the removal dry run.
  const patch = await responseSchema("/admin/arr/title", "patch", "200");
  const episodes = await responseSchema("/admin/arr/title/episodes", "patch", "200");
  const remove = await responseSchema("/admin/arr/title/remove", "post", "200");
  for (const other of [prop(patch, "title"), prop(episodes, "title"), prop(remove.oneOf?.[0], "title")]) {
    assert.deepEqual(keysOf(other), keysOf(title));
    assert.deepEqual(other?.properties, title?.properties);
  }
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr/title", "patch")).filter((k) => !k.includes("error")), [["title"], ["title"]]);
  assert.equal(prop(patch, "title")?.nullable, true);
  assert.equal(prop(episodes, "title")?.nullable, true);
});

test("adding and removing a title document the add choices, the dry run and the executed removal", async () => {
  const lifecycle = libSource("arr-title-lifecycle.ts");
  const add = await responseSchema("/admin/arr/title/add", "get", "200");
  assert.deepEqual(keysOf(add), interfaceFields(lifecycle, "AddChoices"));
  assert.deepEqual(keysOf(prop(add, "preview")), interfaceFields(lifecycle, "AddPreview"));
  assert.deepEqual(keysOf(prop(add, "defaults")), [...(/defaults: \{([^}]*)\}/.exec(lifecycle)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]).sort());
  assert.deepEqual(keysOf(prop(add, "rootFolders", "[]")), interfaceFields(libSource("arr-title.ts"), "RootFolderChoice"));
  assert.deepEqual(keysOf(prop(add, "qualityProfiles", "[]")), interfaceFields(libSource("arr-title.ts"), "Choice"));
  assert.match(lifecycle, /export async function addTitle\([^)]*\): Promise<\{ arrId: number \| null; title: string \}>/);
  assert.deepEqual(keysOf(await responseSchema("/admin/arr/title/add", "post", "201")), ["arrId", "title"]);

  const remove = await responseSchema("/admin/arr/title/remove", "post", "200");
  const [dry, executed] = remove.oneOf ?? [];
  assert.deepEqual(keysOf(dry), interfaceFields(lifecycle, "RemovalPlan"));
  assert.deepEqual(keysOf(prop(dry, "requests")), interfaceFields(lifecycle, "RequestCounts"));
  assert.deepEqual(keysOf(executed), bodyWith(handlerSource("/admin/arr/title/remove", "post"), "requestsStamped"));
  // The two answers can't be mistaken for each other.
  assert.ok(dry.required?.every((k) => !executed.required?.includes(k)));
});

test("the title's episodes, files, renames, history and commands are documented field for field", async () => {
  const titleLib = libSource("arr-title.ts");
  const episodes = await responseSchema("/admin/arr/title/episodes", "get", "200");
  assert.deepEqual(keysOf(episodes), bodyWith(handlerSource("/admin/arr/title/episodes", "get"), "episodes"));
  assert.deepEqual(keysOf(prop(episodes, "episodes", "[]")), interfaceFields(titleLib, "TitleEpisode"));
  assert.deepEqual(keysOf(await responseSchema("/admin/arr/title/episodes", "patch", "200")), ["title", "updated"]);
  assert.match(libSource("arr-title-data.ts"), /Promise<\{ updated: number; title: ArrTitle \| null \}>/);

  // Files: the listing (its absolute path left out), and the delete's count — which the job poll replays.
  const files = await responseSchema("/admin/arr/title/files", "get", "200");
  const [listing, replay] = files.oneOf ?? [];
  const file = prop(listing, "files", "[]");
  assert.deepEqual(keysOf(file), without(interfaceFields(titleLib, "TitleFile"), "path"));
  assert.deepEqual(keysOf(prop(file, "media")), interfaceFields(titleLib, "TitleFileMedia"));
  const deleted = await responseSchema("/admin/arr/title/files", "delete", "200");
  const deleteBodies = jsonBodyKeys(handlerSource("/admin/arr/title/files", "delete")).filter((k) => k.includes("deleted"));
  assert.deepEqual(deleteBodies, [["deleted", "error"], ["deleted"]], "the 502 part-way answer and the 200");
  assert.deepEqual(keysOf(deleted), deleteBodies[1]);
  assert.deepEqual(replay?.properties, deleted.properties);
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr/title/files", "get")), [["files"]]);

  const rename = await responseSchema("/admin/arr/title/rename", "get", "200");
  assert.deepEqual(keysOf(prop(rename, "files", "[]")), interfaceFields(titleLib, "RenamePreview"));
  const renamed = await responseSchema("/admin/arr/title/rename", "post", "202");
  assert.deepEqual(keysOf(renamed), bodyWith(handlerSource("/admin/arr/title/rename", "post"), "commandIds"));
  assert.equal(prop(renamed, "files")?.type, "integer");

  const history = await responseSchema("/admin/arr/title/history", "get", "200");
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr/title/history", "get")), [["events"]]);
  const arrHistory = await responseSchema("/admin/arr/history", "get", "200");
  assert.deepEqual(prop(history, "events", "[]"), prop(arrHistory, "records", "[]"), "the title's history is the history page's projected record");

  const command = await responseSchema("/admin/arr/title/command", "post", "202");
  const commandFields = [...interfaceFields(libSource("arr-title-data.ts"), "TitleCommandResult"), ...interfaceFields(libSource("arr-missing-data.ts"), "MissingSearchResult")];
  assert.deepEqual(keysOf(command), [...new Set(commandFields)].sort());
});

test("the plain acknowledgements and counts of the queue, history, blocklist and task writes", async () => {
  for (const [path, method] of [
    ["/admin/queue/remove", "post"],
    ["/admin/queue/grab", "post"],
    ["/admin/arr/title/releases", "post"],
    ["/admin/arr/history/failed", "post"],
    ["/admin/arr/tasks", "delete"],
  ] as const) {
    const schema = await responseSchema(path, method, "200");
    assert.deepEqual(prop(schema, "ok")?.enum, [true], `${method} ${path}`);
    assert.deepEqual(keysOf(schema), ["ok"], `${method} ${path}`);
    assert.deepEqual(jsonBodyKeys(handlerSource(path, method)).filter((k) => !k.includes("error")).at(-1), ["ok"], `${method} ${path}`);
  }
  assert.deepEqual(keysOf(await responseSchema("/admin/arr/blocklist", "delete", "200")), bodyWith(handlerSource("/admin/arr/blocklist", "delete"), "removed"));
  assert.deepEqual(keysOf(await responseSchema("/admin/arr/blocklist/clear", "post", "202")), bodyWith(handlerSource("/admin/arr/blocklist/clear", "post"), "commandIds"));
  assert.deepEqual(keysOf(await responseSchema("/admin/arr/tasks", "post", "202")), ["id"]);
  const system = libSource("arr-system-data.ts");
  assert.match(system, /export async function runTask\([^)]*\): Promise<\{ id: number \| null \}>/);
  assert.match(system, /export async function runBulkAction\([^)]*\): Promise<\{ id: number \| null \}>/);
});

test("the import dialog's files are one shape in the listing and the preview, field for field ImportCandidate", async () => {
  const fields = interfaceFields(libSource("arr-queue-import.ts"), "ImportCandidate");
  const listing = prop(await responseSchema("/admin/queue/import", "get", "200"), "files", "[]");
  const preview = prop(await responseSchema("/admin/queue/import/preview", "post", "200"), "files", "[]");
  assert.deepEqual(keysOf(listing), fields);
  assert.deepEqual(preview?.properties, listing?.properties);
  assert.deepEqual(keysOf(prop(listing, "episodes", "[]")), interfaceFields(libSource("arr-queue-types.ts"), "QueueEpisode"));
});

test("the arr calendar documents the report and every entry field, its kinds and statuses from the code", async () => {
  const lib = libSource("arr-calendar.ts");
  const report = await responseSchema("/admin/arr/calendar", "get", "200");
  assert.deepEqual(keysOf(report), interfaceFields(libSource("arr-calendar-data.ts"), "CalendarReport"));
  const entry = prop(report, "entries", "[]");
  assert.deepEqual(keysOf(entry), interfaceFields(lib, "CalendarEntry"));
  assert.deepEqual(prop(entry, "kind")?.enum, unionLiterals(lib, "CalendarKind"));
  assert.deepEqual(prop(entry, "status")?.enum, unionLiterals(lib, "CalendarStatus"));
  assert.deepEqual(keysOf(prop(report, "instances", "[]")), interfaceFields(libSource("arr-admin.ts"), "ArrInstanceRef"));
});

test("the monitor setting's save answers the same settings object GET reads, within the code's bounds", async () => {
  const patch = prop(await responseSchema("/admin/arr-watch", "patch", "200"), "settings");
  const get = prop(await responseSchema("/admin/arr-watch", "get", "200"), "settings");
  assert.deepEqual(patch, get);
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr-watch", "patch")).at(-1), ["settings"]);
  const lib = libSource("arr-watch.ts");
  assert.equal(prop(patch, "diskLowPercent")?.minimum, Number(/MIN_DISK_LOW_PERCENT = (\d+)/.exec(lib)?.[1]));
  assert.equal(prop(patch, "diskLowPercent")?.maximum, Number(/MAX_DISK_LOW_PERCENT = (\d+)/.exec(lib)?.[1]));
});

test("Arr System's tabs and the command status read document the projected rows, never a command body or provider fields", async () => {
  const lib = libSource("arr-system.ts");
  const statuses = unionLiterals(lib, "CommandStatus");
  // The fan-out envelope every tab shares.
  const data = libSource("arr-system-data.ts");
  const errorFields = [...(/errors: Array<\{ ([^}]*) \}>/.exec(data)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]).sort();
  assert.equal(errorFields.length, 4);
  const tasks = await responseSchema("/admin/arr/tasks", "get", "200");
  assert.deepEqual(keysOf(tasks), interfaceFields(data, "InstanceReport"));
  assert.deepEqual(keysOf(prop(tasks, "errors", "[]")), errorFields);
  assert.deepEqual(keysOf(prop(tasks, "instances", "[]")), interfaceFields(libSource("arr-admin.ts"), "ArrInstanceRef"));

  const result = prop(tasks, "results", "[]");
  assert.deepEqual(keysOf(result), ["commands", "instance", "service", "tasks"]);
  assert.deepEqual(keysOf(prop(result, "tasks", "[]")), interfaceFields(lib, "ArrTask"));
  const row = prop(result, "commands", "[]");
  assert.deepEqual(keysOf(row), interfaceFields(lib, "ArrCommandRow"));
  assert.deepEqual(prop(row, "status")?.enum, statuses);

  // The command status read: ArrCommandState — the row minus `trigger`, or { id, status: "gone" }.
  const commands = await responseSchema("/admin/arr/commands", "get", "200");
  assert.deepEqual(jsonBodyKeys(handlerSource("/admin/arr/commands", "get")).filter((k) => !k.includes("error")), [["commands"]]);
  const state = prop(commands, "commands", "[]");
  assert.match(libSource("arr-command-status.ts"), /\| \{ id: number; status: "gone" \}\n\s+\| Omit<ArrCommandRow, "trigger">;/);
  assert.deepEqual(keysOf(state), without(interfaceFields(lib, "ArrCommandRow"), "trigger"));
  assert.deepEqual(prop(state, "status")?.enum, [...statuses, "gone"]);

  // Providers: the projected indexer and client, never `fields` (the provider's URL, API key, password).
  const providers = await responseSchema("/admin/arr/providers", "get", "200");
  const [report, saved] = providers.oneOf ?? [];
  const providerRow = prop(report, "results", "[]");
  const indexer = prop(providerRow, "indexers", "[]");
  const client = prop(providerRow, "downloadClients", "[]");
  assert.deepEqual(keysOf(indexer), interfaceFields(lib, "ArrIndexer"));
  assert.deepEqual(keysOf(client), interfaceFields(lib, "ArrDownloadClient"));
  assert.deepEqual(keysOf(prop(providerRow, "tags", "[]")), interfaceFields(lib, "ArrTag"));
  for (const keys of [keysOf(indexer), keysOf(client)]) {
    assert.ok(!keys.includes("fields"), "provider fields are never documented");
    assert.deepEqual(keys.filter((k) => SECRETISH.test(k)), []);
  }
  // PATCH's answer, which the job poll replays: { provider, timedOut? }.
  const patch = await responseSchema("/admin/arr/providers", "patch", "200");
  assert.deepEqual(saved?.properties, patch.properties);
  // The save itself is a helper the PATCH handler (and its background job) call.
  assert.match(routeSource("/admin/arr/providers"), /return NextResponse\.json\(timedOut \? \{ provider, timedOut: true \} : \{ provider \}\);/);
  assert.deepEqual(keysOf(patch), ["provider", "timedOut"]);
  assert.deepEqual(prop(patch, "provider")?.oneOf?.map(keysOf), [keysOf(indexer), keysOf(client)]);

  // A provider test, answered by POST and replayed by GET ?job=.
  const test = await responseSchema("/admin/arr/providers/test", "post", "200");
  assert.deepEqual(await responseSchema("/admin/arr/providers/test", "get", "200"), test);
  assert.deepEqual(keysOf(prop(test, "results", "[]")), interfaceFields(lib, "ProviderTestResult"));

  const storage = prop(await responseSchema("/admin/arr/storage", "get", "200"), "results", "[]");
  assert.deepEqual(keysOf(prop(storage, "rootFolders", "[]")), interfaceFields(lib, "ArrRootFolder"));
  assert.deepEqual(keysOf(prop(storage, "rootFolders", "[]", "unmappedFolders", "[]")), interfaceFields(lib, "UnmappedFolder"));
  assert.deepEqual(keysOf(prop(storage, "disks", "[]")), interfaceFields(lib, "ArrDisk"));

  // The handlers answer the loaders' reports as they are.
  for (const path of ["/admin/arr/tasks", "/admin/arr/storage"]) assert.match(handlerSource(path, "get"), /NextResponse\.json\(await load(Tasks|Storage)\(\)\)/);
  assert.match(handlerSource("/admin/arr/providers", "get"), /NextResponse\.json\(await loadProviders\(\)\)/);
  assert.ok((await getSpec()).paths["/admin/arr/providers"].get.responses["200"].description.includes("job"));
});
