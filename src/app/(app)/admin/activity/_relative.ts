import { formatRelativeTimeLocalized, formatRelativeTimeWithDateFallback } from "@/lib/relative-time";

// Server-rendered relative time with an absolute-date fallback past 30 days,
// in the request's locale. English keeps the existing compact formatter
// byte-for-byte. Server components only: reads the clock at call time.
export function relativeWithDateFallback(d: Date, locale: string): string {
  if (locale === "en") return formatRelativeTimeWithDateFallback(d);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 30) return formatRelativeTimeLocalized(d, locale);
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}
