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
//   2. Decode `&amp;` LAST. Decoding it before `&lt;` would turn `&amp;lt;`
//      into a literal `<` (CodeQL: double unescape).

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

  // Decode entities. `&amp;` must run last to avoid double-unescaping.
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
