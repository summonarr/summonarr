// Unit tests for the hand-written class-variance-authority equivalent
// (src/lib/cva.ts — the npm package is NOT installed). Every ui/ primitive
// builds its className through this, so the variant-selection rules
// (defaults, null-suppression, className passthrough) are load-bearing for
// the whole component library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cva } from "../src/lib/cva.ts";

const button = cva("base", {
  variants: {
    size: { sm: "text-sm", lg: "text-lg" },
    tone: { red: "bg-red", blue: "bg-blue" },
  },
  defaultVariants: { size: "sm" },
});

test("no props → base + default variants (variants without defaults are omitted)", () => {
  assert.equal(button(), "base text-sm");
  assert.equal(button({}), "base text-sm");
});

test("explicit variant overrides the default", () => {
  assert.equal(button({ size: "lg" }), "base text-lg");
});

test("null suppresses the default variant entirely", () => {
  assert.equal(button({ size: null }), "base");
});

test("multiple variants compose in config order", () => {
  assert.equal(button({ tone: "red" }), "base text-sm bg-red");
  assert.equal(button({ size: "lg", tone: "blue" }), "base text-lg bg-blue");
});

test("string className is appended last; non-strings are ignored", () => {
  assert.equal(button({ className: "extra" }), "base text-sm extra");
  // base-ui forwards state-aware className *functions* through cn(); cva must
  // silently drop anything that isn't a string rather than stringify it.
  assert.equal(button({ className: () => "nope" }), "base text-sm");
  assert.equal(button({ className: 42 }), "base text-sm");
  assert.equal(button({ className: undefined }), "base text-sm");
});

test("unknown variant value falls through (no class emitted, no throw)", () => {
  const props = { size: "xl" } as unknown as Parameters<typeof button>[0];
  assert.equal(button(props), "base");
});

test("empty base class does not leave a leading space", () => {
  const bare = cva("", { variants: { size: { sm: "text-sm" } } });
  assert.equal(bare(), "");
  assert.equal(bare({ size: "sm" }), "text-sm");
});

test("explicit undefined falls back to the default variant (unlike null)", () => {
  // Distinct from button({}) — the key IS present with an undefined value. A
  // regression to a `'key' in props` presence check or truthiness test would
  // treat this like null-suppression instead of taking the ?? default branch.
  assert.equal(button({ size: undefined }), "base text-sm");
  // undefined on a variant with no default emits nothing (no stray class).
  assert.equal(button({ tone: undefined }), "base text-sm");
});

test("variant value mapped to an empty-string class is dropped cleanly", () => {
  const toggle = cva("base", { variants: { empty: { on: "", off: "hidden" } } });
  // The `if (cls)` guard must skip the empty class without leaving a double
  // or trailing space in the joined output.
  assert.equal(toggle({ empty: "on" }), "base");
  assert.equal(toggle({ empty: "off" }), "base hidden");
});

test("empty-string className does not leave a trailing space", () => {
  // typeof "" === "string" so it IS pushed; filter(Boolean) must drop it
  // before the join or every consumer passing className="" gets "base text-sm ".
  assert.equal(button({ className: "" }), "base text-sm");
});
