// Formatting shared by the Download Queue table and its Import dialog. Pure;
// every value is server-supplied (no clock reads — guardrail 16).

export type EpisodeRef = { seasonNumber: number; episodeNumber: number };

export const episodeCode = (e: EpisodeRef) =>
  `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;

// "S01E01–E08" for a run in one season, otherwise the first few codes.
export function episodeSummary(eps: readonly EpisodeRef[]): string {
  if (eps.length === 0) return "";
  if (eps.length === 1) return episodeCode(eps[0]);
  const sameSeason = eps.every((e) => e.seasonNumber === eps[0].seasonNumber);
  if (sameSeason) return `${episodeCode(eps[0])}–E${String(eps[eps.length - 1].episodeNumber).padStart(2, "0")}`;
  return `${eps.slice(0, 3).map(episodeCode).join(", ")}${eps.length > 3 ? ` +${eps.length - 3}` : ""}`;
}

export function queueFormatters(locale: string) {
  const unit = (u: string) => new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "narrow", maximumFractionDigits: 1 });
  const gb = unit("gigabyte");
  const mb = unit("megabyte");
  const hour = new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "narrow" });
  const minute = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "narrow" });
  const day = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "narrow" });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return {
    size: (bytes: number) => (bytes >= 1e9 ? gb.format(bytes / 1e9) : mb.format(Math.max(0, Math.round(bytes / 1e6)))),
    duration: (seconds: number | null) => {
      if (seconds === null) return "—";
      if (seconds >= 86_400) return `${day.format(Math.floor(seconds / 86_400))} ${hour.format(Math.floor((seconds % 86_400) / 3_600))}`;
      if (seconds >= 3_600) return `${hour.format(Math.floor(seconds / 3_600))} ${minute.format(Math.floor((seconds % 3_600) / 60))}`;
      return minute.format(Math.max(0, Math.ceil(seconds / 60)));
    },
    percent: (p: number) => pct.format(p),
  };
}
