// Pure string helper for sanitizing TRaSH-Guides description HTML for display.
// Imported by both server-side rationale derivation (`trash-recommendations.ts`)
// and the client-side trash-guides UI.
//
// Upstream `trash_description` payloads contain HTML — `<br>` tags for line
// breaks and `<a href="…">…</a>` for cross-references to the TRaSH discord etc.
// React escapes these on render, so they show up as literal angle-bracketed
// text. Strip them here so the rationale displays as plain prose with newlines.
//
// Deliberately not switching to `dangerouslySetInnerHTML` + DOMPurify — the
// trust boundary with the upstream TRaSH catalog is currently "we trust it",
// and stripping is one-way: future regressions can't introduce XSS.
//
// Two CodeQL-flagged hazards to keep in mind if you edit this:
//   1. Strip remaining tags in a loop until the string is stable. A single
//      pass of `/<[^>]+>/g` can leave reassembled markup in adversarial input
//      like `<scr<script>ipt>` (CodeQL: incomplete multi-char sanitization).
//   2. Decode every entity in ONE pass. Decoding them one after another, with
//      `&amp;` anywhere but last, would turn `&amp;lt;` into a literal `<`
//      (CodeQL: double unescape); a single pass never re-reads its output.
//
// The tag strip is deliberately lossy (prose like `a < b > c` goes with it) and
// numeric entities stay literal — both pinned in tests/trash-html.test.mts.

// The named entities TRaSH prose uses. Anything else stays as written.
const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&amp;": "&",
};
const ENTITY = /&(?:lt|gt|quot|#39|apos|nbsp|amp);/g;

export function stripTrashHtml(html: string): string {
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // Strip remaining tags. Loop until stable so adversarial nesting can't
  // re-form a tag after a single pass.
  let prev: string;
  do {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== prev);

  return text
    .replace(ENTITY, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
