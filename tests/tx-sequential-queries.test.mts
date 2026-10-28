// Guardrail 23c (CLAUDE.md): NEVER run queries in parallel on a transaction
// client. `Promise.all([tx.a.findUnique(…), tx.b.count(…)])` and friends put
// several queries on the ONE connection the transaction holds.
//
// pg runs one query at a time per connection, so the parallel form saves
// nothing. Prisma's adapter hands every query straight to that connection's
// queue, and from a third queued query on pg 8.x prints "Calling
// client.query() when the client is already executing a query is deprecated
// and will be removed in pg@9.0" — seen in production from the 2FA enrollment
// routes, which read getMfaState (three parallel reads) on the tx.
//
// Static and conservative. A name is a transaction client inside a function
// when it is the first parameter of a `$transaction(…)` callback, a parameter
// named tx/trx/txn, or a parameter typed with a `…Tx`/`…TxClient`/
// `TransactionClient` type or an alias declared from `typeof prisma` (those
// helpers take the global client OR a tx, so a fan-out there breaks for the tx
// caller). A parallel call (Promise.all/allSettled/any/race, mapLimit,
// settleLimit) that mentions such a name in its arguments is flagged — a direct
// `tx.model.op()` or a helper handed `tx`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PARALLEL = new Set(["Promise.all", "Promise.allSettled", "Promise.any", "Promise.race", "mapLimit", "settleLimit"]);
const TX_NAMES = new Set(["tx", "trx", "txn"]);
const TX_TYPE = /Tx(Client)?\b|TransactionClient\b/;

function walkSrc(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (rel.includes("/generated/")) continue;
    if (entry.isDirectory()) walkSrc(rel, out);
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

// Type aliases built from the client (`type MfaTxClient = Omit<typeof prisma, …>`,
// `type AuditDb = Pick<typeof prisma, "auditLog">`). Collected across the whole
// tree, because the alias is usually imported by the file that uses it.
export function clientAliases(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && /typeof prisma\b/.test(node.type.getText(sf))) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function isTransactionCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === fn &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "$transaction"
  );
}

function txParamNames(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, aliases: Set<string>): Set<string> {
  const names = new Set<string>();
  fn.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name)) return;
    const name = p.name.text;
    const type = p.type?.getText(sf) ?? "";
    const typedAsClient = TX_TYPE.test(type) || type.split(/[^\w$]+/).some((word) => aliases.has(word));
    if ((i === 0 && isTransactionCallback(fn)) || TX_NAMES.has(name) || typedAsClient) names.add(name);
  });
  return names;
}

// Does `node` mention a binding called `name`, ignoring property names
// (`x.tx`, `{ tx: 1 }`) and any nested function that re-declares it?
function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const parent = n.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isPropertyName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function findParallelTxQueries(rel: string, text: string, aliases: Set<string> = new Set()): string[] {
  const sf = parse(rel, text);
  const hits = new Map<number, string>();
  const scanScope = (body: ts.Node, names: Set<string>) => {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && PARALLEL.has(n.expression.getText(sf))) {
        for (const name of names) {
          if (n.arguments.some((arg) => mentions(arg, name))) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            hits.set(n.getStart(sf), `${rel}:${line} ${n.expression.getText(sf)}(…${name}…)`);
          }
        }
      }
      // A nested function that re-declares the name starts its own scope; it
      // is visited on its own by the outer walk.
      if (isFunctionLike(n)) {
        const shadowed = [...names].filter((name) => n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name));
        if (shadowed.length === names.size) return;
        if (shadowed.length > 0) {
          const rest = new Set([...names].filter((name) => !shadowed.includes(name)));
          if (n.body) scanScope(n.body, rest);
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
  };
  const walk = (node: ts.Node) => {
    if (isFunctionLike(node) && node.body) {
      const names = txParamNames(node, sf, aliases);
      if (names.size > 0) scanScope(node.body, names);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([, hit]) => hit);
}

test("no transaction client runs queries in parallel (guardrail 23c)", () => {
  const files = walkSrc().map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
  const aliases = new Set(files.flatMap(({ rel, text }) => clientAliases(parse(rel, text))));
  // The alias collection itself is what lets the scan see helpers typed with
  // an imported alias; an empty set would quietly blind it.
  for (const known of ["MfaTxClient", "LibraryTxClient"]) assert.ok(aliases.has(known), `alias ${known} not collected`);
  const hits = files.flatMap(({ rel, text }) => findParallelTxQueries(rel, text, aliases));
  assert.deepEqual(hits, [], "await each query on a transaction client in turn — a transaction is one connection");
});

test("the scan flags every parallel shape and passes sequential and pool reads", () => {
  const src = `
    type Db = Pick<typeof prisma, "user">;
    async function inline() {
      await prisma.$transaction(async (t) => {
        await Promise.all([t.user.findUnique({ where: { id } }), t.user.count()]);
      });
    }
    async function typed(userId: string, db: MfaTxClient = prisma) {
      return Promise.all([db.userTotp.findUnique({ where: { userId } }), db.mfaRecoveryCode.count()]);
    }
    async function bounded(tx: Prisma.TransactionClient, ids: string[]) {
      await mapLimit(ids, 4, (id) => tx.user.delete({ where: { id } }));
    }
    async function handedToHelpers() {
      await prisma.$transaction(async (tx) => {
        await Promise.allSettled([helperA(tx), helperB(tx, 1)]);
      });
    }
    async function localAlias(db: Db) {
      await Promise.all([db.user.count(), db.user.count()]);
    }

    async function sequential() {
      await prisma.$transaction(async (tx) => {
        const a = await tx.user.findUnique({ where: { id } });
        const b = await tx.user.count();
        // Promise.all([tx.user.count()]) in a comment is not code
        const labels = await Promise.all(names.map((n) => translate(n, { tx: true })));
        return [a, b, labels];
      });
    }
    async function pool() {
      await Promise.all([prisma.user.count(), prisma.userTotp.count()]);
    }
    async function oneTransactionPerItem(plans: string[]) {
      await settleLimit(plans, 4, async (id) => prisma.$transaction(async (tx) => tx.user.delete({ where: { id } })));
    }
    async function shadowedInsideTx() {
      await prisma.$transaction(async (tx) => {
        await settleLimit(ids, 2, async (id) => prisma.$transaction(async (tx) => tx.user.count()));
      });
    }`;
  const hits = findParallelTxQueries("fixture.ts", src, new Set(["Db"])).map((h) => h.replace(/^fixture\.ts:\d+ /, ""));
  assert.deepEqual(hits, [
    "Promise.all(…t…)",
    "Promise.all(…db…)",
    "mapLimit(…tx…)",
    "Promise.allSettled(…tx…)",
    "Promise.all(…db…)",
  ]);
});

// ── Runtime pins: the helpers really do read one at a time ──────────────────

const { getMfaStateInTx, dropRecoveryCodesIfNoFactorInTx } = await import("../src/lib/mfa/mfa-store.ts");

// A fake transaction client whose every call stays in flight for a tick and
// records the most that were ever in flight together.
function countingTx(results: Record<string, unknown>) {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const op = (key: string) => async () => {
    calls.push(key);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return results[key];
  };
  const tx = {
    userTotp: { findUnique: op("userTotp.findUnique") },
    webAuthnCredential: { findMany: op("webAuthnCredential.findMany"), count: op("webAuthnCredential.count") },
    mfaRecoveryCode: { count: op("mfaRecoveryCode.count"), deleteMany: op("mfaRecoveryCode.deleteMany") },
  };
  return { tx, calls, peak: () => peak };
}

test("getMfaStateInTx reads one query at a time and builds the same state", async () => {
  const passkey = {
    id: "p1",
    credentialId: "c1",
    transports: ["usb"],
    name: "Key",
    createdAt: new Date(0),
    lastUsedAt: null,
    backedUp: false,
  };
  const { tx, calls, peak } = countingTx({
    "userTotp.findUnique": { enabledAt: null },
    "webAuthnCredential.findMany": [passkey],
    "mfaRecoveryCode.count": 7,
  });
  const state = await getMfaStateInTx(tx as never, "u1");
  assert.equal(peak(), 1);
  assert.deepEqual(calls, ["userTotp.findUnique", "webAuthnCredential.findMany", "mfaRecoveryCode.count"]);
  assert.deepEqual(state, { totpEnabled: false, totpPending: true, passkeys: [passkey], recoveryRemaining: 7, enabled: true });
});

test("dropRecoveryCodesIfNoFactorInTx reads one query at a time", async () => {
  const { tx, calls, peak } = countingTx({
    "userTotp.findUnique": null,
    "webAuthnCredential.count": 0,
    "mfaRecoveryCode.deleteMany": { count: 3 },
  });
  assert.equal(await dropRecoveryCodesIfNoFactorInTx(tx as never, "u1"), true);
  assert.equal(peak(), 1);
  assert.deepEqual(calls, ["userTotp.findUnique", "webAuthnCredential.count", "mfaRecoveryCode.deleteMany"]);
});
