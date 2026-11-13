// A browser request must end: a client module never calls a bare `fetch(` (use
// fetchJson for JSON, timedFetch when the Response itself is needed) and never
// disables the timeout with Infinity (a route that runs for minutes passes
// LONG_RUN_TIMEOUT_MS). Scanned: every "use client" module, src/lib/client and
// src/hooks, through the TypeScript AST so comments and strings never match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { hasUseClientDirective } from "./_use-client.mts";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "generated" && e.name !== "node_modules") walk(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Files that may call fetch directly, each with its own abort path.
const RAW_FETCH_ALLOWED: Record<string, string> = {
  "src/lib/client/fetch-json.ts": "the two wrappers themselves",
  "src/app/auth/plex/done/page.tsx": "each call carries its own anySignal + request timeout",
  "src/components/admin/arr-command-watch.tsx": "AbortSignal.timeout on the call",
};
const INFINITY_ALLOWED: Record<string, string> = {
  "src/lib/client/fetch-json.ts": "documents the option",
};

function isClientScope(rel: string, text: string): boolean {
  return (
    rel.startsWith("src/lib/client/") ||
    rel.startsWith("src/hooks/") ||
    hasUseClientDirective(text)
  );
}

function scan(text: string): { rawFetch: number[]; infinity: number[] } {
  const sf = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rawFetch: number[] = [];
  const infinity: number[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") rawFetch.push(line(n));
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      /timeout/i.test(n.name.text) &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === "Infinity"
    ) infinity.push(line(n));
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      /timeout/i.test(n.name.text) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === "Infinity"
    ) infinity.push(line(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { rawFetch, infinity };
}

test("scanner finds a bare fetch and an Infinity timeout, ignores comments and member calls", () => {
  const r = scan(`// fetch(x)\nconst s = "fetch(y)";\nawait fetch(u);\nwindow.fetch(u);\nfetchJson(u, { timeoutMs: Infinity });\nconst T_TIMEOUT = Infinity;`);
  assert.deepEqual(r.rawFetch, [3]);
  assert.deepEqual(r.infinity, [5, 6]);
});

test("client modules never call a bare fetch or switch a timeout off", () => {
  const raw: string[] = [];
  const inf: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    if (!isClientScope(rel, text)) continue;
    const found = scan(text);
    if (!(rel in RAW_FETCH_ALLOWED)) for (const l of found.rawFetch) raw.push(`${rel}:${l}`);
    if (!(rel in INFINITY_ALLOWED)) for (const l of found.infinity) inf.push(`${rel}:${l}`);
  }
  assert.deepEqual(raw, [], "use fetchJson (JSON) or timedFetch (the Response) from @/lib/client/fetch-json");
  assert.deepEqual(inf, [], "pass LONG_RUN_TIMEOUT_MS instead of Infinity");
});

test("short admin writes keep a finite, modest bound", () => {
  const server = readFileSync(join(ROOT, "src/components/admin/server-user-table.tsx"), "utf8");
  assert.ok(!/LONG_RUN_TIMEOUT_MS/.test(server), "a one-user write uses the default timeout");
  for (const rel of ["request-actions.tsx", "release-search-dialog.tsx", "use-queue-actions.ts"]) {
    const text = readFileSync(join(ROOT, "src/components/admin", rel), "utf8");
    assert.ok(!/LONG_RUN_TIMEOUT_MS/.test(text), `${rel} waits on an arr push: ARR_WRITE_TIMEOUT_MS, not the long-run bound`);
    assert.ok(/ARR_WRITE_TIMEOUT_MS/.test(text), rel);
  }
});

test("single-flight submits run through useAsyncAction with their abort signal", () => {
  const files = [
    "src/components/votes/vote-actions.tsx",
    "src/components/votes/vote-delete-button.tsx",
    "src/components/media/watchlist-button.tsx",
    "src/components/watchlist/watchlist-grid.tsx",
    "src/components/media/report-issue-button.tsx",
    "src/app/setup/setup-form.tsx",
    "src/components/profile/change-password.tsx",
    "src/components/profile/delete-account.tsx",
    "src/components/profile/auto-request-prefs.tsx",
  ];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(/useAsyncAction\(\)/.test(text), `${rel} uses useAsyncAction`);
    assert.ok(/ifBusy: "skip"/.test(text), `${rel} skips a second submit while one is in flight`);
    assert.ok(/\bsignal\b/.test(text.replace(/\/\/.*$/gm, "")), `${rel} passes the run's signal on`);
  }
});
