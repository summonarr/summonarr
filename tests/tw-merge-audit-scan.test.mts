// Pins the src/ token scanner behind `npm run audit:tw-merge` (guardrail 39).
// A quote-pairing regex over the raw file let an apostrophe in a comment or JSX
// text re-pair every later quote, so real className tokens never reached the
// UNGROUPED / MISFILED checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classTokensInSource } from "../scripts/audit-tw-merge.mts";

test("an apostrophe in a comment does not hide a later className", () => {
  const src = [
    "// we can't use the bank's form here",
    "export function A() {",
    '  return <div className="hover:border-[var(--ds-border-strong)] p-2">x</div>;',
    "}",
  ].join("\n");
  const used = classTokensInSource(src, "a.tsx");
  assert.ok(used.has("border-[var(--ds-border-strong)]"));
  assert.ok(used.has("p-2"));
});

test("apostrophes and backticks in JSX text and block comments are not literals", () => {
  const src = [
    "/* `onClick` isn't wired */",
    "export function B() {",
    "  return <p>it's `here` <span className=\"lg:bottom-[calc(env(safe-area-inset-bottom)_+_16px)]\" /></p>;",
    "}",
  ].join("\n");
  const used = classTokensInSource(src, "b.tsx");
  assert.ok(used.has("bottom-[calc(env(safe-area-inset-bottom)_+_16px)]"));
  assert.ok(!used.has("onClick"));
  assert.ok(![...used].some((t) => t.includes('"')), "no stray quote characters in tokens");
});

test("template literal static chunks and nested strings are scanned", () => {
  const src = "const c = `text-sm ${on ? \"bg-red-500\" : 'bg-zinc-800'} divide-[var(--x)]`;";
  const used = classTokensInSource(src, "c.ts");
  for (const t of ["text-sm", "bg-red-500", "bg-zinc-800", "divide-[var(--x)]"]) assert.ok(used.has(t), t);
});

test("the two files the regex scanner mis-tokenized now yield their real tokens", () => {
  const donate = readFileSync("src/app/(app)/donate/page.tsx", "utf8");
  const toast = readFileSync("src/components/ui/toast.tsx", "utf8");
  const d = classTokensInSource(donate, "page.tsx");
  const t = classTokensInSource(toast, "toast.tsx");
  if (donate.includes("border-[var(--ds-border-strong)]")) assert.ok(d.has("border-[var(--ds-border-strong)]"));
  const m = toast.match(/bottom-\[calc\([^\s"'`]*\]/);
  if (m) assert.ok(t.has(m[0]), m[0]);
});
