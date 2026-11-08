// Shared harness for the OpenAPI response-schema pins: fetches the served spec
// (GET /api/openapi as an ADMIN, through the same synthetic request scope and
// in-memory prisma stubs tests/openapi-spec-parity.test.mts uses) and reads the
// handlers and lib modules a schema is pinned to.
//
// Importing it sets the test env (secrets, a 503 fetch, silenced console.warn/
// console.error), so import it before anything else.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import ts from "typescript";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "openapi-response-schemas-secret-01";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
console.warn = () => {};
console.error = () => {};

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const ADMIN = {
  id: "u-admin", name: "Admin", email: "admin@example.com", role: "ADMIN",
  permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
  passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
};
const SESSION_ID = "sess-admin";

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    args.where.sessionId === SESSION_ID ? { id: `row-${SESSION_ID}`, sessionId: SESSION_ID } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => (args.where.id === ADMIN.id ? ADMIN : null),
  findMany: async () => [],
  count: async () => 1,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
});

const openapi = await import("../src/app/api/openapi/route.ts");

export interface SchemaNode {
  type?: string;
  format?: string;
  pattern?: string;
  nullable?: boolean;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  description?: string;
  required?: string[];
  enum?: unknown[];
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}
export interface SpecResponse {
  description: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: SchemaNode }>;
}
export interface SpecOp {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: Array<{ name: string; in: string; schema?: SchemaNode }>;
  requestBody?: { content: Record<string, { schema: SchemaNode }> };
  responses: Record<string, SpecResponse>;
}
export interface Spec {
  tags: { name: string }[];
  security: Record<string, string[]>[];
  servers: { url: string }[];
  components: { schemas: Record<string, SchemaNode> };
  paths: Record<string, Record<string, SpecOp>>;
}

/** A fresh GET /api/openapi as an ADMIN: the served Response itself. */
export async function specResponse(): Promise<Response> {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: ADMIN.id, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId: SESSION_ID, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  const cookie = `${getSessionCookieName()}=${token}`;
  const reqHeaders = new Headers({ cookie });
  const workStore = {
    route: "/openapi-response-schemas.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () =>
    openapi.GET(new NextRequest("http://localhost:3000/api/openapi", { method: "GET", headers: { cookie } }), undefined)));
}

let cached: Spec | null = null;
/** The served document, fetched once per process. */
export async function getSpec(): Promise<Spec> {
  if (cached) return cached;
  const res = await specResponse();
  assert.equal(res.status, 200);
  cached = (await res.json()) as Spec;
  return cached;
}

/** One operation of the served spec; fails the test when it isn't documented. */
export async function specOp(path: string, method: string): Promise<SpecOp> {
  const op = (await getSpec()).paths[path]?.[method];
  assert.ok(op, `${method.toUpperCase()} ${path} is not documented`);
  return op;
}

/** The JSON schema of one response, `$ref`s into components resolved at the top level. */
export async function responseSchema(path: string, method: string, status: string): Promise<SchemaNode> {
  const spec = await getSpec();
  const op = await specOp(path, method);
  let schema = op.responses[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} ${status} has no JSON schema`);
  if (schema.$ref) schema = resolveRef(spec, schema.$ref);
  return schema;
}

export function resolveRef(spec: Spec, ref: string): SchemaNode {
  const name = ref.replace("#/components/schemas/", "");
  const schema = spec.components.schemas[name];
  assert.ok(schema, `unknown $ref ${ref}`);
  return schema;
}

/** The documented property names of an object schema, sorted. */
export const keysOf = (schema: SchemaNode | undefined): string[] => Object.keys(schema?.properties ?? {}).sort();

const repo = (rel: string) => new URL(`../${rel}`, import.meta.url);
export const readRepo = (rel: string) => readFileSync(repo(rel), "utf8");
export const libSource = (rel: string) => readRepo(`src/lib/${rel}`);
/** A route file's source by its spec path (`/issues/{id}/files` → src/app/api/issues/[id]/files/route.ts). */
export const routeSource = (path: string) => readRepo(`src/app/api${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`);

/** Each exported handler's own source, by lowercase method. */
export function handlerSlices(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...src.matchAll(/^export (?:const (GET|POST|PATCH|DELETE|PUT) =|async function (GET|POST|PATCH|DELETE|PUT)\b)/gm)];
  marks.forEach((m, i) => out.set((m[1] ?? m[2]).toLowerCase(), src.slice(m.index, marks[i + 1]?.index ?? src.length)));
  return out;
}
/** One handler's source, by spec path and method. */
export function handlerSource(path: string, method: string): string {
  const h = handlerSlices(routeSource(path)).get(method.toLowerCase());
  assert.ok(h, `no ${method.toUpperCase()} handler for ${path}`);
  return h;
}

/** The field names of `[export] interface <name> { … }` or `[export] type <name> = { … }` (one level), sorted. */
export function interfaceFields(src: string, name: string): string[] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let members: ts.NodeArray<ts.TypeElement> | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === name) members = n.members;
    else if (ts.isTypeAliasDeclaration(n) && n.name.text === name && ts.isTypeLiteralNode(n.type)) members = n.type.members;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(members, `interface/type ${name} not found`);
  return (members as ts.NodeArray<ts.TypeElement>)
    .filter(ts.isPropertySignature)
    .map((m) => (m.name as ts.Identifier | ts.StringLiteral).text)
    .sort();
}

/** The field names of a prisma model (relations by lowercase type name excluded only when listed in `skip`), sorted. */
export function prismaModelFields(model: string, skip: string[] = []): string[] {
  const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(readRepo("prisma/schema.prisma"))?.[1];
  assert.ok(body, `model ${model} not found`);
  return [...body.matchAll(/^\s{2}(\w+)\s+\w+/gm)].map((m) => m[1]).filter((f) => !skip.includes(f)).sort();
}

/** The optional (`Type?`) scalar fields of a prisma model, sorted. */
export function prismaOptionalFields(model: string): string[] {
  const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(readRepo("prisma/schema.prisma"))?.[1];
  assert.ok(body, `model ${model} not found`);
  return [...body.matchAll(/^\s{2}(\w+)\s+\w+\?/gm)].map((m) => m[1]).sort();
}

/** The names of an object schema's properties marked `nullable: true`, sorted. */
export const nullableKeys = (schema: SchemaNode | undefined): string[] =>
  Object.entries(schema?.properties ?? {}).filter(([, v]) => v.nullable === true).map(([k]) => k).sort();

/**
 * The top-level keys of every object literal a handler answers with —
 * `NextResponse.json({ … })` / `Response.json({ … })` (and `json({ … })`
 * shorthands named in `callees`). Spreads are reported as `...<expr>`.
 * One sorted key list per call, in source order.
 */
export function jsonBodyKeys(src: string, callees: string[] = ["NextResponse.json", "Response.json"]): string[][] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && callees.includes(n.expression.getText(sf))) {
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) out.push(objectLiteralKeys(arg, sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The top-level keys of an object literal (spreads as `...<expr>`), sorted. */
export function objectLiteralKeys(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string[] {
  return obj.properties.map((p) => {
    if (ts.isSpreadAssignment(p)) return `...${p.expression.getText(sf)}`;
    const name = p.name;
    return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : (name?.getText(sf) ?? "?");
  }).sort();
}

/** The keys of the object literal assigned to `const <name> = { … }` (optionally `satisfies`/`as` wrapped), sorted. */
export function constObjectKeys(src: string, name: string): string[] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: string[] | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = objectLiteralKeys(init, sf);
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `const ${name} = { … } not found`);
  return found;
}

// ── A handler's calls, and the numbers it passes ─────────────────────────────

/** A call a handler makes: the callee's name, its argument nodes, and the file they're in. */
export interface HandlerCall {
  callee: string;
  args: readonly ts.Expression[];
  file: string;
  sf: ts.SourceFile;
}

const parsedFiles = new Map<string, ts.SourceFile>();
function parseRepoFile(rel: string): ts.SourceFile {
  let sf = parsedFiles.get(rel);
  if (!sf) {
    sf = ts.createSourceFile(rel, readRepo(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsedFiles.set(rel, sf);
  }
  return sf;
}

const HTTP_METHOD_NAMES = new Set(["GET", "POST", "PATCH", "DELETE", "PUT"]);
const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** A file's top-level functions and consts by name, and its exported method handlers. */
function topLevel(sf: ts.SourceFile): { locals: Map<string, ts.Node>; handlers: Map<string, ts.Node> } {
  const locals = new Map<string, ts.Node>();
  const handlers = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      (isExported(st) && HTTP_METHOD_NAMES.has(st.name.text) ? handlers : locals).set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        (isExported(st) && HTTP_METHOD_NAMES.has(d.name.text) ? handlers : locals).set(d.name.text, d.initializer);
      }
    }
  }
  return { locals, handlers };
}

/**
 * Every named call one operation's handler makes — directly, or through a
 * function or const declared in its own route file (followed transitively).
 * Calls a lib module makes on its behalf are not seen.
 */
export function handlerCalls(path: string, method: string): HandlerCall[] {
  const file = `src/app/api${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
  const sf = parseRepoFile(file);
  const { locals, handlers } = topLevel(sf);
  const handler = handlers.get(method.toUpperCase());
  assert.ok(handler, `no ${method.toUpperCase()} handler for ${path}`);
  const out: HandlerCall[] = [];
  const seen = new Set<string>();
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      out.push({ callee: node.expression.text, args: node.arguments, file, sf });
    }
    if (ts.isIdentifier(node) && locals.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      walk(locals.get(node.text) as ts.Node);
    }
    ts.forEachChild(node, walk);
  };
  walk(handler);
  return out;
}

/**
 * The number an expression evaluates to — a literal (`65_536`), a product or sum
 * of them (`16 * 1024`), a top-level const of the same file, or a const imported
 * from `@/lib/…` — or null when it can't be read statically.
 */
export function numericValue(expr: ts.Expression, file: string): number | null {
  const sf = parseRepoFile(file);
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return numericValue(expr.expression, file);
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
  if (ts.isBinaryExpression(expr)) {
    const l = numericValue(expr.left, file);
    const r = numericValue(expr.right, file);
    if (l === null || r === null) return null;
    if (expr.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return l * r;
    if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return l + r;
    return null;
  }
  if (!ts.isIdentifier(expr)) return null;
  const local = topLevel(sf).locals.get(expr.text);
  if (local && ts.isExpression(local)) return numericValue(local, file);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const spec = bindings.elements.find((e) => e.name.text === expr.text);
    if (!spec || !st.moduleSpecifier.text.startsWith("@/lib/")) continue;
    const libFile = `src/lib/${st.moduleSpecifier.text.slice("@/lib/".length)}.ts`;
    const exported = topLevel(parseRepoFile(libFile)).locals.get((spec.propertyName ?? spec.name).text);
    return exported && ts.isExpression(exported) ? numericValue(exported, libFile) : null;
  }
  return null;
}

/** A top-level `const <name> = <number>` of a repo file, evaluated. */
export function fileConstNumber(file: string, name: string): number {
  const node = topLevel(parseRepoFile(file)).locals.get(name);
  assert.ok(node && ts.isExpression(node), `${file}: no top-level const ${name}`);
  const value = numericValue(node, file);
  assert.ok(value !== null, `${file}: ${name} is not a static number`);
  return value;
}
