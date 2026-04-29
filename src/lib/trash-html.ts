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

export function stripTrashHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
