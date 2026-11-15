// The admin API Docs viewer's model (openapi-viewer.tsx): the spec's shape as
// the browser checks it, the operations flattened and grouped by tag, a
// schema's label and example, and the "Copy as curl" command. Pure, no
// "use client", so the unit suite drives it (tests/openapi-viewer-model.test.mts).
import { check, v, type Infer } from "@/lib/validate";

// Schemas are walked, never trusted: every field is read through a guard, so a
// malformed part of the spec renders as "—" or null instead of throwing.
export interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  default?: unknown;
  description?: string;
  maxLength?: number;
}

const ParameterWire = v.object({
  name: v.string(),
  in: v.string(),
  required: v.optional(v.boolean()),
  description: v.optional(v.string()),
  schema: v.optional(v.unknown()),
});
export type Parameter = Infer<typeof ParameterWire>;

const ContentWire = v.optional(v.record(v.object({ schema: v.optional(v.unknown()) })));
const SecurityWire = v.array(v.record(v.array(v.string())));

const OperationWire = v.object({
  tags: v.optional(v.array(v.string())),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  security: v.optional(SecurityWire),
  parameters: v.optional(v.array(ParameterWire)),
  requestBody: v.optional(v.object({ required: v.optional(v.boolean()), content: ContentWire })),
  responses: v.optional(v.record(v.object({ description: v.optional(v.string()), content: ContentWire }))),
});

/** GET /api/openapi, as far as the viewer reads it. Each operation is checked on its own (flattenOps). */
export const OpenApiSpecWire = v.object({
  info: v.object({ title: v.string(), version: v.string(), description: v.optional(v.string()) }),
  servers: v.optional(v.array(v.object({ url: v.string(), description: v.optional(v.string()) }))),
  tags: v.optional(v.array(v.object({ name: v.string(), description: v.optional(v.string()) }))),
  paths: v.record(v.record(v.unknown())),
  components: v.optional(v.object({ schemas: v.optional(v.record(v.unknown())) })),
  security: v.optional(SecurityWire),
});

export type Security = Infer<typeof SecurityWire>;
export type Operation = Infer<typeof OperationWire>;
export type OpenApiSpec = Infer<typeof OpenApiSpecWire>;
export type Schemas = Record<string, unknown>;

export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface FlatOp {
  key: string;
  method: string;
  path: string;
  op: Operation;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const asSchema = (x: unknown): SchemaObject | undefined => (isRecord(x) ? (x as SchemaObject) : undefined);
const asList = (x: unknown): unknown[] | undefined => (Array.isArray(x) ? x : undefined);

/** Every operation in path order, method order within a path; an operation that isn't one is left out. */
export function flattenOps(spec: OpenApiSpec): FlatOp[] {
  const flat: FlatOp[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (methods[method] === undefined) continue;
      const op = check(OperationWire, methods[method]);
      if (op.ok) flat.push({ key: `${method} ${path}`, method, path, op: op.value });
    }
  }
  return flat;
}

/** The operations whose path or summary holds `filter` (case-insensitive); all of them for a blank one. */
export function filterOps(ops: readonly FlatOp[], filter: string): readonly FlatOp[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return ops;
  return ops.filter(({ path, op }) => path.toLowerCase().includes(needle) || (op.summary ?? "").toLowerCase().includes(needle));
}

/** The operations by their first tag: the spec's tag order first, then any other tag as met. */
export function groupByTag(ops: readonly FlatOp[], specTags: ReadonlyArray<{ name: string }>, otherLabel: string): Array<{ tag: string; entries: FlatOp[] }> {
  const groups = new Map<string, FlatOp[]>();
  for (const entry of ops) {
    const tag = entry.op.tags?.[0] ?? otherLabel;
    const bucket = groups.get(tag);
    if (bucket) bucket.push(entry);
    else groups.set(tag, [entry]);
  }
  const tagOrder = specTags.map((tagMeta) => tagMeta.name);
  const known = new Set(tagOrder);
  const ordered = [...tagOrder.filter((name) => groups.has(name)), ...[...groups.keys()].filter((name) => !known.has(name))];
  return ordered.map((tag) => ({ tag, entries: groups.get(tag) ?? [] }));
}

// aria-controls needs an id; the "<method> <path>" key is unique per operation
// and stable across filtering, so it is sanitised into one here.
// Each character outside [a-zA-Z0-9] becomes "_<hex>", so two keys never share an id.
export const panelIdFor = (key: string) =>
  `op-${key.replace(/[^a-zA-Z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

export function stripRef(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

export function resolveSchema(schema: unknown, schemas: Schemas, depth = 0): SchemaObject | undefined {
  const s = asSchema(schema);
  if (!s) return undefined;
  // Bounded: a $ref chain that loops back on itself must not recurse forever.
  if (typeof s.$ref === "string") return depth > 20 ? undefined : resolveSchema(schemas[stripRef(s.$ref)], schemas, depth + 1);
  return s;
}

/** A schema's short label: its $ref name, `A & B`, `A | B` (oneOf/anyOf), an enum's values, `T[]`, or its type. */
export function typeLabel(schema: unknown): string {
  const s = asSchema(schema);
  if (!s) return "—";
  if (typeof s.$ref === "string") return stripRef(s.$ref);
  const allOf = asList(s.allOf);
  if (allOf) return allOf.map(typeLabel).join(" & ");
  const options = asList(s.oneOf) ?? asList(s.anyOf);
  if (options) return options.map(typeLabel).join(" | ");
  const values = asList(s.enum);
  if (values) return values.map(String).join(" | ");
  if (s.type === "array") return `${typeLabel(s.items)}[]`;
  let label = typeof s.type === "string" ? s.type : "object";
  if (typeof s.format === "string") label += `<${s.format}>`;
  if (s.nullable === true) label += " | null";
  return label;
}

/**
 * An example value for a schema: an enum's first value, the first branch of a
 * oneOf/anyOf, the parts of an allOf merged, and a placeholder per type.
 * `active` holds the $refs being expanded on this path: a self-referencing
 * schema (a tree node whose child is itself) ends at null instead of overflowing.
 */
export function exampleValue(schema: unknown, schemas: Schemas, active: ReadonlySet<string> = new Set()): unknown {
  let seen = active;
  const raw = asSchema(schema);
  if (raw && typeof raw.$ref === "string") {
    const name = stripRef(raw.$ref);
    if (active.has(name)) return null;
    seen = new Set(active).add(name);
  }
  const s = resolveSchema(schema, schemas);
  if (!s) return null;
  const values = asList(s.enum);
  if (values) return values[0];
  const allOf = asList(s.allOf);
  if (allOf) {
    const parts = allOf.map((part) => exampleValue(part, schemas, seen));
    const objects = parts.filter(isRecord);
    if (objects.length === 0) return parts[0] ?? null;
    return Object.assign({}, ...objects);
  }
  const options = asList(s.oneOf) ?? asList(s.anyOf);
  if (options && options.length > 0) return exampleValue(options[0], schemas, seen);
  switch (s.type) {
    case "string":
      return s.format === "date-time" ? "2024-01-01T00:00:00Z" : "string";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [exampleValue(s.items, schemas, seen)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(isRecord(s.properties) ? s.properties : {})) {
        out[key] = exampleValue(value, schemas, seen);
      }
      return out;
    }
    default:
      return null;
  }
}

export function statusColor(code: string): string {
  if (code.startsWith("2")) return "var(--ds-success)";
  if (code.startsWith("4")) return "var(--ds-warning)";
  if (code.startsWith("5")) return "var(--ds-danger)";
  return "var(--ds-fg-subtle)";
}

/** The first media type a body or response declares, and its schema; JSON when it is one. */
export function firstContent(content: Record<string, { schema?: unknown }> | undefined): { type: string; schema: unknown; json: boolean } | null {
  if (!content) return null;
  const type = "application/json" in content ? "application/json" : Object.keys(content)[0];
  if (type === undefined) return null;
  return { type, schema: content[type]?.schema, json: type === "application/json" || type.endsWith("+json") };
}

// A query value the copied command can run with: the schema's default or first
// enum value, else the NAME in capitals for the user to fill in.
function queryPlaceholder(p: Parameter): string {
  const s = asSchema(p.schema);
  const values = asList(s?.enum);
  const value = s?.default !== undefined ? s.default : values && values.length > 0 ? values[0] : p.name.toUpperCase();
  return encodeURIComponent(String(value));
}

// Text placed between single quotes in the sample command: an embedded ' closes, escapes and reopens the quote.
const shellQuoteBody = (text: string) => text.replace(/'/g, "'\\''");

/**
 * The "Copy as curl" command. `serverUrl` is the spec's own server url, which
 * already carries BASE_PATH (the spec route applies it), so it is used as-is —
 * prefixing it again would double the base path. `cookieName` is the server's
 * real session cookie name (getSessionCookieName(), passed down by the page): it
 * follows AUTH_URL, which the browser's own protocol only approximates. The
 * command stays on the cookie transport — a web session token is refused as a
 * Bearer (guardrail 6h).
 *
 * Only the REQUIRED query parameters go in, each with a value the command can
 * run with: an empty `limit=` or `page=` is refused or changes the answer. A
 * JSON body is an example; any other body (a backup upload) is a file.
 */
export function curlCommand(args: {
  origin: string;
  serverUrl: string;
  method: string;
  path: string;
  op: Operation;
  security: Security;
  schemas: Schemas;
  cookieName: string;
}): string {
  const { origin, serverUrl, method, path, op, security, schemas, cookieName } = args;
  // Substitute {id}-style path params with an uppercase placeholder the user
  // replaces, rather than leaving the literal brace syntax in the URL.
  const resolvedPath = path.replace(/\{(\w+)\}/g, (_, name: string) => name.toUpperCase());
  const query = (op.parameters ?? [])
    .filter((p) => p.in === "query" && p.required === true)
    .map((p) => `${encodeURIComponent(p.name)}=${queryPlaceholder(p)}`)
    .join("&");
  const url = `${origin}${serverUrl}${resolvedPath}${query ? `?${query}` : ""}`;
  const lines = [`curl -X ${method.toUpperCase()} '${shellQuoteBody(url)}'`];
  if (security.length > 0) lines.push(`  --cookie '${cookieName}=YOUR_SESSION_TOKEN'`);
  const body = firstContent(op.requestBody?.content);
  if (body) {
    lines.push(`  -H 'Content-Type: ${body.type}'`);
    lines.push(body.json ? `  -d '${shellQuoteBody(JSON.stringify(exampleValue(body.schema, schemas)))}'` : "  --data-binary @FILE");
  }
  return lines.join(" \\\n");
}
