// Pragmatic Tailwind-class merger. Replaces `tailwind-merge` for the cases this
// codebase actually exercises: same-group utilities collapse to the last write,
// variant prefixes (hover:, dark:, sm:, focus-visible:, group/foo:, …) form
// independent class spaces.

const GROUPS: Array<readonly [string, RegExp]> = [
  ["display", /^(flex|grid|block|inline|inline-flex|inline-grid|inline-block|hidden|contents|flow-root|table|table-(?:row|cell|caption|column|row-group|column-group|header-group|footer-group))$/],
  ["position", /^(static|relative|absolute|fixed|sticky)$/],
  ["visibility", /^(visible|invisible|collapse)$/],
  ["overflow", /^overflow-(?:auto|hidden|clip|visible|scroll)$/],
  ["overflow-x", /^overflow-x-/],
  ["overflow-y", /^overflow-y-/],
  ["z", /^-?z-/],
  ["inset", /^-?inset-(?!x-|y-)/],
  ["inset-x", /^-?inset-x-/],
  ["inset-y", /^-?inset-y-/],
  ["top", /^-?top-/],
  ["right", /^-?right-/],
  ["bottom", /^-?bottom-/],
  ["left", /^-?left-/],

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

  ["space-x", /^-?space-x-/],
  ["space-y", /^-?space-y-/],
  ["gap-x", /^gap-x-/],
  ["gap-y", /^gap-y-/],
  ["gap", /^gap-/],

  ["flex-dir", /^flex-(?:row|row-reverse|col|col-reverse)$/],
  ["flex-wrap", /^flex-(?:wrap|wrap-reverse|nowrap)$/],
  ["flex", /^flex-(?:1|auto|initial|none|\[)/],
  ["grow", /^grow(?:-|$)/],
  ["shrink", /^shrink(?:-|$)/],
  ["basis", /^basis-/],
  ["order", /^-?order-/],

  ["justify", /^justify-/],
  ["items", /^items-/],
  ["content", /^content-/],
  ["self", /^self-/],
  ["place-items", /^place-items-/],
  ["place-content", /^place-content-/],
  ["place-self", /^place-self-/],

  ["grid-cols", /^grid-cols-/],
  ["grid-rows", /^grid-rows-/],
  ["col-span", /^col-(?:span|start|end)-/],
  ["row-span", /^row-(?:span|start|end)-/],

  ["text-align", /^text-(?:left|center|right|justify|start|end)$/],
  ["text-size", /^text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|\[[^\]]+\])$/],
  ["text-color", /^text-/],

  ["font-weight", /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/],
  ["font-style", /^(?:italic|not-italic)$/],
  ["font", /^font-/],

  ["leading", /^leading-/],
  ["tracking", /^-?tracking-/],
  ["whitespace", /^whitespace-/],
  ["break", /^(?:break-words|break-all|break-keep|break-normal)$/],
  ["truncate", /^truncate$/],
  ["uppercase", /^(?:uppercase|lowercase|capitalize|normal-case)$/],

  ["decoration-style", /^decoration-(?:solid|double|dotted|dashed|wavy|none)$/],
  ["decoration", /^decoration-/],
  ["underline", /^(?:underline|overline|line-through|no-underline)$/],
  ["underline-offset", /^underline-offset-/],

  ["bg-attachment", /^bg-(?:fixed|local|scroll)$/],
  ["bg-repeat", /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/],
  ["bg-size", /^bg-(?:auto|cover|contain)$/],
  ["bg-position", /^bg-(?:top|right|bottom|left|center|right-top|right-bottom|left-top|left-bottom)$/],
  ["bg-image", /^bg-(?:none|gradient-)/],
  ["bg-clip", /^bg-clip-/],
  ["bg-origin", /^bg-origin-/],
  ["bg", /^bg-/],

  ["border-style", /^border-(?:solid|dashed|dotted|double|hidden|none)$/],
  ["border-w-x", /^border-x-(?:\d|\[)/],
  ["border-w-y", /^border-y-(?:\d|\[)/],
  ["border-w-t", /^border-t-(?:\d|\[)/],
  ["border-w-r", /^border-r-(?:\d|\[)/],
  ["border-w-b", /^border-b-(?:\d|\[)/],
  ["border-w-l", /^border-l-(?:\d|\[)/],
  ["border-w", /^border(?:-\d|-\[|$)/],
  ["border-color-x", /^border-x-/],
  ["border-color-y", /^border-y-/],
  ["border-color-t", /^border-t-/],
  ["border-color-r", /^border-r-/],
  ["border-color-b", /^border-b-/],
  ["border-color-l", /^border-l-/],
  ["border-color", /^border-/],

  ["rounded-t", /^rounded-t(?:-|$)/],
  ["rounded-r", /^rounded-r(?:-|$)/],
  ["rounded-b", /^rounded-b(?:-|$)/],
  ["rounded-l", /^rounded-l(?:-|$)/],
  ["rounded-tl", /^rounded-tl(?:-|$)/],
  ["rounded-tr", /^rounded-tr(?:-|$)/],
  ["rounded-bl", /^rounded-bl(?:-|$)/],
  ["rounded-br", /^rounded-br(?:-|$)/],
  ["rounded", /^rounded(?:-|$)/],

  ["ring-w", /^ring-(?:\d|inset|\[)/],
  ["ring-offset-w", /^ring-offset-(?:\d|\[)/],
  ["ring-offset", /^ring-offset-/],
  ["ring", /^ring-/],

  // shadow-color must precede shadow (groupOf returns the FIRST match) or the
  // negative-lookahead color entry is unreachable and sizes/colors wrongly
  // collapse into one group — same ordering rule as border-w/border-color above.
  ["shadow-color", /^shadow-(?!sm|md|lg|xl|2xl|inner|none)/],
  ["shadow", /^shadow(?:-|$)/],
  ["opacity", /^opacity-/],

  ["transition", /^transition(?:-|$)/],
  ["duration", /^duration-/],
  ["ease", /^ease-/],
  ["delay", /^delay-/],
  ["animate", /^animate-/],

  ["translate-x", /^-?translate-x-/],
  ["translate-y", /^-?translate-y-/],
  ["translate", /^-?translate-/],
  ["scale-x", /^-?scale-x-/],
  ["scale-y", /^-?scale-y-/],
  ["scale", /^-?scale-/],
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
  ["stroke-w", /^stroke-(?:\d|\[)/],
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

function groupOf(base: string): string {
  for (const [name, re] of GROUPS) {
    if (re.test(base)) return name;
  }
  return base;
}

export function twMerge(input: string): string {
  if (!input) return "";
  const tokens = input.split(/\s+/).filter(Boolean);
  const lastIdx = new Map<string, number>();
  const parsed: Parsed[] = new Array(tokens.length);

  for (let i = 0; i < tokens.length; i++) {
    const p = parseToken(tokens[i]);
    parsed[i] = p;
    const key = `${p.variants}|${p.important ? "!" : ""}|${groupOf(p.base)}`;
    lastIdx.set(key, i);
  }

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const p = parsed[i];
    const key = `${p.variants}|${p.important ? "!" : ""}|${groupOf(p.base)}`;
    if (lastIdx.get(key) === i) out.push(p.full);
  }
  return out.join(" ");
}
