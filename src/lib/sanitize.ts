
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

export function sanitizeOptional(input: string | undefined | null): string | null {
  if (input == null) return null;
  const cleaned = sanitizeText(input);
  return cleaned || null;
}

// Neutralise anything an interpolated value could use to forge extra log lines
// or repaint an operator's terminal (log-injection defence).
//
// CR and LF are stripped via two separate *constant* patterns instead of a
// single `/[\r\n]/g` character class. That is load-bearing for static
// analysis, not style: CodeQL's log-injection sanitiser model only recognises a
// replace whose pattern is a regexp constant, so the character-class form read
// as "unsanitised" and left seven `js/log-injection` alerts open on callsites
// that were in fact already sanitised.
export function sanitizeForLog(value: unknown): string {
  return String(value)
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    // The Unicode line/paragraph separators are line breaks to plenty of log
    // viewers, so they forge lines just like LF does. (NEL, U+0085, is covered
    // by the C1 range below.)
    .replace(/[\u2028\u2029]/g, " ")
    // Remaining C0/C1 controls and DEL. ESC (\x1B) is the important one:
    // ANSI sequences let a value colour, erase or reposition text in an
    // operator's terminal, faking log content without ever emitting a newline.
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    // Bidi overrides reverse displayed text (Trojan-Source-style log spoofing) -
    // same rationale as sanitizeText above.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}
