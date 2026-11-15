// The API Docs viewer's model (src/components/admin/openapi-viewer-model.ts):
// how a schema is labelled and exemplified, what "Copy as curl" builds, and
// the spec check. Run against the real served spec as well as small cases.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/components/admin/openapi-viewer-model.ts");
const { check } = await import("../src/lib/validate.ts");

const A = { type: "object", properties: { a: { type: "integer" } } };
const B = { type: "object", properties: { b: { type: "string" } } };

test("oneOf / anyOf read as their branches, never as a bare object with no example", () => {
  assert.equal(m.typeLabel({ oneOf: [{ $ref: "#/components/schemas/Movie" }, { $ref: "#/components/schemas/Show" }] }), "Movie | Show");
  assert.equal(m.typeLabel({ type: "object", oneOf: [A, B] }), "object | object");
  assert.equal(m.typeLabel({ anyOf: [{ type: "string" }, { type: "integer", nullable: true }] }), "string | integer | null");
  assert.deepEqual(m.exampleValue({ oneOf: [A, B] }, {}), { a: 0 }, "the first branch");
  assert.deepEqual(m.exampleValue({ anyOf: [B] }, {}), { b: "string" });
  assert.deepEqual(m.exampleValue({ $ref: "#/components/schemas/Node" }, { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } } }), { child: null }, "a self-reference ends at null");
  assert.equal(m.typeLabel({ type: "array", items: { allOf: "not a list" } }), "object[]", "a malformed part is read defensively");
});

const op = (extra: object) => ({ summary: "s", responses: {}, ...extra });
const base = { origin: "https://x", serverUrl: "/api", method: "get", path: "/things/{id}", security: [{ session: [] }], schemas: {}, cookieName: "summonarr-session" };

test("the copied curl sends only required query parameters, each with a value it can run with", () => {
  const cmd = m.curlCommand({ ...base, op: op({ parameters: [
    { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
    { name: "service", in: "query", required: true, schema: { type: "string", enum: ["radarr", "sonarr"] } },
    { name: "term", in: "query", required: true, schema: { type: "string" } },
    { name: "id", in: "path", required: true },
  ] }) });
  assert.equal(cmd.split(" \\\n")[0], "curl -X GET 'https://x/api/things/ID?service=radarr&term=TERM'");
  assert.doesNotMatch(cmd, /limit=/, "an optional parameter is left out");
  assert.match(cmd, /--cookie 'summonarr-session=YOUR_SESSION_TOKEN'/);
});

test("a JSON body is an example; a file body is sent as a file with its own type", () => {
  const json = m.curlCommand({ ...base, method: "post", op: op({ requestBody: { content: { "application/json": { schema: A } } } }) });
  assert.match(json, /-H 'Content-Type: application\/json'/);
  assert.match(json, /-d '\{"a":0\}'/);
  const file = m.curlCommand({ ...base, method: "post", op: op({ requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } }) });
  assert.match(file, /-H 'Content-Type: application\/octet-stream'/);
  assert.match(file, /--data-binary @FILE/);
  assert.doesNotMatch(file, / -d /);
  assert.deepEqual(m.firstContent({ "application/octet-stream": {}, "application/json": { schema: A } })?.type, "application/json", "JSON first when declared");
});

test("operations are grouped in the spec's tag order, the rest as met", () => {
  const flat = (tag: string | undefined, key: string) => ({ key, method: "get", path: key, op: tag ? { tags: [tag] } : {} });
  const groups = m.groupByTag([flat("b", "/1"), flat(undefined, "/2"), flat("a", "/3"), flat("b", "/4")], [{ name: "a" }, { name: "b" }], "Other");
  assert.deepEqual(groups.map((g) => [g.tag, g.entries.map((e) => e.key)]), [["a", ["/3"]], ["b", ["/1", "/4"]], ["Other", ["/2"]]]);
});

test("the served spec passes the viewer's check and every operation in it is listed", async () => {
  const { SPEC_JSON } = await import("../src/lib/openapi/spec.ts");
  const spec = check(m.OpenApiSpecWire, JSON.parse(SPEC_JSON));
  assert.ok(spec.ok, spec.ok ? "" : spec.error);
  let declared = 0;
  for (const methods of Object.values(spec.value.paths)) for (const method of m.METHODS) if (methods[method] !== undefined) declared++;
  assert.equal(m.flattenOps(spec.value).length, declared, "no operation is dropped as malformed");
  assert.ok(declared > 100);
  assert.equal(check(m.OpenApiSpecWire, { paths: {} }).ok, false, "no info: refused");
});

test("panel ids stay distinct for keys that differ only in punctuation", () => {
  assert.notEqual(m.panelIdFor("get /a-b"), m.panelIdFor("get /a/b"));
  assert.notEqual(m.panelIdFor("get /x/{id}"), m.panelIdFor("get /x/id"));
  assert.match(m.panelIdFor("get /a/{b}"), /^op-[A-Za-z0-9_]+$/);
});

test("an allOf of non-object parts is not spread into index keys", () => {
  assert.equal(m.exampleValue({ allOf: [{ type: "string" }] }, {}), "string");
  assert.deepEqual(m.exampleValue({ allOf: [A, B, { type: "string" }] }, {}), { a: 0, b: "string" });
});

test("a single quote in the sample command is escaped", () => {
  const cmd = m.curlCommand({ ...base, path: "/it's" , op: op({}) });
  assert.ok(cmd.includes("'\\''"), cmd);
});
