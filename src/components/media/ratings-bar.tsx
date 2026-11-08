"use client";

import type { CSSProperties, ReactNode } from "react";
import { useHiddenRatingSources } from "./ratings-visibility";
import { useT } from "@/components/i18n/i18n-provider";

// IMDb's brand yellow (#F5C518) is unreadable on the light theme; blending it
// toward the foreground keeps the hue and lands legible on both.
const IMDB_LABEL_STYLE: CSSProperties = { color: "color-mix(in oklab, #F5C518 55%, var(--ds-fg))" };

interface RatingsBarProps {
  imdbRating?: string | null;
  imdbId?: string | null;
  imdbVotes?: string | null;
  rottenTomatoes?: string | null;
  metacritic?: string | null;
  rtAudienceScore?: string | null;
  traktRating?: string | null;
  letterboxdRating?: string | null;
  mdblistScore?: string | null;
  malRating?: string | null;
  rogerEbertRating?: string | null;
  // Jellyfin community rating (0–10, from the library sync) — only detail pages
  // supply this; the title must be in the Jellyfin library to have one.
  jellyfinRating?: string | null;
  voteAverage?: number;
  size?: "sm" | "md";

  compact?: boolean;
}

function formatVotes(raw: string): string {
  const n = parseInt(raw.replace(/,/g, ""), 10);
  if (isNaN(n)) return "";
  // Rounded to thousands first: 999,700 rounds to 1000K, which reads as 1.0M.
  const thousands = Math.round(n / 1_000);
  if (thousands >= 1_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${thousands}K`;
  return String(n);
}

// The class (or icon) for a score: the value of the first band whose minimum
// the parsed score reaches, else `below`; an unparseable score gets `invalid`.
// Every class stays a complete literal at its call site so the Tailwind scanner
// and the colour remaps still see it (guardrails 39/42).
function byThreshold<T>(
  score: string,
  parse: (s: string) => number,
  bands: ReadonlyArray<readonly [number, T]>,
  below: T,
  invalid: T,
): T {
  const n = parse(score);
  if (isNaN(n)) return invalid;
  for (const [min, value] of bands) if (n >= min) return value;
  return below;
}

const int = (s: string) => parseInt(s, 10);

function rtColor(score: string): string {
  return byThreshold(score, int, [[60, "text-red-500"]], "text-amber-400", "text-zinc-400");
}

function rtIcon(score: string): string {
  return byThreshold(score, int, [[60, "🍅"]], "🫙", "🍅");
}

// Filled badges: yellow/orange/green/red all remap to a status token, so the
// text is --ds-on-status (dark on the dark theme’s L .65–.78 fills, white on
// the light theme’s L .53–.55 ones — black fails 4.5:1 there).
// Only the neutral fallback keeps foreground-coloured text on a surface.
function metacriticBadge(score: string): string {
  return byThreshold(
    score,
    int,
    [
      [61, "bg-green-600 text-[var(--ds-on-status)]"],
      [40, "bg-yellow-500 text-[var(--ds-on-status)]"],
    ],
    "bg-red-600 text-[var(--ds-on-status)]",
    "bg-zinc-700 text-zinc-100",
  );
}

function rtAudienceColor(score: string): string {
  return byThreshold(score, int, [[60, "text-green-400"]], "text-amber-400", "text-zinc-400");
}

function traktBadge(score: string): string {
  return byThreshold(
    score,
    int,
    [
      [70, "bg-red-500 text-[var(--ds-on-status)]"],
      [50, "bg-orange-500 text-[var(--ds-on-status)]"],
    ],
    "bg-zinc-700 text-zinc-100",
    "bg-zinc-700 text-zinc-100",
  );
}

function mdblistColor(score: string): string {
  return byThreshold(score, int, [[75, "text-emerald-400"], [50, "text-yellow-400"]], "text-red-400", "text-zinc-400");
}

function letterboxdColor(score: string): string {
  return byThreshold(score, parseFloat, [[3.5, "text-emerald-400"], [2.5, "text-yellow-400"]], "text-red-400", "text-zinc-400");
}

type Translate = ReturnType<typeof useT>;

// One rating source after IMDb: the badge's tooltip, then what it shows in
// order (a label or icon, the score, an optional suffix). Every source renders
// through the same wrapper, so adding one is one entry here.
interface RatingCell {
  key: string;
  title: string;
  lead: ReactNode;
  value: ReactNode;
  suffix?: ReactNode;
}

interface CellSizes {
  textSm: string;
  textXs: string;
  iconSz: string;
}

// The sources to show, in display order; an absent or admin-hidden source is
// left out. Compact mode drops the visible source labels; a `title` on a div is
// not reliably announced, so each keeps a screen-reader name instead of reading
// as a bare number.
function ratingCells(
  p: RatingsBarProps,
  hidden: readonly string[],
  compact: boolean,
  { textSm, textXs, iconSz }: CellSizes,
  t: Translate,
): RatingCell[] {
  const shown = (value: string | null | undefined, source: string): value is string =>
    !!value && !hidden.includes(source);
  const cells: RatingCell[] = [];
  const { rottenTomatoes, rtAudienceScore, metacritic, traktRating, letterboxdRating, mdblistScore } = p;
  const { malRating, rogerEbertRating, jellyfinRating, voteAverage } = p;

  if (shown(rottenTomatoes, "rottenTomatoes")) {
    cells.push({
      key: "rt",
      title: "Rotten Tomatoes",
      lead: <span className={iconSz} role="img" aria-label="Rotten Tomatoes">{rtIcon(rottenTomatoes)}</span>,
      value: <span className={`font-semibold ${rtColor(rottenTomatoes)} ${textSm}`}>{rottenTomatoes}</span>,
    });
  }
  if (shown(rtAudienceScore, "rtAudience")) {
    cells.push({
      key: "rtAudience",
      title: t("media.ratings.rtAudience"),
      lead: <span className={iconSz} role="img" aria-label={t("media.ratings.rtAudience")}>🍿</span>,
      value: <span className={`font-semibold ${rtAudienceColor(rtAudienceScore)} ${textSm}`}>{rtAudienceScore}</span>,
    });
  }
  if (shown(metacritic, "metacritic")) {
    cells.push({
      key: "metacritic",
      title: "Metacritic",
      lead: compact && <span className="sr-only">Metacritic</span>,
      value: (
        <span className={`font-bold rounded px-1 py-0.5 ${textXs} ${metacriticBadge(metacritic)}`}>
          {metacritic.replace("/100", "")}
        </span>
      ),
      suffix: !compact && <span className={`text-zinc-500 ${textXs}`}>MC</span>,
    });
  }
  if (shown(traktRating, "trakt")) {
    cells.push({
      key: "trakt",
      title: t("media.ratings.trakt"),
      lead: compact && <span className="sr-only">{t("media.ratings.trakt")}</span>,
      value: (
        <span className={`font-bold rounded px-1 py-0.5 ${textXs} ${traktBadge(traktRating)}`}>
          {traktRating}
        </span>
      ),
      suffix: !compact && <span className={`text-zinc-500 ${textXs}`}>TR</span>,
    });
  }
  if (shown(letterboxdRating, "letterboxd")) {
    cells.push({
      key: "letterboxd",
      title: t("media.ratings.letterboxd"),
      lead: <span className={`font-semibold ${textXs} text-zinc-400`}>LB</span>,
      value: <span className={`font-semibold ${letterboxdColor(letterboxdRating)} ${textSm}`}>{letterboxdRating}</span>,
    });
  }
  // Numeric guard, not just truthiness: MDBList's "no score" sentinel reaches
  // rows cached before the parser started rejecting it (mdblist.ts
  // aggregateScore), and "-1"/"0" are truthy strings that would print as real
  // scores. Same shape as the TMDB guard below.
  const mdblistValue = mdblistScore != null ? Number(mdblistScore) : NaN;
  if (mdblistScore && Number.isFinite(mdblistValue) && mdblistValue > 0 && !hidden.includes("mdblist")) {
    cells.push({
      key: "mdblist",
      title: t("media.ratings.mdblist"),
      lead: compact ? <span className="sr-only">{t("media.ratings.mdblist")}</span> : <span className={`text-zinc-500 ${textXs}`}>MDB</span>,
      value: <span className={`font-semibold ${mdblistColor(mdblistScore)} ${textSm}`}>{mdblistScore}</span>,
    });
  }
  if (shown(malRating, "mal")) {
    cells.push({
      key: "mal",
      title: "MyAnimeList",
      lead: <span className={`font-semibold text-sky-400 ${textXs}`}>MAL</span>,
      value: <span className={`font-semibold text-zinc-100 ${textSm}`}>{malRating}</span>,
    });
  }
  if (shown(rogerEbertRating, "rogerEbert")) {
    cells.push({
      key: "rogerEbert",
      title: "Roger Ebert",
      lead: <span className={`font-semibold text-zinc-400 ${textXs}`}>RE</span>,
      value: <span className={`font-semibold text-zinc-100 ${textSm}`}>{rogerEbertRating}</span>,
      suffix: !compact && <span className={`text-zinc-500 ${textXs}`}>/4</span>,
    });
  }
  if (shown(jellyfinRating, "jellyfin")) {
    cells.push({
      key: "jellyfin",
      title: t("media.ratings.jellyfin"),
      lead: <span className={`font-semibold ${textXs}`} style={{ color: "var(--ds-jellyfin-text)" }}>JF</span>,
      value: <span className={`font-semibold text-zinc-100 ${textSm}`}>{jellyfinRating}</span>,
      suffix: !compact && <span className={`text-zinc-500 ${textXs}`}>/10</span>,
    });
  }
  if (voteAverage && voteAverage > 0 && !hidden.includes("tmdb")) {
    cells.push({
      key: "tmdb",
      title: t("media.ratings.tmdb"),
      lead: compact ? <span className="sr-only">{t("media.ratings.tmdb")}</span> : <span className={`text-zinc-500 ${textXs}`}>TMDB</span>,
      value: <span className={`font-semibold text-yellow-400 ${textSm}`}>{voteAverage.toFixed(1)}</span>,
    });
  }
  return cells;
}

export function RatingsBar(props: RatingsBarProps) {
  const { imdbRating, imdbId, imdbVotes, size = "md", compact = false } = props;
  // Admin-hidden sources (ratingsHiddenSources Setting via the layout provider).
  const hidden = useHiddenRatingSources();
  const t = useT();

  const textSm = size === "sm" ? "text-[10px]" : "text-sm";
  const textXs = size === "sm" ? "text-[9px]"  : "text-xs";
  const gap    = size === "sm" ? "gap-x-1.5 gap-y-0.5" : "gap-4";
  const iconSz = size === "sm" ? "text-[11px]" : "text-base";

  const showImdb = !!imdbRating && !hidden.includes("imdb");
  const cells = ratingCells(props, hidden, compact, { textSm, textXs, iconSz }, t);
  if (!showImdb && cells.length === 0) return null;

  // One body for the IMDb badge, linked when there is an id.
  const imdbBody = (
    <>
      <span className={`font-bold ${textSm}`} style={IMDB_LABEL_STYLE}>IMDb</span>
      <span className={`font-semibold text-zinc-100 ${textSm}`}>{imdbRating}</span>
      {!compact && <span className={`text-zinc-500 ${textXs}`}>/10</span>}
      {!compact && imdbVotes && (
        <span className={`text-zinc-500 ${textXs}`}>({formatVotes(imdbVotes)})</span>
      )}
    </>
  );

  return (
    <div className={`flex items-center flex-wrap ${gap}`}>
      {showImdb && imdbId ? (
        <a
          href={`https://www.imdb.com/title/${encodeURIComponent(imdbId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
          title={t("media.ratings.imdb")}
          // MediaCard is a role="button" div that navigates on click; without
          // this, opening IMDb in a new tab also pushed the card's detail page.
          onClick={(e) => e.stopPropagation()}
        >
          {imdbBody}
        </a>
      ) : showImdb ? (
        <div className="flex items-center gap-0.5" title={t("media.ratings.imdb")}>
          {imdbBody}
        </div>
      ) : null}

      {cells.map((cell) => (
        <div key={cell.key} className="flex items-center gap-0.5" title={cell.title}>
          {cell.lead}
          {cell.value}
          {cell.suffix}
        </div>
      ))}
    </div>
  );
}
