// Two duration formatters that used to be defined as same-named local
// `formatDuration` helpers in different components with INCOMPATIBLE units
// (one milliseconds, one seconds) — a maintenance trap. Distinct names here.

// Milliseconds → "Nms" under a second, "X.Xs" above. For short machine
// timings (cron last-run durations).
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Seconds → "Xh Ym" / "Xm", em-dash for non-positive. For human watch/play
// durations.
export function formatDurationSeconds(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type DurationUnit = "hour" | "minute" | "second" | "millisecond";

// One formatter per (locale, unit) — the personal history list calls this twice
// per row, and Intl.NumberFormat construction is the expensive part.
const unitFormatters = new Map<string, Intl.NumberFormat | null>();

function unitFormatter(locale: string, unit: DurationUnit, fractionDigits = 0): Intl.NumberFormat | null {
  const key = `${locale}\u0000${unit}\u0000${fractionDigits}`;
  const hit = unitFormatters.get(key);
  if (hit !== undefined) return hit;
  let fmt: Intl.NumberFormat | null;
  try {
    fmt = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: fractionDigits });
  } catch {
    // A malformed locale tag is a RangeError; remember the miss so the fallback
    // doesn't re-throw on every cell.
    fmt = null;
  }
  unitFormatters.set(key, fmt);
  return fmt;
}

const ENGLISH_ABBR: Record<DurationUnit, string> = { hour: "h", minute: "m", second: "s", millisecond: "ms" };

// Localized twin of formatDurationMs for the admin cron table: "170.7s" was
// the one English-only cell in a column whose neighbours were translated.
// "Nms" under a second, one-decimal seconds above, through Intl's narrow unit
// style; bare English abbreviations if Intl rejects the locale tag.
export function formatDurationMsLocalized(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) {
    const n = Math.round(ms);
    return unitFormatter(locale, "millisecond")?.format(n) ?? `${n}ms`;
  }
  const secs = Math.round(ms / 100) / 10;
  return unitFormatter(locale, "second", 1)?.format(secs) ?? `${secs.toFixed(1)}s`;
}

// Seconds → a LOCALIZED "2h 15m" / "15m" / "45s" through Intl's narrow unit
// style (en "2h 15m", de "2h 15 Min.", zh "2小时 15分钟"), em-dash for
// non-positive. The personal watch pages (history list, My Stats KPIs, the
// wrapped tiles) read this instead of their old hardcoded-English `${h}h ${m}m`
// copies, so a zh/de/fr UI no longer shows an untranslated "h" beside strings
// the translator already localized. If Intl rejects the locale tag the bare
// English abbreviations are used — a bad tag must never blank a duration cell.
export function formatDurationHM(seconds: number, locale: string): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const part = (n: number, unit: DurationUnit) =>
    unitFormatter(locale, unit)?.format(n) ?? `${n}${ENGLISH_ABBR[unit]}`;
  if (h > 0) return `${part(h, "hour")} ${part(m, "minute")}`;
  if (m > 0) return part(m, "minute");
  return part(Math.round(seconds), "second");
}
