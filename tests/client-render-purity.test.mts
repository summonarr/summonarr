// Guardrail 16 — no wall-clock read in the RENDER path of a "use client"
// component. This is a whole-tree structural sweep, not a per-module unit test.
//
// Why this file exists: guardrail 16 is the single most expensive rule in
// CLAUDE.md by shipped-bug count — SIX distinct React #418 hydration failures
// have come from this one antipattern (top-filter-bar, activity-history-table,
// activity-recent-plays, trash-guides/spec-section, activity-calendar, and the
// year-dropdown logic that bit filter-bar) — and until now it had ZERO test
// coverage. The only thing watching it was the E2E route crawl
// (.github/workflows/e2e.yml), which needs a built app, a live Postgres and a
// seeded admin, cannot run locally, and only catches a violation on a route it
// actually reaches with data that actually differs. A module-level
// `new Date()` that a bundler bakes at BUILD time drifts by days — the crawl
// runs minutes after the build and can miss it entirely.
//
// The failure mode, restated: the value is captured once during SSR and again
// at hydration. Server and client disagree, React throws #418, and the subtree
// is thrown away and re-rendered client-side. At module level a bundler may
// bake the value at build time, widening the drift from milliseconds to days.
//
// This sweep parses every client component with the TypeScript compiler (the
// classic TS 6 already in the tree — the same one `next build` loads) and walks
// the AST rather than grepping, because the distinction that matters is
// syntactic position, not the presence of the call. `Date.now()` inside an
// onClick handler is correct and common; the identical text one scope out, in
// the component body, is a hydration bug. A regex cannot tell those apart, and
// a regex sweep that flags both would be turned off within a week.
//
// A hit is EXCUSED only through a shape guardrail 16 documents or the codebase
// already relies on:
//   - deferred callback — useEffect/useLayoutEffect, setTimeout/setInterval/rAF,
//     a .then/.catch continuation, an addEventListener callback, or a setX(prev
//     => …) state updater. None of these run during render.
//   - event handler — a fn passed to a JSX `on*` prop, or bound to a
//     `handleFoo`/`onFoo` name. Runs on interaction, long after hydration.
//   - mounted-gated — the guardrail's fix (b): the call sits in the true branch
//     of `mounted ? … : …` or the right of `mounted && …`, so SSR renders the
//     falsy branch and the clock is only read post-hydration
//     (@/hooks/use-has-mounted). backup-ui.tsx is the in-tree example.
//   - a module-level camelCase HELPER whose every in-file callsite is itself
//     mounted-gated. `relativeTime`/`formatDateGroup` in audit-log-table.tsx are
//     pure functions of the clock — their safety is decided by their callers, so
//     the analyzer resolves the callsites instead of judging the body. A single
//     ungated callsite fails the file and names the count.
//
// Everything else — module scope, or a component body with no gate — fails.
//
// Non-vacuity: a broken walk or a TS API change that stops matching nodes would
// make a "no violations" result meaningless, so three guards run first. The walk
// must find a realistic client-component count, the sweep must still find the
// known-good hits it is meant to classify, and the analyzer is run against a
// synthetic source carrying one violation of each shape and asserted to catch
// every one.
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

// "use client" must be the first statement, but may sit under a comment banner —
// several components in this tree lead with the guardrail-16 explainer itself.
// Scanned linearly rather than with a regex: a single pattern over an
// alternation of line/block comments (`(?:…|/\*[\s\S]*?\*/)*`) backtracks
// catastrophically on adversarial `/*…*//*…` input (js/redos).
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
  what: string;
  /** null ⇒ render-path ⇒ violation */
  excuse: string | null;
}

const DEFERRED_CALLEES = new Set([
  "useEffect", "useLayoutEffect", "setTimeout", "setInterval",
  "requestAnimationFrame", "requestIdleCallback", "queueMicrotask",
  "then", "catch", "finally", "addEventListener",
]);

const MOUNTED = /^(mounted|hasMounted|isMounted|isClient|hydrated|isHydrated)$/i;

function subtreeReferencesMounted(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && MOUNTED.test(n.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Is `node` in the post-hydration branch of a `mounted ? … : …` / `mounted && …`? */
function isMountedGated(node: ts.Node): boolean {
  let cur: ts.Node = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isConditionalExpression(p) && p.whenTrue === cur && subtreeReferencesMounted(p.condition)) return true;
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      p.right === cur &&
      subtreeReferencesMounted(p.left)
    ) return true;
    cur = p;
  }
  return false;
}

/** Does this function run later rather than during render? */
function deferredReason(fn: ts.Node, parent: ts.Node): string | null {
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn as ts.Expression)) {
    const ex = parent.expression;
    const name = ts.isIdentifier(ex) ? ex.text : ts.isPropertyAccessExpression(ex) ? ex.name.text : "";
    if (DEFERRED_CALLEES.has(name)) return `deferred callback — argument to ${name}()`;
    // setX(prev => …): the updater runs inside React's dispatch, never in render.
    if (/^set[A-Z]/.test(name)) return `state updater — argument to ${name}()`;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && /^(handle|on)[A-Z_]/.test(parent.name.text)) {
    return `event handler — ${parent.name.text}`;
  }
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name && /^(handle|on)[A-Z_]/.test(fn.name.text)) {
    return `event handler — ${fn.name.text}`;
  }
  const attr = ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent) ? parent.parent : null;
  if (attr && ts.isIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.text)) {
    return `event handler — JSX ${attr.name.text}`;
  }
  return null;
}

/** The innermost enclosing module-level function/const declaration, if any. */
function topLevelHolder(node: ts.Node): ts.FunctionDeclaration | ts.VariableDeclaration | null {
  let cur: ts.Node = node;
  let holder: ts.FunctionDeclaration | ts.VariableDeclaration | null = null;
  while (cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.parent && ts.isSourceFile(cur.parent)) return cur;
    if (
      ts.isVariableDeclaration(cur) &&
      cur.parent?.parent &&
      ts.isVariableStatement(cur.parent.parent) &&
      ts.isSourceFile(cur.parent.parent.parent)
    ) holder = cur;
    cur = cur.parent;
  }
  return holder;
}

function analyze(fileName: string, text: string): Hit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];

  const visit = (node: ts.Node): void => {
    let what: string | null = null;
    // Date.now()
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date" &&
      node.expression.name.text === "now"
    ) what = "Date.now()";
    // new Date() — ONLY the no-argument form. `new Date(row.createdAt)` is a
    // deterministic parse of server-supplied data and is not a clock read.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) === 0
    ) what = "new Date()";

    if (what) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      let excuse: string | null = null;
      let insideAFunction = false;

      // Walk out through every enclosing function looking for a deferred shape.
      let cur: ts.Node = node;
      while (cur.parent) {
        if (
          ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ||
          ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)
        ) {
          insideAFunction = true;
          const why = deferredReason(cur, cur.parent);
          if (why) { excuse = why; break; }
        }
        cur = cur.parent;
      }

      if (!excuse && isMountedGated(node)) excuse = "mounted-gated (guardrail 16 fix b)";

      // A camelCase module-level helper is a pure clock function whose safety is
      // decided by its callers — resolve them rather than judging the body.
      if (!excuse && insideAFunction) {
        const holder = topLevelHolder(node);
        const name = holder?.name && ts.isIdentifier(holder.name) ? holder.name.text : null;
        if (name && /^[a-z]/.test(name)) {
          const calls: ts.CallExpression[] = [];
          const findCalls = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) calls.push(n);
            ts.forEachChild(n, findCalls);
          };
          findCalls(sf);
          const ungated = calls.filter((c) => !isMountedGated(c));
          if (calls.length > 0 && ungated.length === 0) {
            excuse = `helper ${name}() — all ${calls.length} callsite(s) mounted-gated`;
          } else if (ungated.length > 0) {
            what = `${what} (via helper ${name}(), ${ungated.length}/${calls.length} callsite(s) UNGATED)`;
          }
        }
      }

      if (!insideAFunction) excuse = null; // module scope is never excusable
      hits.push({ file: fileName, line, what, excuse });
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits;
}

const allHits = clientFiles.flatMap((f) => analyze(f, readFileSync(f, "utf8")));
const rel = (f: string): string => relative(REPO, f);
const fmt = (h: Hit): string => `${rel(h.file)}:${h.line}  ${h.what}`;

// ── non-vacuity guards ──────────────────────────────────────────────────────

test("the sweep found a realistic client-component set — a broken walk must not pass vacuously", () => {
  assert.ok(
    clientFiles.length > 100,
    `only ${clientFiles.length} "use client" files found under src/ — the walk or the directive regex is broken`,
  );
  assert.ok(
    clientFiles.some((f) => f.endsWith(".tsx")) && clientFiles.some((f) => f.endsWith(".ts")),
    'both .tsx components and .ts client modules (hooks, lib/client) must be in scope',
  );
});

test("the AST matcher still finds clock reads — a TS API drift must not silently empty the sweep", () => {
  assert.ok(
    allHits.length >= 8,
    `only ${allHits.length} clock reads matched across ${clientFiles.length} client files. The tree legitimately ` +
      `has few, but a drop to zero means the matcher stopped working, not that the code got cleaner.`,
  );
});

test("the analyzer catches every violation shape it claims to (synthetic self-test)", () => {
  // Each numbered comment is one shape this file promises to reject. If a
  // refactor of the analyzer stops catching one, this fails rather than the
  // sweep quietly going green.
  const bad = `
    "use client";
    const BUILD_STAMP = Date.now();                       // 1: module scope
    const CURRENT_YEAR = new Date().getFullYear();        // 2: module scope
    function relativeLabel(iso: string) {
      return String(Date.now() - new Date(iso).getTime()); // 3: helper, ungated callsite
    }
    export function Row({ iso }: { iso: string }) {
      const rendered = new Date();                         // 4: component body
      return <span title={String(rendered)}>{relativeLabel(iso)}{Date.now()}</span>; // 5: inline JSX
    }
  `;
  const violations = analyze("synthetic.tsx", bad).filter((h) => h.excuse === null);
  assert.ok(
    violations.length >= 5,
    `the analyzer caught only ${violations.length}/5 planted violations:\n${violations.map((v) => `  ${v.line}: ${v.what}`).join("\n")}`,
  );
  assert.ok(
    violations.some((v) => v.what.includes("UNGATED")),
    "the helper-callsite resolution must report the ungated callsite count",
  );

  // …and does NOT fire on the documented fixes.
  const good = `
    "use client";
    import { useHasMounted } from "@/hooks/use-has-mounted";
    function relativeLabel(iso: string) { return String(Date.now() - new Date(iso).getTime()); }
    export function Row({ iso, maxYear }: { iso: string; maxYear: number }) {
      const mounted = useHasMounted();
      const onPick = () => { const at = Date.now(); void at; };
      useEffect(() => { const t = new Date(); void t; }, []);
      return <button onClick={() => void new Date()} onFocus={onPick} data-y={maxYear}>
        {mounted ? relativeLabel(iso) : ""}
      </button>;
    }
  `;
  const falsePositives = analyze("synthetic-good.tsx", good).filter((h) => h.excuse === null);
  assert.deepEqual(
    falsePositives.map((h) => `${h.line}: ${h.what}`),
    [],
    "the analyzer must not flag the guardrail's own documented fix shapes — a sweep with false positives gets disabled",
  );
});

// ── the guardrail ───────────────────────────────────────────────────────────

test("guardrail 16: no client component reads the clock at MODULE scope", () => {
  // The worst variant: a bundler can bake this at build time, so the SSR/client
  // drift is days rather than milliseconds. Never excusable — hoist it to a
  // server component prop (fix a) or read it inside a mounted gate (fix b).
  const offenders = allHits.filter((h) => h.excuse === null && !h.what.includes("helper"));
  const moduleScope = offenders.filter((h) => {
    const text = readFileSync(h.file, "utf8");
    const sf = ts.createSourceFile(h.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let atModuleScope = false;
    const visit = (n: ts.Node): void => {
      if (sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 === h.line) {
        let cur: ts.Node = n, inFn = false;
        while (cur.parent) {
          if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) inFn = true;
          cur = cur.parent;
        }
        if (!inFn) atModuleScope = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return atModuleScope;
  });

  assert.deepEqual(
    moduleScope.map(fmt),
    [],
    "module-level clock read in a client component — bundlers bake this at BUILD time (React #418)",
  );
});

test("guardrail 16: no client component reads the clock in the RENDER path", () => {
  const violations = allHits.filter((h) => h.excuse === null);

  assert.deepEqual(
    violations.map(fmt),
    [],
    `Date.now()/new Date() reached during render in a "use client" component. Server and client capture ` +
      `different values → React #418 and a discarded subtree. Fix with one of:\n` +
      `  (a) pass the reference time down from a server component as a prop\n` +
      `      <ActivityCalendar today={new Date().toISOString()} />\n` +
      `  (b) gate on useHasMounted() when the value is cosmetic\n` +
      `      const mounted = useHasMounted(); … {mounted ? formatRelativeTime(row.startedAt) : ""}\n` +
      `See CLAUDE.md guardrail 16 — six shipped hydration bugs came from this.`,
  );
});

test("every excused clock read still names a recognized deferral shape", () => {
  // Guards the excuse list itself: an excuse string the analyzer can emit but
  // this test doesn't recognize means the classifier grew a hole silently.
  const recognized = /^(deferred callback|state updater|event handler|mounted-gated|helper )/;
  const unrecognized = allHits.filter((h) => h.excuse !== null && !recognized.test(h.excuse));
  assert.deepEqual(unrecognized.map((h) => `${fmt(h)} → ${h.excuse}`), []);
});
