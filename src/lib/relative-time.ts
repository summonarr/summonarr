// Shared relative-time formatter: "just now" / "Xm ago" / "Xh ago" / "Xd ago".
// Pure — it reads Date.now() at call time, so "use client" components must keep
// gating calls behind useHasMounted at the callsite (CLAUDE.md guardrail 16).

type Unit = "minute" | "hour" | "day";

// The one ladder every formatter below walks: whole minutes, hours or days
// since `ms`, or "now" under a minute (a future time counts as now). Null for
// an unparsable date, so no caller renders "NaNd ago".
function elapsed(ms: number): { unit: "now" } | { unit: Unit; value: number } | null {
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "minute", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.floor(hours / 24) };
}

const SHORT_SUFFIX: Record<Unit, string> = { minute: "m", hour: "h", day: "d" };

function compact(step: NonNullable<ReturnType<typeof elapsed>>): string {
  return step.unit === "now" ? "just now" : `${step.value}${SHORT_SUFFIX[step.unit]} ago`;
}

export function formatRelativeTime(date: string | number | Date): string {
  const step = elapsed(new Date(date).getTime());
  return step ? compact(step) : "";
}

// Variant that falls back to an absolute "Mon D, YYYY" date past 30 days — a
// months-old "142d ago" is less readable than the date itself. The locale
// defaults to en-US so output never depends on the runtime's locale (guardrail
// 16); the same client-side useHasMounted gating requirement still applies.
export function formatRelativeTimeWithDateFallback(date: string | number | Date, dateLocale = "en-US"): string {
  const d = new Date(date);
  const step = elapsed(d.getTime());
  if (!step) return "";
  if (step.unit === "day" && step.value >= 30) {
    return d.toLocaleDateString(dateLocale, { month: "short", day: "numeric", year: "numeric" });
  }
  return compact(step);
}

// Locale-aware twin of formatRelativeTime. English keeps the compact
// "Xm ago" output above byte-for-byte; every other locale goes through
// Intl.RelativeTimeFormat ("hace 3 min", "ahora"). Same read-the-clock-at-call
// contract, so client callers still gate it behind useHasMounted (guardrail 16).
export function formatRelativeTimeLocalized(date: string | number | Date, locale: string): string {
  if (locale === "en") return formatRelativeTime(date);
  // An unparsable date would reach rtf.format(NaN), which throws a RangeError
  // inside a client render; show nothing instead.
  const step = elapsed(new Date(date).getTime());
  if (!step) return "";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  return step.unit === "now" ? rtf.format(0, "second") : rtf.format(-step.value, step.unit);
}
