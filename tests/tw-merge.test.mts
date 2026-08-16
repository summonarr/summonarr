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

test("inset-shadow-* and inset-ring-* are box shadows, not positional inset (regression: the inset group swallowed them)", () => {
  // Both are real Tailwind v4 utilities, and the positional regex only excludes
  // x-/y-, so `inset-shadow-sm` matched /^-?inset-(?!x-|y-)/ and a plain
  // `inset-4` silently deleted it (or was deleted by it).
  assert.equal(twMerge("inset-4 inset-shadow-sm"), "inset-4 inset-shadow-sm");
  assert.equal(twMerge("inset-0 inset-ring-2"), "inset-0 inset-ring-2");
  assert.equal(twMerge("inset-shadow-sm inset-ring-2"), "inset-shadow-sm inset-ring-2");
  // Each carries the same size/width-vs-color split as shadow and ring.
  assert.equal(twMerge("inset-shadow-sm inset-shadow-red-500"), "inset-shadow-sm inset-shadow-red-500");
  assert.equal(twMerge("inset-ring-2 inset-ring-red-500"), "inset-ring-2 inset-ring-red-500");
  // …and still collapses within itself.
  assert.equal(twMerge("inset-shadow-sm inset-shadow-lg"), "inset-shadow-lg");
  assert.equal(twMerge("inset-shadow-red-500 inset-shadow-blue-500"), "inset-shadow-blue-500");
  assert.equal(twMerge("inset-ring inset-ring-4"), "inset-ring-4");
  // The positional groups are untouched.
  assert.equal(twMerge("inset-0 inset-4"), "inset-4");
  assert.equal(twMerge("inset-x-2 inset-shadow-sm"), "inset-x-2 inset-shadow-sm");
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

test("col-span/col-start/col-end are three CSS properties, not one group (regression: they shared a group)", () => {
  // /^col-(?:span|start|end)-/ folded grid-column, grid-column-start and
  // grid-column-end into one class space, so a start/end pair annihilated
  // itself. This shipped: ui/card.tsx's CardAction base drops row-span-2.
  assert.equal(twMerge("col-start-2 col-end-4"), "col-start-2 col-end-4");
  assert.equal(twMerge("row-start-2 row-end-4"), "row-start-2 row-end-4");
  assert.equal(twMerge("col-span-2 col-start-1"), "col-span-2 col-start-1");
  assert.equal(
    twMerge("col-start-2 row-span-2 row-start-1 self-start justify-self-end"),
    "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
  );
  // Each still collapses within itself…
  assert.equal(twMerge("col-span-2 col-span-4"), "col-span-4");
  assert.equal(twMerge("col-start-1 col-start-3"), "col-start-3");
  assert.equal(twMerge("row-end-2 row-end-5"), "row-end-5");
  // …and the col-* / row-* axes stay independent of each other.
  assert.equal(twMerge("col-span-2 row-span-2"), "col-span-2 row-span-2");
  assert.equal(twMerge("col-start-1 row-start-1"), "col-start-1 row-start-1");
});

test("justify-content, justify-items and justify-self are three properties, not one group (regression: one /^justify-/ group)", () => {
  // The parallel place-content/place-items/place-self trio was already split;
  // justify-* was not, so a component's justify-self was deleted by any
  // justify-content a caller passed in, and vice versa.
  assert.equal(twMerge("justify-center justify-self-end"), "justify-center justify-self-end");
  assert.equal(twMerge("justify-self-end justify-center"), "justify-self-end justify-center");
  assert.equal(twMerge("justify-between justify-items-center"), "justify-between justify-items-center");
  assert.equal(twMerge("justify-items-center justify-self-start"), "justify-items-center justify-self-start");
  assert.equal(
    twMerge("justify-start justify-items-end justify-self-auto"),
    "justify-start justify-items-end justify-self-auto",
  );
  // Each still collapses within itself.
  assert.equal(twMerge("justify-start justify-center"), "justify-center");
  assert.equal(twMerge("justify-items-start justify-items-center"), "justify-items-center");
  assert.equal(twMerge("justify-self-start justify-self-center"), "justify-self-center");
  // v4's -safe alignments land in the same three groups, not a fourth.
  assert.equal(twMerge("justify-center justify-end-safe"), "justify-end-safe");
  assert.equal(twMerge("justify-self-center justify-self-end-safe"), "justify-self-end-safe");
  assert.equal(twMerge("justify-end-safe justify-self-end-safe"), "justify-end-safe justify-self-end-safe");
  // The align-* shorthands sit on their own prefixes and stay unaffected.
  assert.equal(twMerge("justify-self-end self-start"), "justify-self-end self-start");
  assert.equal(twMerge("justify-items-center items-center"), "justify-items-center items-center");
  // place-* already modelled this split; it must not regress.
  assert.equal(twMerge("place-content-center place-self-end"), "place-content-center place-self-end");
  assert.equal(twMerge("place-items-center place-self-end"), "place-items-center place-self-end");
});

test("align-content and the CSS `content` property are separate groups (regression: one /^content-/ group)", () => {
  // `content-none` and `content-[…]` set the CSS `content` property (pseudo-
  // element text); `content-center` and friends set align-content. One group
  // meant either could silently delete the other.
  assert.equal(twMerge("content-center content-['x']"), "content-center content-['x']");
  assert.equal(twMerge("content-between content-none"), "content-between content-none");
  assert.equal(twMerge("content-none content-stretch"), "content-none content-stretch");
  // Each still collapses within itself.
  assert.equal(twMerge("content-center content-between"), "content-between");
  assert.equal(twMerge("content-normal content-stretch"), "content-stretch");
  assert.equal(twMerge("content-none content-['x']"), "content-['x']");
});

test("shadow-xs and shadow-2xs are sizes, not colors (regression: the color lookahead omitted them)", () => {
  // Both exist in the Tailwind v4 shadow scale but were missing from the
  // shadow-color negative lookahead, so they landed in the color group and a
  // color class deleted the size.
  assert.equal(twMerge("shadow-xs shadow-red-500"), "shadow-xs shadow-red-500");
  assert.equal(twMerge("shadow-2xs shadow-red-500"), "shadow-2xs shadow-red-500");
  // They collapse against the rest of the size scale, not alongside it.
  assert.equal(twMerge("shadow-xs shadow-sm"), "shadow-sm");
  assert.equal(twMerge("shadow-2xs shadow-xs"), "shadow-xs");
  assert.equal(twMerge("shadow-lg shadow-2xs"), "shadow-2xs");
  // The neighbouring 2xl entry in the same lookahead must not regress.
  assert.equal(twMerge("shadow-xs shadow-2xl"), "shadow-2xl");
  assert.equal(twMerge("shadow-2xl shadow-red-500"), "shadow-2xl shadow-red-500");
});

test("decoration thickness and decoration color are separate groups (regression: one group)", () => {
  // text-decoration-thickness vs text-decoration-color — the same size-vs-color
  // overload border, shadow and text-shadow already model.
  assert.equal(twMerge("decoration-2 decoration-red-500"), "decoration-2 decoration-red-500");
  assert.equal(twMerge("decoration-red-500 decoration-2"), "decoration-red-500 decoration-2");
  assert.equal(twMerge("decoration-auto decoration-zinc-400"), "decoration-auto decoration-zinc-400");
  assert.equal(twMerge("decoration-from-font decoration-red-500"), "decoration-from-font decoration-red-500");
  // Each still collapses within itself.
  assert.equal(twMerge("decoration-2 decoration-4"), "decoration-4");
  assert.equal(twMerge("decoration-from-font decoration-2"), "decoration-2");
  assert.equal(twMerge("decoration-red-500 decoration-blue-500"), "decoration-blue-500");
  // Style remains its own group, unchanged.
  assert.equal(twMerge("decoration-wavy decoration-2"), "decoration-wavy decoration-2");
  assert.equal(twMerge("decoration-wavy decoration-dotted"), "decoration-dotted");
});

test("v4 gradient utilities are background images, not colors (regression: only the legacy `gradient-` spelling was recognised)", () => {
  // Tailwind v4 renamed bg-gradient-* to bg-linear-*, and added bg-radial /
  // bg-conic. Unrecognised, they fell into the /^bg-/ color catch-all.
  assert.equal(twMerge("bg-linear-to-r bg-red-500"), "bg-linear-to-r bg-red-500");
  assert.equal(twMerge("bg-radial bg-red-500"), "bg-radial bg-red-500");
  assert.equal(twMerge("bg-conic-180 bg-red-500"), "bg-conic-180 bg-red-500");
  assert.equal(twMerge("bg-red-500 bg-linear-45"), "bg-red-500 bg-linear-45");
  // New and legacy spellings share one group, so they collapse together.
  assert.equal(twMerge("bg-gradient-to-r bg-linear-to-l"), "bg-linear-to-l");
  assert.equal(twMerge("bg-linear-to-r bg-radial"), "bg-radial");
  assert.equal(twMerge("bg-none bg-conic"), "bg-conic");
  // Colors still collapse among themselves.
  assert.equal(twMerge("bg-red-500 bg-blue-500"), "bg-blue-500");
});

test("divide-* utilities merge (regression: no group at all, so every divide class keyed by itself)", () => {
  assert.equal(twMerge("divide-x-2 divide-x-4"), "divide-x-4");
  assert.equal(twMerge("divide-y divide-y-4"), "divide-y-4");
  assert.equal(twMerge("divide-zinc-800 divide-red-500"), "divide-red-500");
  assert.equal(twMerge("divide-solid divide-dashed"), "divide-dashed");
  // Width and color live on DIFFERENT prefixes here (divide-x/divide-y vs bare
  // divide), so unlike border there are no per-axis color utilities to model.
  assert.equal(twMerge("divide-x divide-zinc-800"), "divide-x divide-zinc-800");
  assert.equal(twMerge("divide-x-2 divide-y-2"), "divide-x-2 divide-y-2");
  assert.equal(
    twMerge("divide-x-2 divide-dashed divide-red-500"),
    "divide-x-2 divide-dashed divide-red-500",
  );
  // The -reverse flags are their own utilities, not widths and not colors.
  assert.equal(twMerge("divide-x-2 divide-x-reverse"), "divide-x-2 divide-x-reverse");
  assert.equal(twMerge("divide-x-reverse divide-y-reverse"), "divide-x-reverse divide-y-reverse");
  assert.equal(twMerge("divide-x-reverse divide-red-500"), "divide-x-reverse divide-red-500");
});

test("ring width, ring-inset and ring color are three groups (regression: ring-inset sat in ring-w, bare ring matched nothing)", () => {
  // ring-inset toggles the inset flag; it is not a width, so /^ring-(?:\d|inset|\[)/
  // wrongly collapsed the pair. Bare `ring` matched no group at all and only
  // merged with ring colors by accident — the unknown-class fallback returns the
  // base string "ring", which happened to equal the catch-all group's NAME.
  // It is a width (1px in v4), so it now joins ring-w explicitly and the
  // catch-all is renamed ring-color; neither depends on that coincidence.
  assert.equal(twMerge("ring-inset ring-4"), "ring-inset ring-4");
  assert.equal(twMerge("ring-4 ring-inset"), "ring-4 ring-inset");
  assert.equal(twMerge("ring ring-red-500"), "ring ring-red-500");
  assert.equal(twMerge("ring-inset ring-red-500"), "ring-inset ring-red-500");
  // Widths collapse, including the bare form (this now matches real
  // tailwind-merge; it used to be pinned as a divergence).
  assert.equal(twMerge("ring ring-2"), "ring-2");
  assert.equal(twMerge("ring-2 ring"), "ring");
  assert.equal(twMerge("ring-2 ring-4"), "ring-4");
  assert.equal(twMerge("ring-2 ring-red-500"), "ring-2 ring-red-500");
  // ring-offset keeps its own width/color split and never matches ring-w.
  assert.equal(twMerge("ring-2 ring-offset-2"), "ring-2 ring-offset-2");
  assert.equal(twMerge("ring-offset-2 ring-offset-red-500"), "ring-offset-2 ring-offset-red-500");
  assert.equal(twMerge("ring-offset-2 ring-offset-4"), "ring-offset-4");
});

test("logical corner radii are their own corners, not the all-corners group (regression: /^rounded-/ swallowed them)", () => {
  // The physical corners were modelled; the logical ones (s/e/ss/se/es/ee) were
  // not, so any two of them annihilated each other.
  assert.equal(twMerge("rounded-s-lg rounded-e-lg"), "rounded-s-lg rounded-e-lg");
  assert.equal(twMerge("rounded-ss-lg rounded-se-lg"), "rounded-ss-lg rounded-se-lg");
  assert.equal(twMerge("rounded-es-lg rounded-ee-lg"), "rounded-es-lg rounded-ee-lg");
  // Each still collapses within itself.
  assert.equal(twMerge("rounded-s-md rounded-s-lg"), "rounded-s-lg");
  assert.equal(twMerge("rounded-ee-md rounded-ee-lg"), "rounded-ee-lg");
  // A single-letter side must not swallow the two-letter corner that extends
  // it — the same (?:-|$) guard that keeps border-b out of border-bs.
  assert.equal(twMerge("rounded-s-lg rounded-ss-md"), "rounded-s-lg rounded-ss-md");
  assert.equal(twMerge("rounded-e-lg rounded-ee-md"), "rounded-e-lg rounded-ee-md");
  // …and `rounded-sm` is a SIZE, not a logical side, so it stays all-corners.
  assert.equal(twMerge("rounded-sm rounded-lg"), "rounded-lg");
  assert.equal(twMerge("rounded-s-lg rounded-sm"), "rounded-s-lg rounded-sm");
  // Physical corners are untouched.
  assert.equal(twMerge("rounded-t-md rounded-b-lg"), "rounded-t-md rounded-b-lg");
});

test("logical inset sides are not the all-sides inset shorthand (regression: the positional catch-all swallowed them)", () => {
  assert.equal(twMerge("inset-s-0 inset-e-0"), "inset-s-0 inset-e-0");
  assert.equal(twMerge("inset-bs-0 inset-be-0"), "inset-bs-0 inset-be-0");
  assert.equal(twMerge("inset-4 inset-s-2"), "inset-4 inset-s-2");
  // Each collapses within itself, negatives included.
  assert.equal(twMerge("inset-s-2 inset-s-4"), "inset-s-4");
  assert.equal(twMerge("inset-s-2 -inset-s-4"), "-inset-s-4");
  assert.equal(twMerge("-inset-be-2 inset-be-4"), "inset-be-4");
  // The single-letter sides must not swallow the two-letter block sides.
  assert.equal(twMerge("inset-s-2 inset-bs-4"), "inset-s-2 inset-bs-4");
  // …nor collide with the box-shadow utilities parked on the same prefix.
  assert.equal(twMerge("inset-s-2 inset-shadow-sm"), "inset-s-2 inset-shadow-sm");
  assert.equal(twMerge("inset-e-2 inset-ring-2"), "inset-e-2 inset-ring-2");
  // x/y stay independent.
  assert.equal(twMerge("inset-x-2 inset-s-4"), "inset-x-2 inset-s-4");
});

test("3D transform axes are separate from the 2D shorthands (regression: rotate-x/y/z, scale-z and translate-z fell into them)", () => {
  assert.equal(twMerge("rotate-x-45 rotate-y-45"), "rotate-x-45 rotate-y-45");
  assert.equal(twMerge("rotate-45 rotate-x-45"), "rotate-45 rotate-x-45");
  assert.equal(twMerge("rotate-z-45 rotate-y-90"), "rotate-z-45 rotate-y-90");
  assert.equal(twMerge("scale-50 scale-z-75"), "scale-50 scale-z-75");
  assert.equal(twMerge("translate-4 translate-z-8"), "translate-4 translate-z-8");
  // Each collapses within itself, negatives included.
  assert.equal(twMerge("rotate-x-45 -rotate-x-90"), "-rotate-x-90");
  assert.equal(twMerge("scale-z-75 scale-z-100"), "scale-z-100");
  assert.equal(twMerge("-translate-z-4 translate-z-8"), "translate-z-8");
  // The 2D axis groups that already existed are unaffected.
  assert.equal(twMerge("scale-x-50 scale-y-75"), "scale-x-50 scale-y-75");
  assert.equal(twMerge("skew-x-3 skew-y-6"), "skew-x-3 skew-y-6");
  assert.equal(twMerge("rotate-45 rotate-90"), "rotate-90");
});

test("bg-blend-* and the v4 background positions are not background colors (regression: the /^bg-/ catch-all)", () => {
  // This shipped: ui/avatar.tsx's AvatarBadge base is
  // "… bg-primary text-primary-foreground bg-blend-color …", so the badge
  // merged down without its background colour entirely.
  assert.equal(twMerge("bg-primary bg-blend-color"), "bg-primary bg-blend-color");
  assert.equal(twMerge("bg-blend-multiply bg-red-500"), "bg-blend-multiply bg-red-500");
  assert.equal(twMerge("bg-blend-multiply bg-blend-screen"), "bg-blend-screen");
  // v4 renamed bg-left-top to bg-top-left; only the legacy spelling was listed.
  assert.equal(twMerge("bg-top-left bg-red-500"), "bg-top-left bg-red-500");
  assert.equal(twMerge("bg-bottom-right bg-red-500"), "bg-bottom-right bg-red-500");
  // Both spellings share the one position group.
  assert.equal(twMerge("bg-center bg-top-left"), "bg-top-left");
  assert.equal(twMerge("bg-left-top bg-bottom-right"), "bg-bottom-right");
  // Colours still collapse among themselves.
  assert.equal(twMerge("bg-red-500 bg-blue-500"), "bg-blue-500");
});

test("transition-behavior is not the transition shorthand (regression: /^transition(?:-|$)/ swallowed it)", () => {
  assert.equal(twMerge("transition-all transition-discrete"), "transition-all transition-discrete");
  assert.equal(twMerge("transition-discrete transition-colors"), "transition-discrete transition-colors");
  assert.equal(twMerge("transition-none transition-discrete"), "transition-none transition-discrete");
  // Each collapses within itself.
  assert.equal(twMerge("transition-discrete transition-normal"), "transition-normal");
  assert.equal(twMerge("transition transition-all"), "transition-all");
});

test("space-*-reverse is a flag, not a margin (regression: it sat in the space-x/space-y groups)", () => {
  assert.equal(twMerge("space-x-4 space-x-reverse"), "space-x-4 space-x-reverse");
  assert.equal(twMerge("space-y-4 space-y-reverse"), "space-y-4 space-y-reverse");
  assert.equal(twMerge("space-x-reverse space-y-reverse"), "space-x-reverse space-y-reverse");
  assert.equal(twMerge("space-x-2 space-x-4"), "space-x-4");
  // Matches the divide-*-reverse split already in the table.
  assert.equal(twMerge("divide-x-2 divide-x-reverse"), "divide-x-2 divide-x-reverse");
});

test("font-stretch is not font-family (regression: the /^font-/ catch-all)", () => {
  assert.equal(twMerge("font-mono font-stretch-75%"), "font-mono font-stretch-75%");
  assert.equal(twMerge("font-stretch-condensed font-sans"), "font-stretch-condensed font-sans");
  assert.equal(twMerge("font-stretch-50% font-stretch-100%"), "font-stretch-100%");
  assert.equal(twMerge("font-mono font-serif"), "font-serif");
  // Weight keeps its own group.
  assert.equal(twMerge("font-bold font-stretch-75%"), "font-bold font-stretch-75%");
});

test("the -safe alignment variants land in their alignment group (regression: content-*-safe fell into the CSS content group)", () => {
  assert.equal(twMerge("content-center-safe content-['x']"), "content-center-safe content-['x']");
  assert.equal(twMerge("content-none content-center-safe"), "content-none content-center-safe");
  assert.equal(twMerge("content-center content-end-safe"), "content-end-safe");
  // Every other alignment prefix already had this right — its catch-all IS the
  // same property — so they must not regress.
  assert.equal(twMerge("justify-start justify-center-safe"), "justify-center-safe");
  assert.equal(twMerge("items-start items-center-safe"), "items-center-safe");
  assert.equal(twMerge("self-start self-end-safe"), "self-end-safe");
  assert.equal(twMerge("justify-self-start justify-self-end-safe"), "justify-self-end-safe");
  assert.equal(twMerge("justify-items-start justify-items-center-safe"), "justify-items-center-safe");
  assert.equal(twMerge("place-content-start place-content-center-safe"), "place-content-center-safe");
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

test("PIN: the grid shorthand does not evict a preceding col-start/col-end", () => {
  // Real tailwind-merge models one-directional CONFLICTS between groups:
  // col-span-* sets the grid-column shorthand, so it overrides an earlier
  // col-start-*/col-end-*. This merger has no cross-group conflict mechanism —
  // groups only ever collapse within themselves — so both survive. The failure
  // mode is conservative (a redundant class, never a dropped one), which is why
  // splitting the three properties apart is still the right trade.
  assert.equal(twMerge("col-start-1 col-span-2"), "col-start-1 col-span-2");
  assert.equal(twMerge("row-end-3 row-span-2"), "row-end-3 row-span-2");
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
