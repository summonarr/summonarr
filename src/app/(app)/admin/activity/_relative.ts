import { formatRelativeTimeLocalized } from "@/lib/relative-time";

const DAY_MS = 86_400_000;

// Server-rendered relative time with an absolute-date fallback past 30 days, in
// the request's locale. English keeps the compact "3d ago" form byte-for-byte
// and dates in en-US, as formatRelativeTimeWithDateFallback does. The date is
// the statistics time zone's (getStatsTimeZone), like every other day on the
// Activity pages — the process zone could put a late-evening item a day off.
// Server components only: reads the clock at call time.
export function relativeWithDateFallback(d: Date, locale: string, timeZone?: string): string {
  if (!Number.isFinite(d.getTime())) return "";
  if (Date.now() - d.getTime() < 30 * DAY_MS) return formatRelativeTimeLocalized(d, locale);
  return d.toLocaleDateString(locale === "en" ? "en-US" : locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}
