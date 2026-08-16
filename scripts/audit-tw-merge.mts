#!/usr/bin/env node
/**
 * tw-merge group-table auditor.
 *
 * [src/lib/tw-merge.ts](../src/lib/tw-merge.ts) is a hand-written stand-in for
 * the `tailwind-merge` package (deliberately not installed). It decides which
 * utilities conflict using a hand-maintained table of prefix regexes, and every
 * bug that table has ever shipped is one of three shapes:
 *
 *   1. OVER-MERGE  — one group spans utilities that set DIFFERENT CSS
 *                    properties, so one silently deletes the other. This is
 *                    the bug that made `ui/drawer.tsx` render no top border
 *                    (`border-t` swallowed by the border-colour catch-all) and
 *                    `ui/avatar.tsx` render no background (`bg-primary`
 *                    swallowed by `bg-blend-color`).
 *   2. UNDER-MERGE — utilities that set the SAME property live in different
 *                    groups, so they never collapse and the winner falls to
 *                    stylesheet order instead of last-write.
 *   3. UNGROUPED   — a whole family the table models nowhere. Harmless until
 *                    src/ uses two of its members, at which point it is (2).
 *
 * All three are decided against the AUTHORITATIVE source rather than a list
 * kept by hand: the auditor loads the installed Tailwind's design system,
 * enumerates every utility it can generate, compiles each one to CSS, and uses
 * the declarations it emits as that utility's property signature. Two classes
 * conflict iff their signatures match. Nothing here encodes a belief about
 * what Tailwind ships — upgrade Tailwind and this re-derives itself, which is
 * how the v4 renames (`bg-left-top` → `bg-top-left`) surface.
 *
 * What it does NOT check: that merging is *desirable* for a given pair, the
 * variant/important class-space logic, or anything about how src/ composes
 * classes. `tests/tw-merge.test.mts` pins the behaviour; this pins the table's
 * shape against Tailwind itself.
 *
 * Exit code is non-zero on any finding outside the allowlists, so this is
 * wired into CI.
 *
 * Usage:
 *   node scripts/audit-tw-merge.mts           # human report, fails on new findings
 *   node scripts/audit-tw-merge.mts --json    # machine-readable
 *   node scripts/audit-tw-merge.mts --list    # print allowlisted findings too
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { matchGroup } from "../src/lib/tw-merge.ts";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(text: string, c: string): string {
  if (!process.stdout.isTTY) return text;
  return `${c}${text}${COLORS.reset}`;
}

/**
 * Groups that legitimately span more than one property signature. Every entry
 * is a family whose members are MUTUALLY EXCLUSIVE — a reset, or one shorthand
 * spelled two ways — so collapsing them is the point, not a bug. Adding here
 * is a claim that the utilities cannot meaningfully apply together; check the
 * emitted CSS before you make it.
 */
const OVER_MERGE_ALLOWLIST: Array<{ group: string; reason: string }> = [
  { group: "bg-image", reason: "bg-linear-* declares --tw-gradient-position and the others background-image, but all are the one background image" },
  { group: "scale", reason: "scale-3d/scale-none reset the same `scale` the numeric utilities set" },
  { group: "translate", reason: "translate-3d/translate-none reset the same `translate`" },
  { group: "break", reason: "break-normal also resets overflow-wrap; all four are the one word-breaking choice" },
  { group: "duration", reason: "duration-initial is the v4 reset for the same duration" },
  { group: "ease", reason: "ease-initial is the v4 reset for the same timing function" },
  { group: "transition", reason: "transition-none sets only transition-property; it is the reset for the same shorthand" },
  { group: "outline-style", reason: "outline-hidden also zeroes outline/outline-offset but is still one of the mutually exclusive outline styles (as in real tailwind-merge)" },
  { group: "via", reason: "via-none drops the via stop that via-<color> sets" },
];

/**
 * Property signatures that legitimately live in more than one group. Each is a
 * case where Tailwind emits the same declarations for utilities that target
 * different ELEMENTS, which the signature alone cannot see.
 */
const UNDER_MERGE_ALLOWLIST: Array<{ groups: string[]; reason: string }> = [
  { groups: ["border-color", "divide-color"], reason: "divide-* applies border-color to `& > :not(:last-child)`, not the element" },
  { groups: ["border-style", "divide-style"], reason: "same child-selector split as divide-color" },
  { groups: ["placeholder", "text-color"], reason: "placeholder-* sets `color` on the ::placeholder pseudo-element" },
];

/**
 * Families the table models nowhere. This is only reported when src/ actually
 * uses two of them, so the allowlist covers families that are used but cannot
 * collide. Empty today: every family src/ touches has a group.
 */
const UNGROUPED_ALLOWLIST: Array<{ property: string; reason: string }> = [];

interface Utility {
  name: string;
  signature: string;
  group: string | null;
}

/**
 * Load the installed Tailwind's design system. `__unstable__loadDesignSystem`
 * is the same entry point the official IntelliSense extension uses; it is the
 * only way to enumerate the utility set, and being unstable it may move on a
 * major upgrade. If it does, this throws loudly rather than silently auditing
 * an empty set — a green run on zero utilities would be worse than a red one.
 */
async function loadUtilities(): Promise<Utility[]> {
  const require_ = createRequire(import.meta.url);
  let twRoot: string;
  try {
    twRoot = dirname(require_.resolve("tailwindcss/package.json"));
  } catch {
    throw new Error("tailwindcss is not installed — run `npm ci` before auditing.");
  }

  const tw = await import("tailwindcss");
  const load = (tw as Record<string, unknown>).__unstable__loadDesignSystem;
  if (typeof load !== "function") {
    throw new Error(
      "tailwindcss no longer exports __unstable__loadDesignSystem. The auditor needs a way " +
        "to enumerate utilities; check the installed version's exports and update this script.",
    );
  }

  const ds = await (load as (css: string, opts: unknown) => Promise<Record<string, unknown>>)(
    `@import "tailwindcss";`,
    {
      base: process.cwd(),
      loadStylesheet: async (id: string, base: string) => {
        const file =
          id === "tailwindcss"
            ? join(twRoot, "index.css")
            : id.startsWith(".")
              ? resolve(base, id)
              : resolve(twRoot, id.replace(/^tailwindcss\//, ""));
        return { base: dirname(file), content: readFileSync(file, "utf8") };
      },
      loadModule: async () => ({ base: process.cwd(), module: {} }),
    },
  );

  // Both are methods on the design system and read `this`; calling them
  // detached throws inside Tailwind rather than returning an empty list.
  const getClassList = (ds.getClassList as () => Array<string | [string, unknown]>).bind(ds);
  const candidatesToCss = (ds.candidatesToCss as (c: string[]) => Array<string | null>).bind(ds);
  const names = getClassList().map((e) => (Array.isArray(e) ? e[0] : e));
  if (names.length === 0) throw new Error("Tailwind returned an empty class list — nothing to audit.");

  const out: Utility[] = [];
  const CHUNK = 500;
  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    const css = candidatesToCss(slice);
    slice.forEach((name, k) => {
      const signature = signatureOf(css[k]);
      if (signature) out.push({ name, signature, group: matchGroup(name) });
    });
  }
  return out;
}

/**
 * A utility's property signature: the declarations its rule emits, plus any
 * selector suffix. `@property` blocks are stripped — they only register custom
 * properties and are identical across a whole family. Custom properties are
 * KEPT, because they are exactly what distinguishes utilities that share a
 * shorthand: `shadow-md` and `ring-2` both write `box-shadow`, but only their
 * --tw-shadow / --tw-ring-shadow vars say they do not conflict.
 */
function signatureOf(css: string | null | undefined): string | null {
  if (!css) return null;
  const body = css.replace(/@property\s+[^{]*\{[^}]*\}/gs, "");
  const props = new Set<string>();
  for (const m of body.matchAll(/(?:^|[{;])\s*(--[\w-]+|[a-z-]+)\s*:/g)) props.add(m[1]);
  if (props.size === 0) return null;
  const selector = body.match(/^\s*\.[^{\s]+([^{]*)\{/);
  const suffix = (selector?.[1] ?? "").trim().replace(/\s+/g, " ");
  return JSON.stringify([[...props].sort(), suffix]);
}

/** Every whitespace-separated token appearing in a string literal under src/. */
function tokensUsedInSrc(): Set<string> {
  const files: string[] = [];
  const SRC = join(process.cwd(), "src");
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "generated" || entry === "node_modules") continue;
      const path = join(dir, entry);
      // The table's own group NAMES are string literals; they are not classes.
      if (path.endsWith(join("lib", "tw-merge.ts"))) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(path)) files.push(path);
    }
  })(SRC);

  const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gs;
  const VARIANT = /^(?:[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|\[[^\]]+\]|data-\[[^\]]+\]|aria-\[[^\]]+\]|group-[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|peer-[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|has-\[[^\]]+\]|supports-\[[^\]]+\]|max-[a-z0-9-]+|min-[a-z0-9-]+):/;

  const used = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(LITERAL)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? "";
      // Only the static chunks of a template literal are mergeable text.
      const chunks = m[3] !== undefined ? raw.split(/\$\{[^}]*\}/s) : [raw];
      for (const chunk of chunks) {
        for (let token of chunk.split(/\s+/)) {
          let variant;
          while ((variant = token.match(VARIANT))) token = token.slice(variant[0].length);
          if (token) used.add(token.replace(/!$/, ""));
        }
      }
    }
  }
  return used;
}

interface Finding {
  kind: "over-merge" | "under-merge" | "ungrouped";
  key: string;
  detail: string[];
  allowlisted: string | null;
}

function audit(utilities: Utility[], used: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const readable = (signature: string) => {
    const props = JSON.parse(signature)[0] as string[];
    const standard = props.filter((p) => !p.startsWith("--"));
    return (standard.length ? standard : props).join(", ");
  };
  const sample = (names: string[]) =>
    names.slice(0, 4).join(" ") + (names.length > 4 ? ` … (+${names.length - 4})` : "");

  // 1. OVER-MERGE — one group spanning several property signatures.
  const byGroup = new Map<string, Map<string, string[]>>();
  for (const u of utilities) {
    if (u.group === null) continue;
    let sigs = byGroup.get(u.group);
    if (!sigs) byGroup.set(u.group, (sigs = new Map()));
    const names = sigs.get(u.signature) ?? [];
    names.push(u.name);
    sigs.set(u.signature, names);
  }
  for (const [group, sigs] of byGroup) {
    if (sigs.size < 2) continue;
    const allow = OVER_MERGE_ALLOWLIST.find((a) => a.group === group);
    findings.push({
      kind: "over-merge",
      key: group,
      detail: [...sigs.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sig, names]) => `${String(names.length).padStart(5)}x  ${sample(names).padEnd(48)} ${readable(sig)}`),
      allowlisted: allow?.reason ?? null,
    });
  }

  // 2. UNDER-MERGE — one property signature spread across several groups.
  const bySignature = new Map<string, Map<string, string[]>>();
  for (const u of utilities) {
    if (u.group === null) continue;
    let groups = bySignature.get(u.signature);
    if (!groups) bySignature.set(u.signature, (groups = new Map()));
    const names = groups.get(u.group) ?? [];
    names.push(u.name);
    groups.set(u.group, names);
  }
  for (const [signature, groups] of bySignature) {
    if (groups.size < 2) continue;
    const names = [...groups.keys()].sort();
    const allow = UNDER_MERGE_ALLOWLIST.find(
      (a) => a.groups.length === names.length && a.groups.every((g) => names.includes(g)),
    );
    findings.push({
      kind: "under-merge",
      key: readable(signature),
      detail: [...groups.entries()].map(([g, n]) => `${g.padEnd(22)} ${String(n.length).padStart(4)}x  ${sample(n)}`),
      allowlisted: allow?.reason ?? null,
    });
  }

  // 3. UNGROUPED — a family with no group at all, of which src/ uses a member.
  //    A one-member family cannot collide with itself, so it is not a finding.
  const ungrouped = new Map<string, string[]>();
  for (const u of utilities) {
    if (u.group !== null) continue;
    const names = ungrouped.get(u.signature) ?? [];
    names.push(u.name);
    ungrouped.set(u.signature, names);
  }
  for (const [signature, names] of ungrouped) {
    if (names.length < 2) continue;
    const live = names.filter((n) => used.has(n));
    if (live.length === 0) continue;
    const property = readable(signature);
    const allow = UNGROUPED_ALLOWLIST.find((a) => a.property === property);
    findings.push({
      kind: "ungrouped",
      key: property,
      detail: [`${sample(names)}`, `used in src/: ${live.slice(0, 6).join(" ")}`],
      allowlisted: allow?.reason ?? null,
    });
  }

  return findings;
}

const KIND_HINT: Record<Finding["kind"], string> = {
  "over-merge": "one group spans utilities that set DIFFERENT properties — one silently deletes the other",
  "under-merge": "utilities setting the SAME property sit in different groups — they never collapse",
  "ungrouped": "a family with no group at all, and src/ uses it — two of them will never collapse",
};

async function main() {
  const json = process.argv.includes("--json");
  const list = process.argv.includes("--list");

  const utilities = await loadUtilities();
  const findings = audit(utilities, tokensUsedInSrc());
  const failures = findings.filter((f) => f.allowlisted === null);
  const allowed = findings.filter((f) => f.allowlisted !== null);

  if (json) {
    console.log(JSON.stringify({ audited: utilities.length, findings }, null, 2));
    process.exit(failures.length > 0 ? 1 : 0);
  }

  console.log(color("\n  tw-merge Group Table Audit", COLORS.bold + COLORS.cyan));
  console.log(color("  ──────────────────────────", COLORS.dim));
  console.log(
    `\n  ${color(String(utilities.length), COLORS.bold)} Tailwind utilities checked against the group table` +
      ` ${color(`(${allowed.length} findings allowlisted)`, COLORS.dim)}\n`,
  );

  if (list) {
    for (const f of allowed) {
      console.log(`  ${color("[ok]", COLORS.green)} ${color(f.kind, COLORS.dim)} ${color(f.key, COLORS.bold)}`);
      console.log(color(`         ${f.allowlisted}`, COLORS.dim));
    }
    if (allowed.length > 0) console.log();
  }

  if (failures.length === 0) {
    console.log(color("  ✓ Every group maps 1:1 onto a real CSS property.\n", COLORS.green));
    process.exit(0);
  }

  console.log(color(`  ✗ ${failures.length} finding(s):\n`, COLORS.red + COLORS.bold));
  for (const f of failures) {
    console.log(`  ${color("[FAIL]", COLORS.red)} ${color(f.kind, COLORS.yellow)} ${color(f.key, COLORS.bold)}`);
    console.log(color(`         ${KIND_HINT[f.kind]}`, COLORS.dim));
    for (const line of f.detail) console.log(color(`         ${line}`, COLORS.dim));
  }
  console.log(
    color(
      "\n  Fix by adding a more specific group BEFORE the catch-all (groupOf returns the\n" +
        "  first match), or — if the utilities are mutually exclusive and SHOULD collapse —\n" +
        "  add an allowlist entry with a reason in scripts/audit-tw-merge.mts.\n",
      COLORS.dim,
    ),
  );
  process.exit(1);
}

// Only run the CLI when invoked directly, so the helpers stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(color(`\n  tw-merge audit failed to run: ${err instanceof Error ? err.message : err}\n`, COLORS.red));
    if (err instanceof Error && err.stack) console.error(color(err.stack, COLORS.dim));
    process.exit(1);
  });
}
