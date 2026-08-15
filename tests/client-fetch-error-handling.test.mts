// Every `fetch` in a "use client" component must have somewhere for its failure
// to go. This is a whole-tree structural sweep, not a per-module unit test.
//
// Why this file exists: a client `fetch` REJECTS on any transport failure —
// offline, DNS, TLS, connection reset, an aborted request — and that rejection
// is a completely different path from a non-2xx response. `if (!res.ok)` does
// not run. A `finally` does, which is what made this so easy to miss: the
// spinner stopped, the dialog closed, the button re-enabled, and the operation
// had silently not happened. React does not await an event handler's returned
// promise, so the rejection surfaced only as `Uncaught (in promise)` in
// devtools, and there is no global unhandledrejection handler in this app.
//
// A sweep at wave 8 of the 2026-08 review found 23 of these across 11 files.
// Eight were named in the review; the sweep found five more files it had
// missed, which is precisely the argument for a structural check over a
// hand-maintained list. Among them: revoking an admin session reported failure
// only to console.error, and two "Load more" buttons used `if (res.ok)` with no
// else at all, so a failed page read as "you have reached the end".
//
// What counts as handled:
//   - an enclosing try that has a catch clause (a try with ONLY a finally does
//     not count — that is the exact antipattern above);
//   - a `.catch()` chained onto the promise;
//   - the enclosing function throws deliberately, so its callers own the
//     failure. `loadTokens` in settings/forms/webhook-urls.tsx is the in-tree
//     example: it throws on !res.ok and its one caller wraps it in try/catch.
//     Without this excuse the rule would push error handling INTO helpers that
//     correctly delegate it.
//
// Deliberately not checked here: whether `res.ok` is consulted, and whether the
// caught error is actually shown to the user. Both are real (a green "Search
// triggered" on an HTTP 503 was one of this wave's findings) but neither is
// decidable from syntax — a catch that sets state is indistinguishable from one
// that swallows. This sweep pins the part that IS structural.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO = new URL("..", import.meta.url).pathname;
const SRC = join(REPO, "src");

// ── file discovery ──────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (p.includes("/generated/")) continue; // Prisma client output (guardrail 12)
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// "use client" must be the first statement but may sit under a comment banner.
// Scanned linearly rather than with a regex: one pattern over an alternation of
// line/block comments backtracks catastrophically on adversarial input.
function startsWithUseClient(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    break;
  }
  return text.startsWith('"use client"', i) || text.startsWith("'use client'", i);
}

const clientFiles = walk(SRC).filter((f) => startsWithUseClient(readFileSync(f, "utf8")));

// ── the analyzer ────────────────────────────────────────────────────────────

interface Hit {
  file: string;
  line: number;
  excuse: string | null;
}

/** Is this call `fetch(...)` (bare or `window.fetch(...)`)? */
function isFetchCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const ex = node.expression;
  if (ts.isIdentifier(ex)) return ex.text === "fetch";
  if (ts.isPropertyAccessExpression(ex)) return ex.name.text === "fetch";
  return false;
}

/** `fetch(...).then(...).catch(...)` — walk the chain looking for a .catch. */
function hasChainedCatch(node: ts.CallExpression): boolean {
  let cur: ts.Node = node;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) {
    const access = cur.parent;
    if (access.name.text === "catch") return true;
    if (!access.parent || !ts.isCallExpression(access.parent)) return false;
    cur = access.parent;
  }
  return false;
}

// Callbacks whose returned promise is COLLECTED by the caller — the classic
// being `Promise.all(ids.map((id) => fetch(...)))`, where a rejection from any
// fetch rejects the awaited Promise.all and a try/catch around the await does
// catch it. Every other function boundary is a barrier: a `setTimeout` or
// `addEventListener` callback runs on its own stack, long after the try that
// lexically encloses its definition has exited.
const RESULT_COLLECTING_CALLEES = new Set(["map", "flatMap"]);

function isBarrierFunction(fn: ts.Node): boolean {
  const parent = fn.parent;
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(fn as ts.Expression)) {
    const ex = parent.expression;
    const name = ts.isIdentifier(ex) ? ex.text : ts.isPropertyAccessExpression(ex) ? ex.name.text : "";
    if (RESULT_COLLECTING_CALLEES.has(name)) return false;
  }
  return true;
}

/**
 * Whether any try between `node` and its nearest real function boundary has a
 * catch clause. See isBarrierFunction for which boundaries actually stop the
 * walk — the distinction matters, and getting it wrong in either direction is a
 * bug: too strict and a correct `Promise.all(…map(fetch))` is reported; too
 * loose and a genuinely floating `setTimeout(async () => fetch())` is excused
 * by a try it never runs inside.
 */
function enclosingTryHasCatch(node: ts.Node): boolean {
  let cur: ts.Node = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isTryStatement(parent) && parent.tryBlock === cur && parent.catchClause) return true;
    if (
      ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ||
      ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)
    ) {
      if (isBarrierFunction(cur)) return false;
    }
    cur = parent;
  }
  return false;
}

/** Does the function containing `node` throw on purpose? Then callers own it. */
function enclosingFunctionThrows(node: ts.Node): boolean {
  let fn: ts.Node | null = null;
  let cur: ts.Node = node;
  while (cur.parent) {
    if (
      ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ||
      ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)
    ) { fn = cur; break; }
    cur = cur.parent;
  }
  if (!fn) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // A throw inside a nested function belongs to that function, not this one.
    if (
      n !== fn &&
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
        ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))
    ) return;
    if (ts.isThrowStatement(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

function analyze(fileName: string, text: string): Hit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];

  const visit = (node: ts.Node): void => {
    if (isFetchCall(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      let excuse: string | null = null;
      if (hasChainedCatch(node)) excuse = ".catch() on the chain";
      else if (enclosingTryHasCatch(node)) excuse = "enclosing try/catch";
      else if (enclosingFunctionThrows(node)) excuse = "helper throws — callers handle it";
      hits.push({ file: relative(REPO, fileName), line, excuse });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ── non-vacuity: a broken walk or analyzer must not pass silently ───────────

test("the client-component walk found a realistic file set", () => {
  assert.ok(
    clientFiles.length > 100,
    `only ${clientFiles.length} "use client" components found — the walk is broken`,
  );
});

const allHits = clientFiles.flatMap((f) => analyze(f, readFileSync(f, "utf8")));

test("the sweep actually found client fetch calls to classify", () => {
  assert.ok(
    allHits.length > 50,
    `only ${allHits.length} client fetch calls found — the analyzer is not matching`,
  );
});

test("the analyzer catches every unhandled shape and excuses every handled one", () => {
  const probe = `"use client";
    async function unhandledTryFinally() {           // 3 — VIOLATION
      try { const r = await fetch("/a"); return r; } finally { done(); }
    }
    async function unhandledBare() {                 // 6 — VIOLATION
      const r = await fetch("/b");
      return r;
    }
    function unhandledInCallback() {
      try {
        setTimeout(async () => { await fetch("/c"); }, 0);   // 11 — VIOLATION
      } catch { }
    }
    async function okTryCatch() {
      try { await fetch("/d"); } catch { report(); }         // 15 — excused
    }
    function okChained() {
      fetch("/e").then((r) => r.json()).catch(() => null);   // 18 — excused
    }
    async function okThrows() {
      const r = await fetch("/f");                           // 21 — excused
      if (!r.ok) throw new Error("nope");
      return r;
    }
    async function okAwaitedMap(ids) {
      try {
        await Promise.all(ids.map((id) => fetch(id)));       // 27 — excused
      } catch { report(); }
    }
  `;
  const hits = analyze("probe.tsx", probe);
  const violations = hits.filter((h) => h.excuse === null).map((h) => h.line);
  const excused = hits.filter((h) => h.excuse !== null).map((h) => h.line);

  assert.equal(hits.length, 7, `expected 7 fetch calls, found ${hits.length}`);
  assert.deepEqual(violations, [3, 6, 11], `wrong violations: ${JSON.stringify(hits)}`);
  assert.deepEqual(excused, [15, 18, 21, 27], `wrong excuses: ${JSON.stringify(hits)}`);
});

// A try whose ONLY clause is `finally` is the antipattern this whole file
// exists for. If the analyzer ever counted it as handled, the sweep below would
// pass while the bug class returned wholesale — so pin it on its own.
test("a try with only a finally is NOT treated as handled", () => {
  const hits = analyze("probe.tsx", `"use client";
    async function f() {
      try { await fetch("/x"); } finally { stop(); }
    }
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.excuse, null, "try/finally must not excuse an unhandled fetch");
});

// ── the sweep ───────────────────────────────────────────────────────────────

test("no client component leaves a fetch rejection unhandled", () => {
  const violations = allHits.filter((h) => h.excuse === null);
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}`),
    [],
    "A fetch in a client component rejects on any network failure, and neither " +
      "`if (!res.ok)` nor `finally` runs on that path — the operation silently " +
      "does not happen. Add a catch that puts something on screen (the house " +
      'shape is `catch { setError("Network error — please try again"); }`), or ' +
      "if this helper is meant to propagate, throw in it and handle it at the caller.",
  );
});
