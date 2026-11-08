// A small Tailwind class merger, used by cn() in place of the `tailwind-merge`
// package. When two classes set the same thing (say `p-2` and `p-4`), the one
// written last wins and the other is dropped. Classes with different variant
// prefixes (hover:, dark:, sm:, focus-visible:, group/foo:, …) never conflict
// with each other.
//
// Each class is matched against the GROUPS table below. The FIRST group whose
// regex matches wins, so a narrow group must come before a broad "catch-all"
// group with the same prefix (guardrail 39).

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
// A gradient stop's POSITION (from-/via-/to-): a length, a percentage, a
// length-valued function, or a `length:`/`percentage:` hint. Any other bracket
// or paren value — a hex, a var(), a bare number — is the stop's COLOUR.
const POSITION_ARB = String.raw`\[(?:length:|percentage:|-?(?:calc|clamp|min|max)\(|${LEN}\]|-?\d*\.?\d+%\])|\((?:length|percentage):`;
// A background IMAGE: an image function, or an `image:`/`url:` hint. Without
// it an arbitrary url background fell into the bg colour catch-all beside
// `bg-zinc-900`. (Never spell such a class out in a comment: Tailwind scans
// this file and emits a url() rule the CSS bundler then tries to resolve.)
const IMAGE_ARB = String.raw`\[(?:url|image|image-set|cross-fade|element|(?:repeating-)?(?:linear|radial|conic)-gradient)\(|\[(?:image|url):|\((?:image|url):`;
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
  // are not modelled anywhere in this table: a shorthand never evicts a longhand
  // (col-span vs col-start, p vs px, m vs mx, size vs w/h, inset vs top, rounded
  // vs rounded-t, border vs border-t, overflow vs overflow-x). Both classes stay,
  // and the surviving LONGHAND is not redundant: Tailwind emits every shorthand
  // before its longhands, so it wins whatever the class order. A caller
  // overriding a longhand must use the same longhand (`px-0` over a Button's
  // `px-2.5`, never `p-0`). See the PIN test.
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

  // The text-indent utility is `indent-*` (there is no `text-indent-*` class).
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
  ["bg-image", rx(String.raw`^-?bg-(?:none|gradient-|linear-|radial|conic|${IMAGE_ARB})`)],
  ["bg-blend", /^bg-blend-/],
  // Gradient stops: each of from/via/to carries a colour AND a position. An
  // arbitrary value is a position only when position-shaped (POSITION_ARB):
  // filing every bracket as a position made `from-[#123] from-10%` drop the colour.
  ["from-pos", rx(String.raw`^from-(?:\d+%|${POSITION_ARB})`)],
  ["from", /^from-/],
  ["via-pos", rx(String.raw`^via-(?:\d+%|${POSITION_ARB})`)],
  ["via", /^via-/],
  ["to-pos", rx(String.raw`^to-(?:\d+%|${POSITION_ARB})`)],
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
  // its own group. Bare `ring` is a width (1px in v4), so ring-w matches it
  // explicitly instead of relying on the class-name fallback in groupOf.
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

interface Parsed {
  full: string;
  variants: string;
  base: string;
  important: boolean;
}

// The variant prefix is everything up to the LAST top-level `:` — one outside
// `[…]` and `(…)`, so a colon inside an arbitrary value or variant
// (`supports-[display:grid]:`, or an arbitrary url background) never splits it. That
// takes every variant shape Tailwind has (has-data-[…]:, not-aria-[…]:,
// group-data-[…]/name:, *:, **:, @md:) without a whitelist; the old one missed
// those, so the whole token became its own group and a same-variant override
// never merged. Variant ORDER is kept as written (see the PIN test).
function splitVariants(raw: string): { variants: string; rest: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  return { variants: raw.slice(0, cut + 1), rest: raw.slice(cut + 1) };
}

function parseToken(raw: string): Parsed {
  const { variants, rest } = splitVariants(raw);
  // Important is `!` at either end of the utility: v4's `p-2!` or the
  // leading `!p-2` form Tailwind still accepts.
  const important = rest.startsWith("!") || rest.endsWith("!");
  const base = rest.startsWith("!") ? rest.slice(1) : rest.endsWith("!") ? rest.slice(0, -1) : rest;
  return { full: raw, variants, base, important };
}

/** The utility a class token names, variants and `!` stripped — the string
 *  the GROUPS table classifies. Exported so the auditor reads src/ tokens with
 *  the same parse twMerge uses. */
export function utilityBase(token: string): string {
  return parseToken(token).base;
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

// groupOf is on the cn() hot path (every render of every ui primitive) and
// matchGroup is a linear first-match scan over GROUPS, so the answer is
// memoised per utility. The set of utilities an app uses is small and fixed,
// so the bound (cleared wholesale when full) is only a guard against a stream
// of unique arbitrary values. matchGroup itself stays un-memoised: the auditor
// relies on its null-vs-group answer, not groupOf's fallback.
const GROUP_MEMO_MAX = 2_000;
const groupMemo = new Map<string, string>();

function groupOf(base: string): string {
  let group = groupMemo.get(base);
  if (group === undefined) {
    if (groupMemo.size >= GROUP_MEMO_MAX) groupMemo.clear();
    group = matchGroup(base) ?? base;
    groupMemo.set(base, group);
  }
  return group;
}

export function twMerge(input: string): string {
  if (!input) return "";
  const tokens = input.split(/\s+/).filter(Boolean);
  const lastIdx = new Map<string, number>();
  const parsed: Parsed[] = new Array(tokens.length);
  // The merge key is computed ONCE per token and kept for the emit pass: even
  // with groupOf memoised, recomputing the identical key in the second loop
  // would be wasted work on the `cn()` hot path. tests/tw-merge.test.mts pins
  // the scan counts.
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
