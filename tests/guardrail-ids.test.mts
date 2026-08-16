// Structural invariants of the guardrail list in CLAUDE.md — the numbering
// itself, which nothing else checks.
//
// Why this needs a test: guardrail ids are a PUBLIC NAMING SCHEME, not
// presentation. ~710 comments across src/, tests/ and scripts/ cite rules by
// number ("guardrail 23", "guardrail 6b"), as do merged commit messages, which
// cannot be edited at all. So a number is a permanent address: renumbering an
// existing guardrail silently repoints every one of those citations at the
// wrong rule, and no compiler, linter or existing test would notice.
//
// The failure mode this was written for: every branch that adds a rule appends
// the next sequential number at the tail of the list, so two branches in flight
// at the same time BOTH claim it. That collided twice in one afternoon (36 and
// 37 each got claimed by two branches). Git flags it only when the inserts land
// close enough to conflict textually — resolve a conflict by "keeping both",
// or land two rules that git auto-merges, and the file ships with two rules
// wearing the same number. From then on every citation of that number is
// ambiguous, and the second one is unreachable by name.
//
// What is pinned, and what breaks if it drifts:
//
//   - Ids are UNIQUE. Two "36"s make both unciteable and are exactly what a
//     careless conflict resolution produces.
//   - Every `guardrail N` cross-reference inside CLAUDE.md RESOLVES to a rule
//     that exists. Catches a citation of a rule that was renamed or never
//     landed, and catches the other half of a bad renumber.
//   - Letter-suffixed ids (`16a`) have a numeric parent (`16`) and sit directly
//     after it. That adjacency is the whole point of the suffix convention:
//     suffixes exist so a new rule attaches to its topic mid-file instead of
//     joining the queue at the tail, which is what spreads concurrent edits
//     across the file and stops them colliding in the first place.
//
// Deliberately NOT pinned: that numeric ids are gapless or sorted. A retired
// rule should leave its number burned rather than shift everything below it —
// the citations are what matter, not tidiness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CLAUDE_MD = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");

/** Only the guardrail list — other numbered lists live in this file too (the
 *  release steps, "Writing future rules"), and they are not guardrails. */
function guardrailSection(src: string): string {
  const start = src.indexOf("\n## Guardrails\n");
  assert.ok(start !== -1, "CLAUDE.md must still have a '## Guardrails' section");
  const end = src.indexOf("\n## Working principles\n", start);
  assert.ok(end !== -1, "the guardrail list must still be terminated by '## Working principles'");
  return src.slice(start, end);
}

interface Guardrail {
  id: string;
  /** Position in the list, top to bottom. */
  index: number;
}

/** A guardrail heading starts at column 0: `13.` or `16a.` followed by a space. */
function parseGuardrails(section: string): Guardrail[] {
  const out: Guardrail[] = [];
  const re = /^(\d+[a-z]?)\. /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    out.push({ id: m[1], index: out.length });
  }
  return out;
}

const SECTION = guardrailSection(CLAUDE_MD);
const GUARDRAILS = parseGuardrails(SECTION);

test("the guardrail parser still finds the list (guards the tests below)", () => {
  // A silent parse failure would make every assertion below vacuously pass, so
  // pin the shape: a substantial list that includes known long-lived ids.
  assert.ok(
    GUARDRAILS.length >= 40,
    `expected the guardrail list to parse; found ${GUARDRAILS.length} entries`,
  );
  const ids = new Set(GUARDRAILS.map((g) => g.id));
  for (const known of ["1", "13", "16", "16a", "35"]) {
    assert.ok(ids.has(known), `guardrail ${known} should parse out of the list`);
  }
});

test("guardrail ids are unique — no two rules share a number", () => {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const g of GUARDRAILS) {
    if (seen.has(g.id)) dupes.push(g.id);
    else seen.set(g.id, g.index);
  }
  assert.deepEqual(
    dupes,
    [],
    `duplicate guardrail id(s): ${dupes.join(", ")}. Two branches claimed the same ` +
      `number — renumber YOUR new rule to the next free id, never the one already ` +
      `on the integration branch (its number may already be cited in code).`,
  );
});

test("every `guardrail N` cross-reference in CLAUDE.md resolves to a rule that exists", () => {
  const ids = new Set(GUARDRAILS.map((g) => g.id));
  // "guardrail 13", "guardrails 27/28", "guardrail 6b" — the plural form lists
  // several, so pull every number that follows the keyword.
  const dangling = new Set<string>();
  const re = /guardrails?\s+((?:\d+[a-z]?)(?:\s*[/,]\s*(?:\d+[a-z]?))*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CLAUDE_MD)) !== null) {
    for (const raw of m[1].split(/[/,]/)) {
      const id = raw.trim();
      if (id && !ids.has(id)) dangling.add(id);
    }
  }
  assert.deepEqual(
    [...dangling].sort(),
    [],
    `CLAUDE.md cites guardrail(s) that do not exist: ${[...dangling].sort().join(", ")}`,
  );
});

test("a letter-suffixed guardrail has a numeric parent and sits directly after it", () => {
  const problems: string[] = [];
  for (const g of GUARDRAILS) {
    const suffix = /^(\d+)[a-z]$/.exec(g.id);
    if (!suffix) continue;
    const parent = suffix[1];
    const prev = GUARDRAILS[g.index - 1];
    if (!prev) {
      problems.push(`${g.id} is first in the list — it has no parent to attach to`);
      continue;
    }
    // Directly after its parent, or after an earlier sibling (16a then 16b).
    const prevIsParent = prev.id === parent;
    const prevIsSibling = new RegExp(`^${parent}[a-z]$`).test(prev.id);
    if (!prevIsParent && !prevIsSibling) {
      problems.push(`${g.id} follows ${prev.id}; it must sit directly after guardrail ${parent}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `letter-suffixed guardrails must be adjacent to their parent:\n  ${problems.join("\n  ")}`,
  );
});
