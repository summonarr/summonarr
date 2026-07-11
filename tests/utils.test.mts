// Unit tests for cn() (src/lib/utils.ts) — the className funnel every UI
// component routes through. It must (a) match clsx's permissive input surface
// (strings, numbers, nested arrays, truthy-keyed dictionaries), (b) silently
// drop non-class values — base-ui forwards *state-aware className functions*
// through cn(), and stringifying one would inject "function (state) {...}"
// into the DOM class attribute — and (c) tw-merge the result so a later
// same-group Tailwind class wins across arguments (the `cn(base, override)`
// pattern used by every variant component).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cn } from "../src/lib/utils.ts";

// --- clsx surface: strings, numbers, arrays, dictionaries ---

test("strings concatenate in argument order", () => {
  assert.equal(cn("flex", "items-center", "gap-2"), "flex items-center gap-2");
});

test("no arguments and all-falsy arguments produce the empty string", () => {
  assert.equal(cn(), "");
  assert.equal(cn(null, undefined, false, ""), "");
});

test("numbers: non-zero stringified, zero dropped as falsy", () => {
  assert.equal(cn("grid", 42), "grid 42");
  assert.equal(cn(0, "grid"), "grid"); // 0 is falsy → dropped, no leading space
  assert.equal(cn(-1), "-1");
});

test("nested arrays flatten recursively with falsy entries removed", () => {
  assert.equal(cn(["a", ["b", ["c", null], undefined], false, 0]), "a b c");
});

test("dictionary keys survive only for truthy values", () => {
  assert.equal(
    cn({
      keep: true,
      "keep-str": "yes",
      "keep-num": 1,
      "drop-false": false,
      "drop-zero": 0,
      "drop-empty": "",
      "drop-null": null,
      "drop-undef": undefined,
      "drop-nan": NaN,
    }),
    "keep keep-str keep-num",
  );
});

test("dictionaries nested inside arrays are resolved", () => {
  assert.equal(cn(["base", { active: true, disabled: false }], "tail"), "base active tail");
});

test("multi-class strings with irregular whitespace normalize to single spaces", () => {
  assert.equal(cn("flex   items-center", "  gap-2 "), "flex items-center gap-2");
});

// --- silent drops: functions, symbols, booleans ---

test("functions are dropped silently (base-ui state-aware className funcs)", () => {
  const stateAware = (state: { disabled: boolean }) => (state.disabled ? "opacity-50" : "");
  assert.equal(cn("flex", stateAware), "flex");
  // A function must never be stringified into the class attribute.
  assert.equal(cn(stateAware), "");
});

test("symbols and bare booleans are dropped silently", () => {
  assert.equal(cn("flex", Symbol("cls"), true), "flex");
  assert.equal(cn(true), ""); // true is truthy but not a class value
});

// --- tw-merge integration: later same-group class wins ---

test("later same-group class wins across separate arguments", () => {
  assert.equal(cn("px-2", "px-4"), "px-4");
  assert.equal(cn("bg-red-500", "bg-blue-500"), "bg-blue-500");
  assert.equal(cn("text-sm", "text-lg"), "text-lg");
});

test("later same-group class wins within a single string argument", () => {
  assert.equal(cn("p-2 p-4"), "p-4");
});

test("a truthy dictionary override beats an earlier string, a falsy one does not", () => {
  // The `cn(base, { override: cond })` component pattern.
  assert.equal(cn("bg-red-500", { "bg-blue-500": true }), "bg-blue-500");
  assert.equal(cn("bg-red-500", { "bg-blue-500": false }), "bg-red-500");
});

test("different groups never clobber each other (text size vs text color)", () => {
  // text-sm is dropped by text-lg (same size group); text-red-500 is a
  // different group and keeps its original position.
  assert.equal(cn("text-sm text-red-500", "text-lg"), "text-red-500 text-lg");
});

test("variant prefixes form independent class spaces", () => {
  // hover: does not collide with the bare utility…
  assert.equal(cn("px-2", "hover:px-4"), "px-2 hover:px-4");
  // …but the same variant + same group collapses to the last write.
  assert.equal(cn("hover:px-2", "hover:px-4"), "hover:px-4");
  assert.equal(cn("dark:bg-zinc-900 bg-white", "dark:bg-black"), "bg-white dark:bg-black");
});

test("exact duplicates collapse to one occurrence, including unknown classes", () => {
  assert.equal(cn("flex", "flex"), "flex");
  // Unknown (non-Tailwind) classes group as themselves: duplicates dedupe,
  // distinct customs coexist.
  assert.equal(cn("custom-a custom-a custom-b"), "custom-a custom-b");
});

test("important-suffixed utilities occupy a separate space from plain ones", () => {
  // Pins current tw-merge behavior: `px-2!` and `px-4` do not collide…
  assert.equal(cn("px-2!", "px-4"), "px-2! px-4");
  // …while two important same-group utilities collapse to the last.
  assert.equal(cn("px-2!", "px-4!"), "px-4!");
});
