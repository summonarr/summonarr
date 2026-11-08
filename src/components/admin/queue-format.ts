// Formatting shared by the admin Radarr/Sonarr pages: the Download Queue table
// and its Import dialog, the release lists (request queue, issue Fix file),
// history, calendar and system tabs. Pure, and no "use client": a server page
// may call it too. Every value is server-supplied (no clock reads — guardrail 16).

export type EpisodeRef = { seasonNumber: number; episodeNumber: number };

export const episodeCode = (e: EpisodeRef) =>
  `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;

// Season, then episode; one entry per (season, episode).
function sortedUnique(eps: readonly EpisodeRef[]): EpisodeRef[] {
  const seen = new Set<string>();
  const out: EpisodeRef[] = [];
  for (const e of eps) {
    const k = `${e.seasonNumber}:${e.episodeNumber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

// "S01E01–E08" for a contiguous run in one season, otherwise the first few
// codes. Sorted and de-duplicated here, so the range is only ever claimed for
// a run that really is contiguous — whatever order the caller passed.
export function episodeSummary(input: readonly EpisodeRef[]): string {
  const eps = sortedUnique(input);
  if (eps.length === 0) return "";
  if (eps.length === 1) return episodeCode(eps[0]);
  const first = eps[0];
  const last = eps[eps.length - 1];
  // E01 + E03 is not "E01–E03": unique and sorted, the span equals the count only without a gap.
  const contiguous = first.seasonNumber === last.seasonNumber && last.episodeNumber - first.episodeNumber + 1 === eps.length;
  if (contiguous) return `${episodeCode(first)}–E${String(last.episodeNumber).padStart(2, "0")}`;
  return `${eps.slice(0, 3).map(episodeCode).join(", ")}${eps.length > 3 ? ` +${eps.length - 3}` : ""}`;
}

// A Sonarr season pack is one queue record per episode, so the row alone can't
// say "pack". The release name can: a season marker with no episode marker
// (`Show.S01.1080p`, `Show Season 1`). Returns the seasons it spans, or null.
export function seasonPackSeasons(releaseTitle: string, eps: readonly EpisodeRef[]): number[] | null {
  if (eps.length < 2) return null;
  const hasEpisodeMarker = /S\d{1,2}[ ._-]?E\d{1,3}|\b\d{1,2}x\d{2,3}\b/i.test(releaseTitle);
  const hasSeasonMarker = /\bS\d{1,2}\b|\bseasons?[ ._-]?\d/i.test(releaseTitle);
  if (hasEpisodeMarker || !hasSeasonMarker) return null;
  return [...new Set(eps.map((e) => e.seasonNumber))].sort((a, b) => a - b);
}

/** A byte count as the arr shows it: "1.4 GB" from a gigabyte up, whole megabytes below (never negative). */
export function sizeFormatter(locale: string): (bytes: number) => string {
  const gb = new Intl.NumberFormat(locale, { style: "unit", unit: "gigabyte", unitDisplay: "narrow", maximumFractionDigits: 1 });
  const mb = new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", unitDisplay: "narrow", maximumFractionDigits: 0 });
  return (bytes) => (bytes >= 1e9 ? gb.format(bytes / 1e9) : mb.format(Math.max(0, Math.round(bytes / 1e6))));
}

/** A release's age in whole days ("3d"), as the indexer reported it. */
export function ageFormatter(locale: string): (days: number) => string {
  const d = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "narrow", maximumFractionDigits: 0 });
  return (days) => d.format(Math.max(0, Math.round(days)));
}

export function queueFormatters(locale: string) {
  const size = sizeFormatter(locale);
  const hour = new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "narrow" });
  const minute = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "narrow" });
  const day = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "narrow" });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const signed = new Intl.NumberFormat(locale, { signDisplay: "exceptZero" });
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return {
    size,
    duration: (seconds: number | null) => {
      if (seconds === null) return "—";
      if (seconds >= 86_400) return `${day.format(Math.floor(seconds / 86_400))} ${hour.format(Math.floor((seconds % 86_400) / 3_600))}`;
      if (seconds >= 3_600) return `${hour.format(Math.floor(seconds / 3_600))} ${minute.format(Math.floor((seconds % 3_600) / 60))}`;
      return minute.format(Math.max(0, Math.ceil(seconds / 60)));
    },
    percent: (p: number) => pct.format(p),
    /** A custom-format score as the arr shows it: +1500, -10000, 0. */
    score: (n: number) => signed.format(n),
    /** An ISO timestamp the server sent, in the viewer's locale and zone. */
    dateTime: (iso: string | null) => {
      const ms = iso === null ? Number.NaN : Date.parse(iso);
      return Number.isFinite(ms) ? when.format(ms) : "—";
    },
  };
}
