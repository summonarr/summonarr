// MediaRequest.approvedAt — the record that a request was APPROVED, which the
// request watch grade uses to skip everything else (guardrail 34a).
//
// A request's status can't answer "did anyone approve this?" after the fact: a
// library sync marks a PENDING request AVAILABLE when its title arrives on Plex
// or Jellyfin, and nobody approved that one. So approval is recorded where a
// decision is made, and nowhere else. The grade then treats approval as per
// TITLE on an instance (tests/watch-grade-data.test.mts pins that half). The pins
// here:
//
//   1. ONLY DECISIONS WRITE IT. Only the /api/requests routes, Discord
//      interactions and the one-time backfill may even mention the column (the
//      grade's data layer and the OpenAPI doc may read it). A sync, a webhook or
//      the availability claim writing it would count unapproved requests again —
//      and a variable holding the write, or raw SQL, is found too.
//   2. APPROVE SETS IT, DECLINE CLEARS IT, NOTHING ELSE TOUCHES IT. Across every
//      MediaRequest write in src/: a literal `status: "APPROVED"` sets it
//      unconditionally, except the sync's revert of an AVAILABLE row, which is
//      not an approval; `status: "DECLINED"` clears it; `status: "PENDING"` (the
//      push-failure rollbacks — the approval was made, only the push failed) and
//      `status: "AVAILABLE"` leave it alone. A request that copies a greenlit
//      peer's status records none of its own. The routes with a computed status
//      (batch, bulk) are pinned by shape here and behaviorally elsewhere.
//   3. THE BACKFILL RUNS ONCE EVER. Rows older than the column are stamped with
//      createdAt in the same transaction as a Setting marker; any later boot
//      sees the marker and does nothing, because a null approvedAt then means
//      "never approved". The marker insert is the transaction's last write and
//      propagates (guardrail 23), so a racing boot rolls its UPDATE back. A failed
//      run is retried in the same boot, before the server takes requests.
//
// Harness: in-memory prisma stubs for the backfill; the TypeScript compiler for
// the structural pins (the request-button-on-behalf idiom). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { Prisma } = await import("@/generated/prisma");
const { backfillRequestApprovals, REQUEST_APPROVAL_BACKFILL_KEY } = await import("../src/lib/request-approval.ts");
const { BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");

// ═══ the backfill ════════════════════════════════════════════════════════════

type Op = { op: string; args?: unknown; inTx: boolean };
let ops: Op[] = [];
let markerStored = false; // what setting.findUnique sees
let markerInsertConflicts = false; // a racing boot wrote the marker after our read
let executeFailures: Error[] = []; // shifted per $executeRaw call
let txOptions: unknown[] = [];
const warnings: string[] = [];

function rec(op: string, args: unknown, inTx: boolean): void {
  ops.push({ op, args, inTx });
}

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args, false);
    return markerStored && args.where.key === REQUEST_APPROVAL_BACKFILL_KEY
      ? { key: REQUEST_APPROVAL_BACKFILL_KEY, value: "2026-09-17T00:00:00.000Z" }
      : null;
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
  txOptions.push(options);
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rec("$executeRaw", { sql: strings.join("?"), values }, true);
      const failure = executeFailures.shift();
      if (failure) throw failure;
      return 7;
    },
    setting: {
      create: async (args: { data: { key: string; value: string } }) => {
        rec("setting.create", args, true);
        if (markerInsertConflicts) {
          throw new Prisma.PrismaClientKnownRequestError("stubbed unique violation", { code: "P2002", clientVersion: "0.0.0-test" });
        }
        markerStored = true;
        return args.data;
      },
    },
  };
  return fn(tx);
});

beforeEach(() => {
  ops = [];
  markerStored = false;
  markerInsertConflicts = false;
  executeFailures = [];
  txOptions = [];
  warnings.length = 0;
});

async function withWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

const sqlOf = (op: Op): string => (op.args as { sql: string }).sql.replace(/\s+/g, " ").trim();

test("first boot: stamps approved and available rows lacking approvedAt with createdAt, then writes the marker last, in one transaction", async () => {
  const stamped = await backfillRequestApprovals();
  assert.equal(stamped, 7);
  assert.deepEqual(ops.map((o) => [o.op, o.inTx]), [
    ["setting.findUnique", false],
    ["$executeRaw", true],
    ["setting.create", true],
  ], "the marker insert is the transaction's LAST write (guardrail 23)");
  assert.equal(
    sqlOf(ops[1]),
    `UPDATE "MediaRequest" SET "approvedAt" = "createdAt" WHERE "approvedAt" IS NULL AND "status" IN ('APPROVED', 'AVAILABLE')`,
  );
  assert.equal((ops[2].args as { data: { key: string } }).data.key, REQUEST_APPROVAL_BACKFILL_KEY);
  // Prisma's interactive defaults (2s for a connection, 5s to finish) would roll a
  // slow run back, and keep every older approved request out of the grade.
  assert.deepEqual(txOptions, [{ maxWait: 10_000, timeout: BATCH_TX_TIMEOUT }]);
});

test("a later boot does nothing: the marker is read first and no UPDATE runs — a null approvedAt now means never approved", async () => {
  markerStored = true;
  assert.equal(await backfillRequestApprovals(), 0);
  assert.deepEqual(ops.map((o) => o.op), ["setting.findUnique"]);
});

test("a boot that loses the race for the marker returns quietly, and its UPDATE shares the transaction the failed insert aborts", async () => {
  markerInsertConflicts = true;
  assert.equal(await backfillRequestApprovals(), 0);
  assert.deepEqual(ops.map((o) => [o.op, o.inTx]), [
    ["setting.findUnique", false],
    ["$executeRaw", true],
    ["setting.create", true],
  ], "no retry, and nothing runs after the throwing insert");
  assert.equal(warnings.length, 0);
});

test("a failed run is retried in the same boot, and a run that then succeeds is the only one that stamps", async () => {
  executeFailures = [new Error("Connection terminated unexpectedly")];
  const stamped = await withWarnings(() => backfillRequestApprovals({ retryDelayMs: 0 }));
  assert.equal(stamped, 7);
  assert.equal(ops.filter((o) => o.op === "$executeRaw").length, 2);
  assert.equal(ops.filter((o) => o.op === "setting.create").length, 1, "the failed attempt never reached the marker");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[request-approval\] backfill attempt 1 of 3 failed/);
});

test("a run that keeps failing gives up after three attempts, propagates, and leaves no marker", async () => {
  executeFailures = [1, 2, 3].map(() => new Error('column "approvedAt" does not exist'));
  await withWarnings(() => assert.rejects(backfillRequestApprovals({ retryDelayMs: 0 }), /approvedAt/));
  assert.equal(ops.filter((o) => o.op === "$executeRaw").length, 3);
  assert.ok(!ops.some((o) => o.op === "setting.create"));
  assert.equal(markerStored, false);
  assert.equal(warnings.length, 2);
});

test("instrumentation awaits the backfill before the fire-and-forget startup work that shares the pool", () => {
  const text = readFileSync(join(ROOT, "src/instrumentation.ts"), "utf8");
  const backfill = text.search(/await import\("@\/lib\/request-approval"\)\s*\.then\(\(\{ backfillRequestApprovals \}\) => backfillRequestApprovals\(\)\)/);
  const prewarm = text.indexOf('import("@/lib/tmdb-prewarm")');
  assert.ok(backfill > 0, "the awaited backfill call");
  assert.ok(prewarm > 0, "the library prewarm");
  assert.ok(backfill < prewarm, "the backfill runs before the prewarm starts");
});

// ═══ structural pins over the source ═════════════════════════════════════════

const DECISION_ROUTES = [
  "src/app/api/interactions/route.ts",
  "src/app/api/requests/[id]/route.ts",
  "src/app/api/requests/batch/route.ts",
  "src/app/api/requests/bulk/route.ts",
  "src/app/api/requests/route.ts",
];
const BACKFILL = "src/lib/request-approval.ts";
// May read the column (or document it), never write it.
const READERS = ["src/app/api/openapi/route.ts", "src/lib/watch-grade-data.ts"];
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);

function walkSrc(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (rel.includes("/generated/")) continue;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const sourceFiles = new Map<string, ts.SourceFile>();
function sourceFile(rel: string): ts.SourceFile {
  let sf = sourceFiles.get(rel);
  if (!sf) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sourceFiles.set(rel, sf);
  }
  return sf;
}

function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function nameOf(p: ts.ObjectLiteralElementLike): string | undefined {
  const name = p.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && nameOf(p) === name);
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
  return expr;
}

// A `data: someVariable` resolves to that variable's initializer in the same file,
// so building the write in a const can't hide it.
function resolveInFile(sf: ts.SourceFile, expr: ts.Expression): ts.Expression {
  const e = unwrap(expr);
  if (!ts.isIdentifier(e)) return e;
  let found: ts.Expression | undefined;
  forEachNode(sf, (n) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text && n.initializer) {
      found = unwrap(n.initializer);
    }
  });
  return found ?? e;
}

type Write = { file: string; line: number; method: string; data: ts.Expression; where: ts.Expression | null };

// Every `<x>.mediaRequest.<write>({ data, where? })` in a file.
function mediaRequestWrites(rel: string): Write[] {
  const sf = sourceFile(rel);
  const out: Write[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!WRITE_METHODS.has(node.expression.name.text)) return;
    const target = node.expression.expression;
    if (!ts.isPropertyAccessExpression(target) || target.name.text !== "mediaRequest") return;
    const arg = node.arguments[0] ? resolveInFile(sf, node.arguments[0]) : undefined;
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    const data = prop(arg, "data");
    if (!data) return;
    const where = prop(arg, "where");
    out.push({
      file: rel,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      method: node.expression.name.text,
      data: resolveInFile(sf, data.initializer),
      where: where ? resolveInFile(sf, where.initializer) : null,
    });
  });
  return out;
}

function approvedAtAssignments(root: ts.Node): Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> {
  const out: Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> = [];
  forEachNode(root, (node) => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && nameOf(node) === "approvedAt") out.push(node);
  });
  return out;
}

function literalStatus(obj: ts.Expression | null): string | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const status = prop(obj, "status");
  return status && ts.isStringLiteral(unwrap(status.initializer)) ? (unwrap(status.initializer) as ts.StringLiteral).text : null;
}

const allFiles = walkSrc();
const allWrites = allFiles.flatMap(mediaRequestWrites);
const at = (w: { file: string; line: number }) => `${w.file}:${w.line}`;

test("approvedAt is mentioned only where requests are decided, by the backfill, and by its readers — never by a sync, a webhook or the availability claim", () => {
  const mentions = new Map<string, { code: boolean; sql: boolean }>();
  for (const rel of allFiles) {
    const found = { code: false, sql: false };
    forEachNode(sourceFile(rel), (node) => {
      if (ts.isIdentifier(node) && node.text === "approvedAt") found.code = true;
      if (
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ) {
        if (node.text.includes("approvedAt")) found.code = true;
        if (node.text.includes('"approvedAt"')) found.sql = true;
      }
    });
    if (found.code) mentions.set(rel, found);
  }
  const allowed = new Set([...DECISION_ROUTES, BACKFILL, ...READERS]);
  const stray = [...mentions.keys()].filter((rel) => !allowed.has(rel));
  assert.deepEqual(stray, [], "only decisions record approval — reading it somewhere new means adding that file to READERS on purpose");
  for (const rel of [...DECISION_ROUTES, BACKFILL]) assert.ok(mentions.has(rel), `${rel} records approval`);
  assert.deepEqual([...mentions].filter(([, m]) => m.sql).map(([rel]) => rel), [BACKFILL], "raw SQL names the column only in the backfill");

  for (const rel of READERS) {
    const writes = mediaRequestWrites(rel).filter((w) => approvedAtAssignments(w.data).length > 0);
    assert.deepEqual(writes.map(at), [], `${rel} reads approvedAt and must never write it`);
  }
});

test("across every MediaRequest write: approving sets approvedAt, declining clears it, and rollbacks, fulfilment and reverts leave it alone", () => {
  const approves: Write[] = [];
  const reverts: Write[] = [];
  const declines: Write[] = [];
  const untouched: Write[] = [];
  for (const w of allWrites) {
    const status = literalStatus(w.data);
    if (status === "APPROVED") (literalStatus(w.where) === "AVAILABLE" ? reverts : approves).push(w);
    else if (status === "DECLINED") declines.push(w);
    else if (status === "PENDING" || status === "AVAILABLE") untouched.push(w);
  }
  // Guards against a scan that silently matches nothing.
  assert.ok(approves.length >= 4, `expected the literal approve writes, found ${approves.length}`);
  assert.ok(reverts.length >= 1, `expected the sync's AVAILABLE→APPROVED revert, found ${reverts.length}`);
  assert.ok(declines.length >= 2, `expected the literal decline writes, found ${declines.length}`);
  assert.ok(untouched.length >= 12, `expected the rollbacks and the fulfilment flips, found ${untouched.length}`);

  for (const w of approves) {
    const direct = ts.isObjectLiteralExpression(w.data) ? prop(w.data, "approvedAt") : undefined;
    assert.ok(
      direct && approvedAtAssignments(w.data).length === 1 && unwrap(direct.initializer).kind !== ts.SyntaxKind.NullKeyword,
      `${at(w)} approves without recording approvedAt unconditionally`,
    );
  }
  for (const w of declines) {
    const direct = ts.isObjectLiteralExpression(w.data) ? prop(w.data, "approvedAt") : undefined;
    assert.ok(
      direct && approvedAtAssignments(w.data).length === 1 && unwrap(direct.initializer).kind === ts.SyntaxKind.NullKeyword,
      `${at(w)} declines without clearing approvedAt unconditionally`,
    );
  }
  for (const w of [...reverts, ...untouched]) {
    assert.equal(
      approvedAtAssignments(w.data).length,
      0,
      `${at(w)} writes status ${literalStatus(w.data)} and touches approvedAt — only a decision records or clears approval`,
    );
  }
});

test("computed-status writes: a copy records no approval of its own, batch follows its decision, bulk stamps auto-approved rows only", () => {
  const computed = allWrites.filter((w) => approvedAtAssignments(w.data).length > 0 && literalStatus(w.data) === null);
  const byFile = new Map(computed.map((w) => [w.file, w]));
  assert.deepEqual([...byFile.keys()].sort(), ["src/app/api/requests/batch/route.ts", "src/app/api/requests/bulk/route.ts"]);

  // Copies of a greenlit peer's status (web and Discord): no approvedAt at all.
  const copies = allWrites.filter((w) => {
    if (!ts.isObjectLiteralExpression(w.data)) return false;
    const status = prop(w.data, "status");
    return !!status && ts.isPropertyAccessExpression(unwrap(status.initializer)) && unwrap(status.initializer).getText().endsWith(".status");
  });
  assert.deepEqual(copies.map((w) => w.file).sort(), ["src/app/api/interactions/route.ts", "src/app/api/requests/route.ts"]);

  const batch = byFile.get("src/app/api/requests/batch/route.ts")!;
  assert.equal(
    prop(batch.data as ts.ObjectLiteralExpression, "approvedAt")?.initializer.getText(),
    `typedStatus === "APPROVED" ? new Date() : null`,
  );

  const bulk = byFile.get("src/app/api/requests/bulk/route.ts")!;
  const [stamp] = approvedAtAssignments(bulk.data);
  let conditional: ts.Node = stamp;
  while (!ts.isConditionalExpression(conditional) && conditional !== bulk.data) conditional = conditional.parent;
  assert.ok(ts.isConditionalExpression(conditional), "the bulk stamp sits under a condition");
  assert.equal(conditional.condition.getText(), "isAutoApproved", "only an auto-approved bulk row records approval");
  assert.match(sourceFile(bulk.file).getText(), /const isAutoApproved = !mirror && p\.autoApprove;/, "a mirrored bulk row is never auto-approved");
});
