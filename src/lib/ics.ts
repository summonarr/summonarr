// Pure, zero-import iCalendar (RFC 5545) encoder for the personal calendar feed
// (/api/calendar/feed/<token>.ics). Kept dependency-free so every encoding rule
// below is unit-testable without a request scope (tests/ics.test.mts).
//
// The rules that calendar clients actually enforce, and that a hand-rolled
// encoder most often gets wrong:
//   - Every content line ends in CRLF, the last one included (§3.1).
//   - Lines are folded at 75 OCTETS, not 75 characters (§3.1). A continuation
//     line begins with one space, which counts toward its own 75. A fold must
//     never land inside a multi-byte UTF-8 sequence — Google Calendar renders a
//     split code point as U+FFFD and Outlook drops the property.
//   - TEXT values escape backslash, semicolon, comma and newline (§3.3.11).
//     Other control characters are not allowed in TEXT at all and are removed.
//   - An all-day event is DTSTART;VALUE=DATE with an exclusive DTEND of the
//     NEXT day (§3.6.1). DTEND equal to DTSTART is a zero-length event that
//     several clients hide.

export interface IcsEvent {
  /** Globally unique, STABLE across regenerations — clients key updates on it. */
  uid: string;
  /** All-day date, `YYYY-MM-DD`. */
  date: string;
  summary: string;
  description?: string;
  /** Absolute URL to the title's page. */
  url?: string;
}

export interface IcsCalendar {
  name: string;
  description?: string;
  /** Suggested client refresh interval, an RFC 5545 DURATION (e.g. `PT6H`). */
  refreshInterval?: string;
  events: readonly IcsEvent[];
  /** The DTSTAMP for every event. Injected so output is deterministic in tests. */
  now: Date;
}

const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // Remaining C0 controls (HTAB is allowed) and DEL are invalid in TEXT.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Fold one unfolded content line into CRLF-joined physical lines of at most 75
 * octets each (the leading continuation space included). Splits only on code
 * point boundaries, so a multi-byte character is never divided.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let currentOctets = 0;
  // `for…of` iterates CODE POINTS (surrogate pairs stay together).
  for (const ch of line) {
    const octets = utf8Length(ch.codePointAt(0) ?? 0);
    if (currentOctets + octets > MAX_LINE_OCTETS) {
      out.push(current);
      current = " ";
      currentOctets = 1;
    }
    current += ch;
    currentOctets += octets;
  }
  out.push(current);
  return out.join(CRLF);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** `YYYY-MM-DD` → the `YYYYMMDD` DATE value form. */
export function icsDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

/** The calendar day after `isoDate` (`YYYY-MM-DD`), month/year/leap aware. */
export function nextIsoDate(isoDate: string): string {
  const m = DATE_RE.exec(isoDate);
  if (!m) throw new Error(`not an ISO date: ${isoDate}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return t.toISOString().slice(0, 10);
}

/** A Date → the UTC DATE-TIME form `YYYYMMDDTHHMMSSZ`. */
export function icsUtcDateTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Strip anything that could break a non-TEXT value out of its line. */
function safeRaw(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

/** Encode a full VCALENDAR document. Events with an invalid date are skipped. */
export function buildIcsCalendar(cal: IcsCalendar): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Summonarr//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(cal.name)}`,
  ];
  if (cal.description) lines.push(`X-WR-CALDESC:${escapeIcsText(cal.description)}`);
  if (cal.refreshInterval) {
    const dur = safeRaw(cal.refreshInterval);
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${dur}`, `X-PUBLISHED-TTL:${dur}`);
  }
  const stamp = icsUtcDateTime(cal.now);
  for (const ev of cal.events) {
    if (!isIsoDate(ev.date)) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${safeRaw(ev.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(ev.date)}`,
      `DTEND;VALUE=DATE:${icsDate(nextIsoDate(ev.date))}`,
      `SUMMARY:${escapeIcsText(ev.summary)}`,
    );
    if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    if (ev.url) lines.push(`URL:${safeRaw(ev.url)}`);
    // A release date is information, not a commitment — never show it as busy.
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
