
// Strip HTML-injection (`<>`), NUL, control chars, and Unicode bidi-overrides
// from user-supplied text before it's stored or displayed.
export function sanitizeText(input: string): string {
  return input
    .replace(/[<>]/g, "")
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, "")
    // Unicode bidi-override characters can reverse displayed text in logs/UI - strip them
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
}

// Two ways to make user-supplied search text safe for a LIKE/ILIKE match. Pick
// by HOW the query is built, not by taste:
//
//   raw SQL you control → escapeIlike, paired with `ESCAPE '\'` on EVERY ILIKE
//                         clause the escaped bind feeds.
//   Prisma `contains`   → sanitizeContainsSearch.
//
// The shared hazard is the same either way: `%` and `_` are LIKE wildcards, and
// a wildcard-laden term expands into an unindexable pattern scan, so any search
// box becomes an expensive query on demand (a wildcard-scan DoS). Neither
// helper is an injection defence — search terms ride BOUND parameters on both
// paths; only whitelisted identifiers ever reach SQL text.
//
// Length is bounded separately: `sanitizeContainsSearch` slices, `escapeIlike`
// does not (escaping can lengthen the string, so the cap belongs on the term
// BEFORE it, where the limit means what it says). Raw callers slice to
// SEARCH_TERM_MAX_LEN themselves.
export const SEARCH_TERM_MAX_LEN = 100;

// Escape the LIKE/ILIKE metacharacters (`%`, `_`) and the escape character
// itself so the term matches LITERALLY. This ONLY works when the ILIKE clause
// consuming the bind carries an explicit `ESCAPE '\'` — that clause is what
// tells Postgres the backslashes we inserted are escapes rather than data.
// Without it the term is matched with the backslashes still in it and a search
// for `john_doe` silently matches nothing.
export function escapeIlike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// The Prisma `contains` filter emits an ILIKE with NO ESCAPE clause and gives
// callers no way to add one, so escaping is not available on that path — the
// metacharacters have to be dropped instead. That is lossy (a search for
// `john_doe` degrades to `johndoe`, which over-matches), which is exactly why
// the raw-SQL paths are worth the extra `ESCAPE '\'` ceremony.
export function sanitizeContainsSearch(input: string): string {
  return input.replace(/[%_\\]/g, "").slice(0, SEARCH_TERM_MAX_LEN);
}

export function sanitizeOptional(input: string | undefined | null): string | null {
  // Runtime-guard the type, don't just trust it. These values come from JSON
  // request bodies, where the declared body type is a compile-time claim only —
  // a client sending `{"title": 123}` reached `.replace` on a number and threw,
  // turning what should be a 400 into a 500.
  if (typeof input !== "string") return null;
  const cleaned = sanitizeText(input);
  return cleaned || null;
}

// Neutralise anything an interpolated value could use to forge extra log lines
// or repaint an operator's terminal (log-injection defence).
//
// Everything here is removed, never substituted, and CR/LF are removed by two
// separate single-character constant patterns. Both details are load-bearing
// for static analysis, not style. CodeQL's log-injection barrier is:
//
//   this.(StringReplaceCall).replaces(s, "") and s.regexpMatch("\\n")
//
// so it matches ONLY a replace whose replaced string is exactly a newline AND
// whose replacement is the EMPTY string. The earlier `/[\r\n]/g -> " "`
// form failed on the replacement (a space, not ""), which is why seven
// js/log-injection alerts stayed open on callsites that were already sanitised.
// Substituting a space here again will silently reopen all of them.
export function sanitizeForLog(value: unknown): string {
  return String(value)
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    // The Unicode line/paragraph separators are line breaks to plenty of log
    // viewers, so they forge lines just like LF does. (NEL, U+0085, is covered
    // by the C1 range below.)
    .replace(/[\u2028\u2029]/g, "")
    // Remaining C0/C1 controls and DEL. ESC (\x1B) is the important one:
    // ANSI sequences let a value colour, erase or reposition text in an
    // operator's terminal, faking log content without ever emitting a newline.
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    // Bidi overrides reverse displayed text (Trojan-Source-style log spoofing) -
    // same rationale as sanitizeText above.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}
