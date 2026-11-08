// The limits a request body documents are the handler's own. Limits that live in
// a pure lib module are imported by the spec itself (CLEANUP_MAX_ITEMS,
// MAX_TITLE_FILE_IDS, BULK_REQUEST_MAX_ITEMS, the api-body-limits constants, …).
// For each of those shared constants this pins BOTH halves: the spec documents
// its value, and the handler's local limit is bound to it rather than to a
// second literal (guardrail 25 keeps the spec from importing a route file, so
// the route side is read from source).

import { getSpec, fileConstNumber, type SchemaNode } from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const spec = await getSpec();
const body = (path: string, method: string): SchemaNode => {
  const schema = spec.paths[path]?.[method]?.requestBody?.content["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} has no JSON body`);
  return schema;
};
const field = (path: string, method: string, name: string): SchemaNode => {
  const node = body(path, method).properties?.[name];
  assert.ok(node, `${method.toUpperCase()} ${path} documents no \`${name}\``);
  return node;
};
const route = (path: string) => `src/app/api${path}/route.ts`;
const LIMITS_MODULE = "src/lib/api-body-limits.ts";

// [file, local const] — the handler's own limit, which must read the shared constant.
type Binding = [file: string, local: string];

function assertBound([file, local]: Binding, shared: string): void {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(
    src,
    new RegExp(`\\bconst ${local} = ${shared};`),
    `${file}: ${local} must be the shared ${shared}, not its own literal`,
  );
}

const LIMITS: Array<{ what: string; documented: () => number | undefined; shared: string; bound: Binding }> = [
  { what: "POST /admin/queue/remove ids", documented: () => field("/admin/queue/remove", "post", "ids").maxItems, shared: "QUEUE_REMOVE_MAX_IDS", bound: [route("/admin/queue/remove"), "MAX_IDS"] },
  { what: "POST /admin/queue/grab ids", documented: () => field("/admin/queue/grab", "post", "ids").maxItems, shared: "QUEUE_GRAB_MAX_IDS", bound: [route("/admin/queue/grab"), "MAX_IDS"] },
  { what: "POST /admin/queue/import files", documented: () => field("/admin/queue/import", "post", "files").maxItems, shared: "QUEUE_IMPORT_MAX_FILES", bound: ["src/lib/arr-queue-http.ts", "MAX_FILES"] },
  { what: "POST /admin/queue/import/preview files", documented: () => field("/admin/queue/import/preview", "post", "files").maxItems, shared: "QUEUE_IMPORT_MAX_FILES", bound: ["src/lib/arr-queue-http.ts", "MAX_FILES"] },
  { what: "POST /ratings/batch items", documented: () => field("/ratings/batch", "post", "items").maxItems, shared: "RATINGS_BATCH_MAX_ITEMS", bound: [route("/ratings/batch"), "MAX_BATCH"] },
  { what: "the client ratings batcher", documented: () => field("/ratings/batch", "post", "items").maxItems, shared: "RATINGS_BATCH_MAX_ITEMS", bound: ["src/lib/client/ratings-batcher.ts", "MAX_BATCH"] },
  { what: "POST /issues/{id}/files fileIds", documented: () => field("/issues/{id}/files", "post", "fileIds").maxItems, shared: "ISSUE_FILES_MAX_IDS", bound: [route("/issues/[id]/files"), "MAX_FILES"] },
  { what: "POST /admin/arr/title/command episodeIds", documented: () => field("/admin/arr/title/command", "post", "episodeIds").maxItems, shared: "TITLE_COMMAND_MAX_EPISODES", bound: [route("/admin/arr/title/command"), "MAX_EPISODES"] },
  { what: "PATCH /admin/arr/title/episodes episodeIds", documented: () => field("/admin/arr/title/episodes", "patch", "episodeIds").maxItems, shared: "TITLE_EPISODES_MAX_IDS", bound: [route("/admin/arr/title/episodes"), "MAX_EPISODES"] },
  { what: "PATCH /requests/batch ids", documented: () => field("/requests/batch", "patch", "ids").maxItems, shared: "REQUEST_BATCH_MAX_IDS", bound: [route("/requests/batch"), "MAX_BATCH_IDS"] },
];

for (const { what, documented, shared, bound } of LIMITS) {
  test(`${what}: the documented maxItems is the handler's own limit`, () => {
    assert.equal(documented(), fileConstNumber(LIMITS_MODULE, shared));
    assertBound(bound, shared);
  });
}

// Limits stated in prose, where no keyword can carry them.
const PROSE: Array<{ what: string; text: () => string; shared: string; bound: Binding; pattern: (n: number) => RegExp }> = [
  {
    what: "PATCH /requests/batch: the permanent-decline cap",
    text: () => field("/requests/batch", "patch", "permanent").description ?? "",
    shared: "REQUEST_BATCH_MAX_PERMANENT",
    bound: [route("/requests/batch"), "MAX_PERMANENT_DECLINES"],
    pattern: (n) => new RegExp(`at most ${n} ids per permanent batch`),
  },
  {
    what: "POST /ratings/batch: the batch size in the items description",
    text: () => field("/ratings/batch", "post", "items").description ?? "",
    shared: "RATINGS_BATCH_MAX_ITEMS",
    bound: [route("/ratings/batch"), "MAX_BATCH"],
    pattern: (n) => new RegExp(`At most ${n} items`),
  },
  {
    what: "POST /admin/notification-agents: the channel limit",
    text: () => spec.paths["/admin/notification-agents"].post.description ?? "",
    shared: "NOTIFICATION_AGENTS_MAX",
    bound: ["src/lib/notify-agents-admin.ts", "MAX_AGENTS"],
    pattern: (n) => new RegExp(`At most ${n} channels`),
  },
];

for (const { what, text, shared, bound, pattern } of PROSE) {
  test(`${what} is the handler's own number`, () => {
    assert.match(text(), pattern(fileConstNumber(LIMITS_MODULE, shared)));
    assertBound(bound, shared);
  });
}
