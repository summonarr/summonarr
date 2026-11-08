// Statuses every handler of a kind answers, held to the document across every
// operation at once rather than one pin per incident: a capped body read's 413
// (worded with the handler's own cap), a rate limiter's 429 (with Retry-After
// when the handler answers through tooManyRequests), and nullable enums that
// list null among their values (OpenAPI 3.0 checks `enum` before `nullable`).

import { getSpec, handlerCalls, handlerStatusLiterals, handlerStatuses, numericValue, type SchemaNode } from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";

const spec = await getSpec();
const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ path, method, op, key: `${method.toUpperCase()} ${path}` })),
);

// The capped readers in src/lib/body-size.ts, and which argument is the cap.
const BODY_READERS: Record<string, number> = {
  readJsonCapped: 1,
  readJsonCappedOr: 1,
  readOptionalJsonCapped: 1,
  readBodyBytesCapped: 1,
  checkBodySize: 1,
  bodyTooLarge: 0,
};

/** The cap as body-size.ts's own 413 message words it, with a space ("16 KB"). */
function capText(bytes: number): string {
  const MIB = 1024 * 1024;
  return bytes >= MIB ? `${Math.round(bytes / MIB)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

test("every operation whose handler reads a capped body documents its 413, worded with the handler's cap", () => {
  const missing: string[] = [];
  const wrongCap: string[] = [];
  let capped = 0;
  for (const { path, method, op, key } of operations) {
    const reads = handlerCalls(path, method).filter((c) => c.callee in BODY_READERS);
    if (reads.length === 0) continue;
    capped++;
    const answer = op.responses["413"];
    if (!answer) {
      missing.push(key);
      continue;
    }
    for (const call of reads) {
      const arg = call.args[BODY_READERS[call.callee]];
      const cap = arg ? numericValue(arg, call.file) : null;
      if (cap !== null && !answer.description.includes(capText(cap))) {
        wrongCap.push(`${key}: the handler caps at ${capText(cap)}, the 413 says "${answer.description}"`);
      }
    }
  }
  assert.deepEqual(missing, [], "body-reading operations with no 413");
  assert.deepEqual(wrongCap, [], "413s that name another cap than the handler's");
  assert.ok(capped >= 85, `only ${capped} body-reading operations found — is the handler scan still working?`);
});

const LIMITERS = new Set(["checkRateLimit", "reserveRateLimit", "peekRateLimit", "tooManyRequests"]);

test("every operation whose handler rate-limits documents its 429, and Retry-After when tooManyRequests answers it", () => {
  const missing: string[] = [];
  const noHeader: string[] = [];
  let limited = 0;
  for (const { path, method, op, key } of operations) {
    const calls = handlerCalls(path, method).filter((c) => LIMITERS.has(c.callee));
    if (calls.length === 0) continue;
    limited++;
    const answer = op.responses["429"];
    if (!answer) {
      missing.push(key);
      continue;
    }
    // src/lib/http.ts: tooManyRequests always sets the header.
    if (calls.some((c) => c.callee === "tooManyRequests") && !answer.headers?.["Retry-After"]) noHeader.push(key);
  }
  assert.deepEqual(missing, [], "rate-limited operations with no 429");
  assert.deepEqual(noHeader, [], "429s answered through tooManyRequests without a documented Retry-After");
  assert.ok(limited >= 60, `only ${limited} rate-limited operations found — is the handler scan still working?`);
});

/** Every schema node of the document (bodies, parameters, headers, components), with where it is. */
function* allSchemas(node: unknown, at: string): Generator<[string, SchemaNode]> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* allSchemas(v, `${at}[${i}]`);
    return;
  }
  const obj = node as Record<string, unknown>;
  if ("enum" in obj || "nullable" in obj) yield [at, obj as SchemaNode];
  for (const [k, v] of Object.entries(obj)) yield* allSchemas(v, `${at}.${k}`);
}

test("a nullable enum lists null among its values, or a strict client refuses the null the handler sends", () => {
  const bad: string[] = [];
  let nullableEnums = 0;
  for (const [at, node] of allSchemas(spec, "")) {
    if (node.nullable !== true || !node.enum) continue;
    nullableEnums++;
    if (!node.enum.includes(null)) bad.push(at);
  }
  assert.deepEqual(bad, []);
  assert.ok(nullableEnums >= 25, `only ${nullableEnums} nullable enums found`);
});

// A status the route file names as `{ status: N }` but the document lists on the
// operation that DELIVERS it: the watch sync run answers 202 and the job's own
// 409 arrives on the poll (GET), where it is documented.
const STATUS_DELIVERED_ELSEWHERE = new Set(["POST /admin/watch-sync/run 409"]);

test("every status a handler names as a literal is a documented response of that operation", () => {
  const missing: string[] = [];
  let scanned = 0;
  for (const { path, method, op, key } of operations) {
    const literals = handlerStatusLiterals(path, method);
    if (literals.length > 0) scanned++;
    for (const status of literals) {
      if (String(status) in op.responses) continue;
      if (STATUS_DELIVERED_ELSEWHERE.has(`${key} ${status}`)) continue;
      missing.push(`${key} answers ${status}`);
    }
  }
  assert.deepEqual(missing, [], "statuses the handler sets that the document does not list");
  assert.ok(scanned >= 150, `only ${scanned} operations name a status literal — is the handler scan still working?`);
  for (const entry of STATUS_DELIVERED_ELSEWHERE) {
    const [method, path, status] = entry.split(" ");
    assert.ok(handlerStatusLiterals(path, method).includes(Number(status)), `stale exception: ${entry}`);
  }
});

// Statuses a handler can get from a common helper that the document does not
// list on purpose: "METHOD /path status" → why.
const HELPER_STATUS_GAPS: Readonly<Record<string, string>> = {};

test("every status a common helper answers on a handler's behalf is a documented response of that operation", () => {
  const missing: string[] = [];
  const used = new Set<string>();
  let followed = 0;
  for (const { path, method, op, key } of operations) {
    for (const { status, via } of handlerStatuses(path, method)) {
      if (via === "a literal") continue;
      followed++;
      if (String(status) in op.responses) continue;
      const gap = `${key} ${status}`;
      if (gap in HELPER_STATUS_GAPS) {
        used.add(gap);
        continue;
      }
      missing.push(`${gap} (via ${via})`);
    }
  }
  assert.deepEqual(missing, [], "statuses a helper sets that the document does not list");
  assert.ok(followed >= 200, `only ${followed} helper statuses followed — is the helper scan still working?`);
  for (const gap of Object.keys(HELPER_STATUS_GAPS)) assert.ok(used.has(gap), `stale gap: ${gap}`);
});
