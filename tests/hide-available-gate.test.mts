// Structural pin: every hideAvailable filter must gate on the user's own
// server visibility.
//
// hideAvailable means "hide things I can already watch". Which servers "I" can
// watch is per-user — a Plex-pinned user must not have Jellyfin-only titles
// hidden from them, and under guardrail 35 a restricted instance is invisible
// to an ungranted user entirely. So the predicate is
//
//     (showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)
//
// and NOT the ungated `m.plexAvailable || m.jellyfinAvailable`.
//
// This drifted in exactly the way an unpinned duplicated predicate does. The
// two paginated ROUTES (/api/top-rated, /api/upcoming) gated correctly while
// their server-rendered PAGES did not, so the first page of /top and every
// subsequent page came from different filters and showed different sets. The
// home rails had the same bug against the pages they link to. browse-query.ts
// was fixed the same way in an earlier pass.
//
// Six copies of one predicate is why this is a sweep and not six assertions:
// the failure is silent, type-correct, and invisible to lint.
//
// .tsx cannot be imported here (no JSX transform in the loader), so this reads
// source text via the TypeScript compiler API — the same approach as
// tests/client-fetch-error-handling.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = dir + entry;
    if (statSync(full).isDirectory()) walk(full + "/", out);
    else if (/\.tsx?$/.test(entry) && !full.includes("/generated/")) out.push(full);
  }
  return out;
}

const files = walk(SRC);

/**
 * Every `<expr>.plexAvailable` / `.jellyfinAvailable` read that sits under a
 * hideAvailable guard, paired with the full text of the guarded expression.
 *
 * Ancestry, not a line-count window. A fixed lookback silently SKIPS a site
 * whenever the guard drifts out of range — a comment above the filter is
 * enough — and a skipped site reads exactly like a passing one. That is the
 * failure this sweep exists to prevent, so it must not have it itself.
 *
 * The walk stops at the nearest enclosing IfStatement (`if (hideAvailable) {
 * … filter … }`) or at the guarded expression itself (`if (hideAvailable &&
 * (…)) continue;`), which covers both shapes in use.
 */
function guardedAvailabilityReads(source: string): { line: number; text: string; expr: string }[] {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: { line: number; text: string; expr: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === "plexAvailable" || node.name.text === "jellyfinAvailable")
    ) {
      // Climb to the nearest enclosing if/loop, collecting the widest
      // expression the read participates in on the way.
      // Track the widest EXPRESSION the read participates in — that is what
      // must carry the visibility flag — while climbing statements to reach the
      // guard. Climbing must NOT stop at the enclosing statement: in
      // `if (opts.hideAvailable) { result = result.filter(m => !(…)) }` the
      // filter's own statement never mentions hideAvailable, so stopping there
      // reported the site as unguarded and skipped it.
      let expr: ts.Node = node;
      let cursor: ts.Node | undefined = node.parent;
      let guarded = false;
      while (cursor) {
        if (ts.isIfStatement(cursor)) {
          guarded = /\bhideAvailable\b/.test(cursor.expression.getText(sf));
          // The condition itself is the guarded expression for the
          // `if (hideAvailable && (…)) continue;` shape.
          if (guarded && cursor.expression.getStart(sf) <= node.getStart(sf) &&
              node.getEnd() <= cursor.expression.getEnd()) {
            expr = cursor.expression;
          }
          break;
        }
        // A declared function bounds the search: past it we would be reading
        // some unrelated `hideAvailable` elsewhere in the file. Inline arrows
        // (the filter callbacks) are deliberately climbed through.
        if (ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor)) break;
        if (ts.isExpression(cursor)) expr = cursor;
        cursor = cursor.parent;
      }
      if (guarded) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ line: line + 1, text: node.getText(sf), expr: expr.getText(sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

test("every hideAvailable filter gates availability on the user's visible servers", () => {
  const offenders: string[] = [];
  let inspected = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("hideAvailable")) continue;

    for (const hit of guardedAvailabilityReads(source)) {
      inspected++;
      // The read must be conjoined with its own server's visibility flag,
      // anywhere in the guarded expression.
      const flag = hit.text.includes("plexAvailable") ? "showPlex" : "showJellyfin";
      if (!new RegExp(`(?:\\w+\\.)?${flag}\\s*&&`).test(hit.expr)) {
        offenders.push(
          `${file.slice(SRC.length)}:${hit.line} — ${hit.text} is filtered under hideAvailable ` +
            `without a ${flag} guard:\n      ${hit.expr.replace(/\s+/g, " ").slice(0, 160)}`,
        );
      }
    }
  }

  // A sweep that inspects nothing passes vacuously and is worse than no pin —
  // and this one has already caught itself doing exactly that: an earlier
  // line-window heuristic silently skipped the site whose guard a comment had
  // pushed out of range, and reported green. 14 reads across 6 sites today.
  assert.ok(
    inspected >= 12,
    `only inspected ${inspected} availability reads under a hideAvailable guard — ` +
      `the walk or the context heuristic is broken, not the invariant`,
  );

  assert.equal(
    offenders.length,
    0,
    `hideAvailable must hide only what the USER can watch. Ungated:\n  ${offenders.join("\n  ")}`,
  );
});
