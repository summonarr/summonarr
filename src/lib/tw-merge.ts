// Pragmatic Tailwind-class merger. Replaces `tailwind-merge` for the cases this
// codebase actually exercises: same-group utilities collapse to the last write,
// variant prefixes (hover:, dark:, sm:, focus-visible:, group/foo:, …) form
// independent class spaces.

// ── Arbitrary-value shapes ─────────────────────────────────────────────────
// Tailwind decides what `border-[…]` / `shadow-(--x)` IS from the value text —
// a length is a width, a colour literal a colour, a bare var() whatever that
// family defaults to — and this table has to guess the same way, or one class
// silently deletes another. These fragments are the ONE definition of each
// shape. `npm run audit:tw-merge` compiles a matrix of arbitrary values through
// Tailwind itself and fails on any value a group files differently (check 4,
// MISFILED), so a wrong guess here is a CI failure, not a silent bug.
//
// One CSS length WITH a unit. No `%`: Tailwind types `border-[50%]` as a colour
// (text sizes accept `%` separately below).
const LEN = String.raw`-?\d*\.?\d+(?:px|r?em|r?lh|ch|ex|cap|ic|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|pt|pc|in|cm|mm|q)`;
// A bracket/paren value Tailwind types as a WIDTH or SIZE: a length, a
// length-valued function, or an explicit `length:` hint.
const WIDTH_ARB = String.raw`\[(?:length:|-?(?:calc|clamp|min|max)\(|${LEN}\])|\(length:`;
// A colour literal: hex, a `color:` hint, a colour function, or a bare keyword
// (`red`, `currentColor`, `transparent`) that isn't a CSS-wide, shadow or
// line-width keyword (Tailwind types `shadow-[thin]` as the shadow, not a colour).
const COLOR_LIT = String.raw`(?:#|color:|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|light-dark|color)\(|(?!(?:none|inherit|initial|unset|revert|thin|medium|thick)\])[a-zA-Z]+\])`;
// Shadow families invert the default: a bracket is the COLOUR only as a colour
// literal, a paren only with a `color:` hint. Everything else — a var(), a full
// shadow — is the shadow itself.
const SHADOW_ARB = String.raw`\[(?!${COLOR_LIT})|\((?!color:)`;
const rx = (source: string) => new RegExp(source);

const GROUPS: Array<readonly [string, RegExp]> = [
  ["display", /^(flex|grid|block|inline|inline-flex|inline-grid|inline-block|inline-table|list-item|hidden|contents|flow-root|table|table-(?:row|cell|caption|column|row-group|column-group|header-group|footer-group))$/],
  ["position", /^(static|relative|absolute|fixed|sticky)$/],
  ["visibility", /^(visible|invisible|collapse)$/],
  ["overflow", /^overflow-(?:auto|hidden|clip|visible|scroll)$/],
  ["overscroll", /^overscroll-(?!x-|y-)/],
  ["overscroll-x", /^overscroll-x-/],
  ["overscroll-y", /^overscroll-y-/],
  ["isolation", /^(?:isolate|isolation-auto)$/],
  ["mix-blend", /^mix-blend-/],
  ["overflow-x", /^overflow-x-/],
  ["overflow-y", /^overflow-y-/],
  ["z", /^-?z-/],
  // Box shadows, not positional inset — parked here because the positional
  // regex below only excludes x-/y-, so it would otherwise swallow them
  // (groupOf returns the FIRST match). Both are real Tailwind v4 utilities and
  // carry the same size/width-vs-color split as `shadow` and `ring`.
  ["inset-shadow-size", rx(String.raw`^inset-shadow-(?:(?:2xs|xs|sm|md|lg|xl|2xl|none)$|${SHADOW_ARB})`)],
  ["inset-shadow-color", /^inset-shadow-/],
  ["inset-ring-w", rx(String.raw`^inset-ring(?:-\d|-(?:${WIDTH_ARB})|$)`)],
  ["inset-ring-color", /^inset-ring-/],
  // Logical inset sides, modelled alongside the physical ones exactly as the
  // logical border sides are. The positional catch-all below excludes only
  // x-/y-, so without these `inset-s-0 inset-e-0` annihilated itself. The extra
  // letter keeps them distinct: `inset-s-` cannot match `inset-shadow-`.
  // `start-*`/`end-*` are the same two properties as `inset-s-*`/`inset-e-*`.
  // Their value shape is constrained (as border-w/ring-w constrain theirs)
  // because "start" and "end" are ordinary words: a bare /^end-/ would also
  // capture prose like `end-to-end` if it ever reached a class string.
  ["inset-s", /^-?(?:inset-s-|start-(?:\d|\[|\(|auto$|full$|px$))/],
  ["inset-e", /^-?(?:inset-e-|end-(?:\d|\[|\(|auto$|full$|px$))/],
  ["inset-bs", /^-?inset-bs-/],
  ["inset-be", /^-?inset-be-/],
  ["inset", /^-?inset-(?!x-|y-)/],
  ["inset-x", /^-?inset-x-/],
  ["inset-y", /^-?inset-y-/],
  ["top", /^-?top-/],
  ["right", /^-?right-/],
  ["bottom", /^-?bottom-/],
  ["left", /^-?left-/],

  ["aspect", /^aspect-/],
  ["size", /^size-/],
  ["w", /^w-/],
  ["h", /^h-/],
  ["min-w", /^min-w-/],
  ["min-h", /^min-h-/],
  ["max-w", /^max-w-/],
  ["max-h", /^max-h-/],

  ["pt", /^pt-/],
  ["pr", /^pr-/],
  ["pb", /^pb-/],
  ["pl", /^pl-/],
  ["ps", /^ps-/],
  ["pe", /^pe-/],
  ["px", /^px-/],
  ["py", /^py-/],
  ["p", /^p-/],

  ["mt", /^-?mt-/],
  ["mr", /^-?mr-/],
  ["mb", /^-?mb-/],
  ["ml", /^-?ml-/],
  ["ms", /^-?ms-/],
  ["me", /^-?me-/],
  ["mx", /^-?mx-/],
  ["my", /^-?my-/],
  ["m", /^-?m-/],

  // The -reverse flags set only a custom property, not a margin — same split
  // the divide-*-reverse groups already carry.
  ["space-x-reverse", /^space-x-reverse$/],
  ["space-y-reverse", /^space-y-reverse$/],
  ["space-x", /^-?space-x-/],
  ["space-y", /^-?space-y-/],
  ["gap-x", /^gap-x-/],
  ["gap-y", /^gap-y-/],
  ["gap", /^gap-/],

  ["flex-dir", /^flex-(?:row|row-reverse|col|col-reverse)$/],
  ["flex-wrap", /^flex-(?:wrap|wrap-reverse|nowrap)$/],
  ["flex", /^flex-(?:\d|auto|initial|none|\[)/],
  ["grow", /^grow(?:-|$)/],
  ["shrink", /^shrink(?:-|$)/],
  ["basis", /^basis-/],
  ["order", /^-?order-/],

  // justify-content / justify-items / justify-self are three properties, and
  // the more specific two must precede the catch-all — exactly the split the
  // place-content/place-items/place-self trio below already models.
  ["justify-items", /^justify-items-/],
  ["justify-self", /^justify-self-/],
  ["justify", /^justify-/],
  ["items", /^items-/],
  // align-content values only. Everything else under /^content-/ sets the CSS
  // `content` property (content-none, content-['…']) — a different property, so
  // it stays in the catch-all below and the two never delete each other.
  ["content-align", /^content-(?:normal|center|start|end|between|around|evenly|baseline|stretch)(?:-safe)?$/],
  ["content", /^content-/],
  ["self", /^self-/],
  ["place-items", /^place-items-/],
  ["place-content", /^place-content-/],
  ["place-self", /^place-self-/],

  ["grid-cols", /^grid-cols-/],
  ["grid-rows", /^grid-rows-/],
  ["auto-cols", /^auto-cols-/],
  ["auto-rows", /^auto-rows-/],
  // grid-column, grid-column-start and grid-column-end are three properties; one
  // shared group made a start/end pair annihilate itself. Cross-group conflicts
  // are not modelled (the shorthand does not evict a preceding start/end) —
  // that leaves a redundant class, never a dropped one. See the PIN test.
  ["col-span", /^col-(?:span-|auto$)/],
  ["col-start", /^-?col-start-/],
  ["col-end", /^-?col-end-/],
  ["row-span", /^row-(?:span-|auto$)/],
  ["row-start", /^-?row-start-/],
  ["row-end", /^-?row-end-/],

  ["text-align", /^text-(?:left|center|right|justify|start|end)$/],
  // These set text-overflow / text-wrap / text-shadow, not colour.
  // Without their own groups they fall into the `text-color` catch-all below and
  // one silently deletes the other (`text-ellipsis text-zinc-400` → colour only).
  // text-overflow and text-wrap stay SEPARATE groups: they are different CSS
  // properties, so merging them would invent a new collision.
  ["text-overflow", /^text-(?:ellipsis|clip)$/],
  ["text-wrap", /^text-(?:wrap|nowrap|balance|pretty)$/],
  ["text-shadow-size", rx(String.raw`^text-shadow-(?:(?:2xs|xs|sm|md|lg|xl|none)$|${SHADOW_ARB})`)],
  ["text-shadow-color", /^text-shadow-/],
  // An arbitrary value is a SIZE only when it is length-shaped, exactly as
  // Tailwind infers it: text-[10px], text-[0.8rem], text-[length:…],
  // text-[clamp(…)]. Tailwind compiles a bare text-[var(--x)] (and any colour
  // literal) to color, so filing those as sizes made a colour and a text-xs
  // delete each other inside cn() — the theme sweep's text-[var(--ds-accent-fg)]
  // hit that on accent Buttons that also carry a text size.
  ["text-size", rx(String.raw`^text-(?:(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?:\/[^/\s]+)?$|${WIDTH_ARB}|\[(?:-?\d*\.?\d+%|(?:xx?x?-|x-)?(?:small|large)|medium|larger|smaller)\])`)],
  ["text-color", /^text-/],
  ["placeholder", /^placeholder-/],
  ["accent", /^accent-/],

  ["font-weight", /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/],
  ["font-style", /^(?:italic|not-italic)$/],
  ["font-stretch", /^font-stretch-/],
  ["font", /^font-/],

  // The text-indent property's utility is `indent-*`. This group used to be
  // spelled `text-indent-*`, which is not a Tailwind class at all — so it
  // guarded nothing while the real utility had no group.
  ["indent", /^-?indent-/],
  ["line-clamp", /^line-clamp-/],
  ["align", /^align-/],
  ["font-smoothing", /^(?:antialiased|subpixel-antialiased)$/],
  // font-variant-numeric COMPOSES: each utility sets its own --tw-* var and
  // they apply together, so one group per toggle — never a single fvn group.
  ["fvn-normal", /^normal-nums$/],
  ["fvn-ordinal", /^ordinal$/],
  ["fvn-slashed-zero", /^slashed-zero$/],
  ["fvn-figure", /^(?:lining|oldstyle)-nums$/],
  ["fvn-spacing", /^(?:proportional|tabular)-nums$/],
  ["fvn-fraction", /^(?:diagonal|stacked)-fractions$/],
  // list-style-type / -position / -image share one prefix. `list-item` is a
  // DISPLAY and is claimed by the display group at the top of this table.
  ["list-style", /^list-(?:disc|decimal|none)$/],
  ["list-position", /^list-(?:inside|outside)$/],
  ["list-image", /^list-image-/],
  ["leading", /^leading-/],
  ["tracking", /^-?tracking-/],
  ["whitespace", /^whitespace-/],
  ["break", /^(?:break-words|break-all|break-keep|break-normal)$/],
  ["truncate", /^truncate$/],
  ["uppercase", /^(?:uppercase|lowercase|capitalize|normal-case)$/],

  ["decoration-style", /^decoration-(?:solid|double|dotted|dashed|wavy|none)$/],
  // text-decoration-thickness vs text-decoration-color — the same size-vs-color
  // overload border, shadow and text-shadow already model.
  ["decoration-w", rx(String.raw`^decoration-(?:\d|from-font|auto|${WIDTH_ARB}|\[\d*\.?\d+%\])`)],
  ["decoration", /^decoration-/],
  ["underline", /^(?:underline|overline|line-through|no-underline)$/],
  ["underline-offset", /^-?underline-offset-/],

  ["bg-attachment", /^bg-(?:fixed|local|scroll)$/],
  ["bg-repeat", /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/],
  ["bg-size", rx(String.raw`^bg-(?:(?:auto|cover|contain)$|\[length:|\(length:|\[size:|\(size:)`)],
  ["bg-position", rx(String.raw`^bg-(?:(?:top|right|bottom|left|center|top-left|top-right|bottom-left|bottom-right|right-top|right-bottom|left-top|left-bottom)$|\[(?:position:|-?(?:calc|clamp|min|max)\(|${LEN}\]|-?\d*\.?\d+%\])|\(position:)`)],
  // Tailwind v4 renamed bg-gradient-* to bg-linear-* and added bg-radial /
  // bg-conic; unrecognised, the new spellings fell into the bg colour catch-all.
  // radial/conic need no trailing dash — both are valid bare utilities.
  ["bg-image", /^-?bg-(?:none|gradient-|linear-|radial|conic)/],
  ["bg-blend", /^bg-blend-/],
  // Gradient stops: each of from/via/to carries a colour AND a position.
  ["from-pos", /^from-(?:\d+%|\[)/],
  ["from", /^from-/],
  ["via-pos", /^via-(?:\d+%|\[)/],
  ["via", /^via-/],
  ["to-pos", /^to-(?:\d+%|\[)/],
  ["to", /^to-/],
  ["bg-clip", /^bg-clip-/],
  ["bg-origin", /^bg-origin-/],
  ["bg", /^bg-/],

  ["border-style", /^border-(?:solid|dashed|dotted|double|hidden|none)$/],
  // Table layout and cell spacing are not border colour; without these they fall
  // into the `border-color` catch-all at the end of this block.
  ["border-collapse", /^border-(?:collapse|separate)$/],
  ["border-spacing-x", /^border-spacing-x-/],
  ["border-spacing-y", /^border-spacing-y-/],
  ["border-spacing", /^border-spacing-/],
  // Each side matches its BARE form too (the `$` alternative), exactly as the
  // all-sides `border-w` and the `rounded-*` groups already do. Without it a
  // bare `border-t` matches neither the width group (which wanted `border-t-`
  // plus a digit) nor the side colour group (which wanted a trailing dash), so
  // it fell through to `border-color` and a colour class silently deleted it.
  // Logical sides (s/e/bs/be) are distinct utilities from the physical ones and
  // never collide with them: `border-b` cannot match `border-bs`, and vice versa.
  ["border-w-x", rx(String.raw`^border-x(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-y", rx(String.raw`^border-y(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-t", rx(String.raw`^border-t(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-r", rx(String.raw`^border-r(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-b", rx(String.raw`^border-b(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-l", rx(String.raw`^border-l(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-s", rx(String.raw`^border-s(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-e", rx(String.raw`^border-e(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-bs", rx(String.raw`^border-bs(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w-be", rx(String.raw`^border-be(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-w", rx(String.raw`^border(?:-\d|-(?:${WIDTH_ARB})|-\[(?:\d*\.?\d+|thin|medium|thick)\]|$)`)],
  ["border-color-x", /^border-x-/],
  ["border-color-y", /^border-y-/],
  ["border-color-t", /^border-t-/],
  ["border-color-r", /^border-r-/],
  ["border-color-b", /^border-b-/],
  ["border-color-l", /^border-l-/],
  ["border-color-s", /^border-s-/],
  ["border-color-e", /^border-e-/],
  ["border-color-bs", /^border-bs-/],
  ["border-color-be", /^border-be-/],
  ["border-color", /^border-/],

  // Divider borders had NO group, so every divide-* class keyed by itself and
  // two conflicting ones never collapsed. Width and colour live on different
  // prefixes here (divide-x/divide-y vs bare divide), so unlike border there
  // are no per-axis colour utilities — anything not a width, a reverse flag or
  // a style is a colour. The reverse flags are their own utilities.
  ["divide-style", /^divide-(?:solid|dashed|dotted|double|hidden|none)$/],
  ["divide-x-reverse", /^divide-x-reverse$/],
  ["divide-y-reverse", /^divide-y-reverse$/],
  ["divide-w-x", /^divide-x(?:-\d|-[[(]|$)/], // Tailwind types EVERY divide-x value as the width
  ["divide-w-y", /^divide-y(?:-\d|-[[(]|$)/],
  ["divide-color", /^divide-/],

  ["rounded-t", /^rounded-t(?:-|$)/],
  ["rounded-r", /^rounded-r(?:-|$)/],
  ["rounded-b", /^rounded-b(?:-|$)/],
  ["rounded-l", /^rounded-l(?:-|$)/],
  ["rounded-tl", /^rounded-tl(?:-|$)/],
  ["rounded-tr", /^rounded-tr(?:-|$)/],
  ["rounded-bl", /^rounded-bl(?:-|$)/],
  ["rounded-br", /^rounded-br(?:-|$)/],
  // Logical corners. The (?:-|$) guard keeps `rounded-s` off `rounded-ss` and,
  // just as importantly, off the `rounded-sm` SIZE.
  ["rounded-s", /^rounded-s(?:-|$)/],
  ["rounded-e", /^rounded-e(?:-|$)/],
  ["rounded-ss", /^rounded-ss(?:-|$)/],
  ["rounded-se", /^rounded-se(?:-|$)/],
  ["rounded-es", /^rounded-es(?:-|$)/],
  ["rounded-ee", /^rounded-ee(?:-|$)/],
  ["rounded", /^rounded(?:-|$)/],

  ["outline-style", /^outline-(?:solid|dashed|dotted|double|none|hidden)$/],
  ["outline-offset", /^-?outline-offset-/],
  ["outline-w", rx(String.raw`^outline(?:-\d|-(?:${WIDTH_ARB})|-\[\d*\.?\d+%?\]|$)`)],
  ["outline-color", /^outline-/],

  // ring-inset toggles the inset flag rather than setting a width, so it gets
  // its own group. Bare `ring` IS a width (1px in v4) and now says so: it used
  // to match no group and merge with ring colours only by accident, because the
  // unknown-class fallback returns the base string "ring", which happened to
  // equal the catch-all group's NAME. Renaming that group to ring-color is safe
  // now, and nothing depends on the coincidence any more.
  ["ring-inset", /^ring-inset$/],
  ["ring-w", rx(String.raw`^ring(?:-\d|-(?:${WIDTH_ARB})|$)`)],
  ["ring-offset-w", rx(String.raw`^ring-offset-(?:\d|${WIDTH_ARB})`)],
  ["ring-offset", /^ring-offset-/],
  ["ring-color", /^ring-/],

  // shadow-color must precede shadow (groupOf returns the FIRST match) or the
  // negative-lookahead color entry is unreachable and sizes/colors wrongly
  // collapse into one group — same ordering rule as border-w/border-color above.
  // The excluded list must carry the WHOLE v4 size scale: 2xs and xs were
  // missing, so those two sizes landed in the colour group and a colour class
  // deleted them. (`inner` is v3-only; kept as harmless back-compat.)
  // A bracket value is a colour only as a colour literal: Tailwind compiles
  // shadow-[var(--x)] / shadow-[0_0_0_1px_red] to box-shadow itself.
  ["shadow-color", rx(String.raw`^shadow-(?!2xs|xs|sm|md|lg|xl|2xl|inner|none|${SHADOW_ARB})`)],
  ["shadow", /^shadow(?:-|$)/],
  ["opacity", /^opacity-/],

  // Backdrop filters COMPOSE into one backdrop-filter value, each through its
  // own --tw-backdrop-* var, so a single /^backdrop-/ group would delete half
  // the effect. One group per filter function.
  ["backdrop-blur", /^backdrop-blur(?:-|$)/],
  ["backdrop-brightness", /^backdrop-brightness-/],
  ["backdrop-contrast", /^backdrop-contrast-/],
  ["backdrop-grayscale", /^backdrop-grayscale(?:-|$)/],
  ["backdrop-hue-rotate", /^-?backdrop-hue-rotate-/],
  ["backdrop-invert", /^backdrop-invert(?:-|$)/],
  ["backdrop-opacity", /^backdrop-opacity-/],
  ["backdrop-saturate", /^backdrop-saturate-/],
  ["backdrop-sepia", /^backdrop-sepia(?:-|$)/],

  // The plain `filter` functions compose the same way (one --tw-* var each
  // into a single `filter` value), so they get one group per function too.
  // Listed AFTER the backdrop-* groups and anchored at ^ so `blur-sm` and
  // `backdrop-blur-sm` never share a group.
  ["blur", /^blur(?:-|$)/],
  ["brightness", /^brightness-/],
  ["contrast", /^contrast-/],
  // drop-shadow-<colour> sets --tw-drop-shadow-color, not the filter itself —
  // same split as shadow-color / shadow above.
  ["drop-shadow-color", rx(String.raw`^drop-shadow-(?!xs|sm|md|lg|xl|2xl|none|${SHADOW_ARB})`)],
  ["drop-shadow", /^drop-shadow(?:-|$)/],
  ["grayscale", /^grayscale(?:-|$)/],
  ["hue-rotate", /^-?hue-rotate-/],
  ["invert", /^invert(?:-|$)/],
  ["saturate", /^saturate-/],
  ["sepia", /^sepia(?:-|$)/],

  ["transition-behavior", /^transition-(?:discrete|normal)$/],
  ["transition", /^transition(?:-|$)/],
  ["duration", /^duration-/],
  ["ease", /^ease-/],
  ["delay", /^delay-/],
  ["animate", /^animate-/],

  ["transform-style", /^transform-(?:3d|flat)$/],
  ["transform-box", /^transform-(?:border|content|fill|stroke|view)$/],
  ["transform", /^transform(?:-|$)/],
  ["translate-x", /^-?translate-x-/],
  ["translate-y", /^-?translate-y-/],
  ["translate-z", /^-?translate-z-/],
  ["translate", /^-?translate-/],
  ["scale-x", /^-?scale-x-/],
  ["scale-y", /^-?scale-y-/],
  ["scale-z", /^-?scale-z-/],
  ["scale", /^-?scale-/],
  ["rotate-x", /^-?rotate-x-/],
  ["rotate-y", /^-?rotate-y-/],
  ["rotate-z", /^-?rotate-z-/],
  ["rotate", /^-?rotate-/],
  ["skew-x", /^-?skew-x-/],
  ["skew-y", /^-?skew-y-/],
  ["origin", /^origin-/],

  ["cursor", /^cursor-/],
  ["select", /^select-/],
  ["pointer-events", /^pointer-events-/],
  ["resize", /^resize(?:-|$)/],
  ["appearance", /^appearance-/],

  ["object-fit", /^object-(?:contain|cover|fill|none|scale-down)$/],
  ["object-position", /^object-/],

  ["fill", /^fill-/],
  ["stroke-w", rx(String.raw`^stroke-(?:\d|${WIDTH_ARB}|\[\d*\.?\d+%?\])`)],
  ["stroke", /^stroke-/],
];

const VARIANT_RE = /^([a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|\[[^\]]+\]|aria-\[[^\]]+\]|data-\[[^\]]+\]|group-[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|peer-[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)?|has-\[[^\]]+\]|not-\[[^\]]+\]|in-[a-z0-9-]+|in-data-\[[^\]]+\]|in-aria-\[[^\]]+\]|in-has-\[[^\]]+\]|supports-\[[^\]]+\]|max-[a-z0-9-]+|min-[a-z0-9-]+):/;

interface Parsed {
  full: string;
  variants: string;
  base: string;
  important: boolean;
}

function parseToken(raw: string): Parsed {
  let rest = raw;
  let variants = "";
  // Collect every variant: prefix
  while (true) {
    const m = rest.match(VARIANT_RE);
    if (!m) break;
    variants += m[0];
    rest = rest.slice(m[0].length);
  }
  const important = rest.endsWith("!");
  const base = important ? rest.slice(0, -1) : rest;
  return { full: raw, variants, base, important };
}

/**
 * The group a utility belongs to, or `null` when the table models none of it.
 *
 * Exported for [scripts/audit-tw-merge.mts](../../scripts/audit-tw-merge.mts),
 * which must tell "matched group X" apart from "matched nothing" — a
 * distinction `groupOf` erases by falling back to the class string. That
 * fallback is why a group whose NAME equals a real class reads as grouped
 * either way; the auditor would report those as false findings without this.
 */
export function matchGroup(base: string): string | null {
  for (const [name, re] of GROUPS) {
    if (re.test(base)) return name;
  }
  return null;
}

function groupOf(base: string): string {
  return matchGroup(base) ?? base;
}

export function twMerge(input: string): string {
  if (!input) return "";
  const tokens = input.split(/\s+/).filter(Boolean);
  const lastIdx = new Map<string, number>();
  const parsed: Parsed[] = new Array(tokens.length);
  // The merge key is computed ONCE per token and kept for the emit pass.
  // `groupOf` is a linear first-match scan over the whole GROUPS regex table
  // (an unmatched class pays every entry), and this is the `cn()` hot path on
  // every render of every ui primitive — recomputing the identical key in the
  // second loop doubled that work for no output change. tests/tw-merge.test.mts
  // pins the single-scan-per-token count.
  const keys: string[] = new Array(tokens.length);

  for (let i = 0; i < tokens.length; i++) {
    const p = parseToken(tokens[i]);
    parsed[i] = p;
    const key = `${p.variants}|${p.important ? "!" : ""}|${groupOf(p.base)}`;
    keys[i] = key;
    lastIdx.set(key, i);
  }

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (lastIdx.get(keys[i]) === i) out.push(parsed[i].full);
  }
  return out.join(" ");
}
