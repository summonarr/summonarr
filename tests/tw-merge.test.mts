// Unit tests for the hand-written tailwind-merge equivalent (src/lib/tw-merge.ts —
// the npm package is NOT installed). The contract: utilities in the same group
// collapse to the LAST write, while variant prefixes (hover:, dark:, …) and the
// trailing-! important flag each form independent class spaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { twMerge } from "../src/lib/tw-merge.ts";

test("same-group utilities collapse to the last write", () => {
  assert.equal(twMerge("p-2 p-4"), "p-4");
  assert.equal(twMerge("text-red-500 text-blue-500"), "text-blue-500");
  assert.equal(twMerge("flex hidden"), "hidden"); // display group
  assert.equal(twMerge("rounded-md rounded-lg"), "rounded-lg");
  assert.equal(twMerge("w-4 w-8 w-16"), "w-16");
});

test("different groups do not clobber each other", () => {
  assert.equal(twMerge("px-2 py-3"), "px-2 py-3");
  assert.equal(twMerge("flex flex-col"), "flex flex-col"); // display vs flex-dir
  assert.equal(twMerge("text-sm text-red-500"), "text-sm text-red-500"); // size vs color
  assert.equal(twMerge("rounded-t-md rounded-b-lg"), "rounded-t-md rounded-b-lg");
});

test("text-size vs text-color split — sizes collapse, colors collapse, not across", () => {
  assert.equal(twMerge("text-sm text-lg"), "text-lg");
  assert.equal(twMerge("text-lg text-red-500 text-xl"), "text-red-500 text-xl");
});

test("variant prefixes form independent class spaces", () => {
  assert.equal(twMerge("p-2 hover:p-4"), "p-2 hover:p-4");
  assert.equal(twMerge("hover:p-2 hover:p-4"), "hover:p-4");
  assert.equal(twMerge("dark:hover:p-2 dark:hover:p-4"), "dark:hover:p-4");
  assert.equal(twMerge("sm:w-4 md:w-4"), "sm:w-4 md:w-4");
});

test("arbitrary/bracket variants merge within the same prefix", () => {
  assert.equal(twMerge("[&>svg]:p-2 [&>svg]:p-4"), "[&>svg]:p-4");
  assert.equal(twMerge("data-[state=open]:flex data-[state=open]:hidden"), "data-[state=open]:hidden");
});

test("trailing-! important flag is its own class space", () => {
  assert.equal(twMerge("p-2! p-4"), "p-2! p-4");
  assert.equal(twMerge("p-2! p-4!"), "p-4!");
});

test("border width and border color are separate groups", () => {
  assert.equal(twMerge("border border-2"), "border-2");
  assert.equal(twMerge("border-2 border-red-500"), "border-2 border-red-500");
});

test("bare side borders are widths, not colors (regression: they fell into the border-color catch-all)", () => {
  // `border-t` matched neither the width group (which wanted `border-t-` plus a
  // digit) nor the side color group (which wanted a trailing dash), so it fell
  // through to /^border-/ and a color class silently deleted it. This shipped:
  // ui/drawer.tsx's DrawerPopup base is "… border-t border-zinc-800 …", so the
  // primitive rendered no top border at all. Each side now carries the bare `$`
  // alternative, exactly as all-sides `border-w` and `rounded-*` already did.
  assert.equal(twMerge("border-t border-zinc-800"), "border-t border-zinc-800");
  assert.equal(twMerge("border-zinc-800 border-t"), "border-zinc-800 border-t");
  assert.equal(twMerge("border-b border-x border-red-500"), "border-b border-x border-red-500");
  // Widths still collapse within one side, and sides stay independent of each other.
  assert.equal(twMerge("border-t border-t-4"), "border-t-4");
  assert.equal(twMerge("border-t border-b"), "border-t border-b");
  assert.equal(twMerge("border-t-2 border-t-red-500"), "border-t-2 border-t-red-500");
});

test("logical border sides are distinct utilities from the physical ones", () => {
  // `border-b` must not swallow `border-bs`: the width regexes require -digit,
  // -[ or end-of-string after the side, so the extra letter cannot match.
  assert.equal(twMerge("border-b border-bs"), "border-b border-bs");
  assert.equal(twMerge("border-e border-b"), "border-e border-b");
  assert.equal(twMerge("border-bs border-be"), "border-bs border-be");
  assert.equal(twMerge("border-s border-s-2"), "border-s-2");
  assert.equal(twMerge("border-s border-s-red-500"), "border-s border-s-red-500");
  // …and `border-s` must not capture the border words that merely start with s.
  assert.equal(twMerge("border-s border-solid"), "border-s border-solid");
  assert.equal(twMerge("border-s border-separate"), "border-s border-separate");
  assert.equal(twMerge("border-s border-spacing-2"), "border-s border-spacing-2");
});

test("table border utilities are not border colors", () => {
  assert.equal(twMerge("border-collapse border-red-500"), "border-collapse border-red-500");
  assert.equal(twMerge("border-collapse border-separate"), "border-separate");
  assert.equal(twMerge("border-spacing-2 border-zinc-800"), "border-spacing-2 border-zinc-800");
  assert.equal(twMerge("border-spacing-x-2 border-spacing-y-4"), "border-spacing-x-2 border-spacing-y-4");
  assert.equal(twMerge("border-spacing-2 border-spacing-4"), "border-spacing-4");
});

test("text-overflow and text-wrap are their own groups, not text colors", () => {
  // Same catch-all bug as bare side borders, on /^text-/: these set
  // text-overflow and text-wrap, so a color class silently deleted them.
  assert.equal(twMerge("text-ellipsis text-zinc-400"), "text-ellipsis text-zinc-400");
  assert.equal(twMerge("text-zinc-400 text-ellipsis"), "text-zinc-400 text-ellipsis");
  assert.equal(twMerge("truncate text-ellipsis text-sm text-zinc-400"), "truncate text-ellipsis text-sm text-zinc-400");
  // They remain SEPARATE groups from each other — different CSS properties, so
  // folding them together would invent a collision that never existed.
  assert.equal(twMerge("text-ellipsis text-balance"), "text-ellipsis text-balance");
  // Each still collapses within itself.
  assert.equal(twMerge("text-ellipsis text-clip"), "text-clip");
  assert.equal(twMerge("text-wrap text-nowrap"), "text-nowrap");
  // Unaffected neighbours: size, alignment and the whitespace group.
  assert.equal(twMerge("text-nowrap text-sm"), "text-nowrap text-sm");
  assert.equal(twMerge("text-wrap text-left"), "text-wrap text-left");
  assert.equal(twMerge("whitespace-nowrap text-nowrap"), "whitespace-nowrap text-nowrap");
});

test("text-indent and text-shadow are not text colors", () => {
  assert.equal(twMerge("text-indent-4 text-zinc-400"), "text-indent-4 text-zinc-400");
  assert.equal(twMerge("text-indent-2 text-indent-8"), "text-indent-8");
  // text-shadow carries the same size-vs-color overload border already models.
  assert.equal(twMerge("text-shadow-sm text-red-500"), "text-shadow-sm text-red-500");
  assert.equal(twMerge("text-shadow-sm text-shadow-red-500"), "text-shadow-sm text-shadow-red-500");
  assert.equal(twMerge("text-shadow-sm text-shadow-lg"), "text-shadow-lg");
  assert.equal(twMerge("text-shadow-none text-shadow-md"), "text-shadow-md");
});

test("unknown classes key by themselves — deduped, never cross-merged", () => {
  assert.equal(twMerge("foo foo"), "foo");
  assert.equal(twMerge("foo bar"), "foo bar");
});

test("empty and whitespace-heavy input", () => {
  assert.equal(twMerge(""), "");
  assert.equal(twMerge("   "), "");
  assert.equal(twMerge("  p-2   p-4  "), "p-4");
});

test("negative-value utilities merge with their positive counterparts", () => {
  // Every `-?`-prefixed group regex must treat -x-2 and x-2 as the same group;
  // dropping a `-?` from a regex would silently split them into two spaces.
  assert.equal(twMerge("-mt-2 mt-4"), "mt-4");
  assert.equal(twMerge("mt-4 -mt-2"), "-mt-2");
  assert.equal(twMerge("-mx-2 mx-4"), "mx-4");
  assert.equal(twMerge("m-2 -m-4"), "-m-4");
  assert.equal(twMerge("-translate-x-2 translate-x-4"), "translate-x-4");
  assert.equal(twMerge("-top-2 top-4"), "top-4");
  assert.equal(twMerge("-inset-2 inset-4"), "inset-4");
  assert.equal(twMerge("-z-10 z-50"), "z-50");
  assert.equal(twMerge("order-1 -order-2"), "-order-2");
  assert.equal(twMerge("tracking-tight -tracking-wide"), "-tracking-wide");
  assert.equal(twMerge("-space-x-2 space-x-4"), "space-x-4");
  assert.equal(twMerge("space-y-2 -space-y-4"), "-space-y-4");
  assert.equal(twMerge("scale-95 -scale-100"), "-scale-100");
  assert.equal(twMerge("-rotate-45 rotate-90"), "rotate-90");
  assert.equal(twMerge("-skew-x-3 skew-x-6"), "skew-x-6");
  assert.equal(twMerge("skew-y-3 -skew-y-6"), "-skew-y-6");
  // Distinct sides stay independent even when some are negative.
  assert.equal(twMerge("top-2 -bottom-2 -left-1 left-3"), "top-2 -bottom-2 left-3");
});

test("inset negative lookahead keeps inset-x/inset-y out of the inset group", () => {
  // The inset regex is /^-?inset-(?!x-|y-)/ — without the lookahead,
  // inset-x-2 would wrongly collapse into a preceding inset-0.
  assert.equal(twMerge("inset-0 inset-x-2"), "inset-0 inset-x-2");
  assert.equal(twMerge("inset-0 inset-y-2"), "inset-0 inset-y-2");
  assert.equal(twMerge("inset-x-2 inset-x-4"), "inset-x-4");
});

test("group-* and peer-* variant prefixes form independent class spaces", () => {
  // VARIANT_RE has dedicated alternatives for group-*/peer-* and their
  // named-group (/name) forms — advertised in the module header comment.
  assert.equal(twMerge("group-hover:flex group-hover:hidden"), "group-hover:hidden");
  assert.equal(twMerge("group-hover/foo:p-2 group-hover/foo:p-4"), "group-hover/foo:p-4");
  // Different group names are different spaces.
  assert.equal(
    twMerge("group-hover/foo:p-2 group-hover/bar:p-4"),
    "group-hover/foo:p-2 group-hover/bar:p-4",
  );
  assert.equal(twMerge("peer-checked:p-2 peer-checked:p-4"), "peer-checked:p-4");
  assert.equal(twMerge("peer-focus/name:mt-2 peer-focus/name:mt-4"), "peer-focus/name:mt-4");
});

// ---------------------------------------------------------------------------
// Pinning tests: documented divergences from the real `tailwind-merge` package.
// These assert CURRENT behavior so a regression (or a well-meaning "fix" that
// silently changes merge semantics for existing callsites) is caught. If you
// intentionally change one of these, update the test AND audit src/ usages.
// ---------------------------------------------------------------------------

test("shadow size and shadow color are separate groups (regression: color entry was unreachable)", () => {
  // groupOf() returns the FIRST matching group, so shadow-color's negative-
  // lookahead entry must precede the catch-all shadow entry — the same ordering
  // rule as border-w before border-color. It used to be listed after, which
  // made it unreachable: sizes and colors collapsed into one group and
  // `shadow-md shadow-red-500` dropped the size. Now matches real
  // tailwind-merge: sizes and colors merge independently.
  assert.equal(twMerge("shadow-md shadow-red-500"), "shadow-md shadow-red-500");
  assert.equal(twMerge("shadow-red-500 shadow-md"), "shadow-red-500 shadow-md");
  // Same-group collapse still applies within each side…
  assert.equal(twMerge("shadow-md shadow-lg"), "shadow-lg");
  assert.equal(twMerge("shadow-red-500 shadow-blue-500"), "shadow-blue-500");
  // …and bare `shadow` plus the named sizes stay in the size group.
  assert.equal(twMerge("shadow shadow-md"), "shadow-md");
  assert.equal(twMerge("shadow-inner shadow-red-500"), "shadow-inner shadow-red-500");
});

test("PIN: bare 'ring' is not in the ring-w group", () => {
  // /^ring-(?:\d|inset|\[)/ requires a dash, so bare `ring` keys by itself
  // (unknown-class fallback) and survives next to ring-2. Real tailwind-merge
  // collapses `ring ring-2` to `ring-2`.
  assert.equal(twMerge("ring ring-2"), "ring ring-2");
  // Within the group, widths still collapse and colors stay separate.
  assert.equal(twMerge("ring-2 ring-4"), "ring-4");
  assert.equal(twMerge("ring-2 ring-red-500"), "ring-2 ring-red-500");
});

test("PIN: arbitrary text values always classify as text-size", () => {
  // text-[...] matches the text-size regex regardless of bracket content, so a
  // color like text-[#ff0000] clobbers (and is clobbered by) text sizes. This
  // is the documented pragmatic trade-off of the hand-written merger.
  assert.equal(twMerge("text-sm text-[#ff0000]"), "text-[#ff0000]");
  assert.equal(twMerge("text-[10px] text-lg"), "text-lg");
});

test("PIN: modifier ORDER forms distinct class spaces", () => {
  // Variants are compared as a raw concatenated string, so hover:dark: and
  // dark:hover: never merge. Real tailwind-merge normalizes modifier order.
  assert.equal(twMerge("hover:dark:p-2 dark:hover:p-4"), "hover:dark:p-2 dark:hover:p-4");
});
