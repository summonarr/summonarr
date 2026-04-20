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
  voteAverage?: number;
  size?: "sm" | "md";

  compact?: boolean;
}

function formatVotes(raw: string): string {
  const n = parseInt(raw.replace(/,/g, ""), 10);
  if (isNaN(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function rtColor(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "text-zinc-400";
  if (n >= 60) return "text-red-500";
  return "text-amber-400";
}

function rtIcon(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "🍅";
  return n >= 60 ? "🍅" : "🫙";
}

function metacriticColor(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "bg-zinc-600";
  if (n >= 61) return "bg-green-600";
  if (n >= 40) return "bg-yellow-500";
  return "bg-red-600";
}

function rtAudienceColor(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "text-zinc-400";
  if (n >= 60) return "text-green-400";
  return "text-amber-400";
}

function traktColor(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "bg-zinc-600";
  if (n >= 70) return "bg-red-700";
  if (n >= 50) return "bg-orange-600";
  return "bg-zinc-600";
}

function mdblistColor(score: string): string {
  const n = parseInt(score, 10);
  if (isNaN(n)) return "text-zinc-400";
  if (n >= 75) return "text-emerald-400";
  if (n >= 50) return "text-yellow-400";
  return "text-red-400";
}

function letterboxdColor(score: string): string {
  const n = parseFloat(score);
  if (isNaN(n)) return "text-zinc-400";
  if (n >= 3.5) return "text-emerald-400";
  if (n >= 2.5) return "text-yellow-400";
  return "text-red-400";
}

export function RatingsBar({
  imdbRating,
  imdbId,
  imdbVotes,
  rottenTomatoes,
  metacritic,
  rtAudienceScore,
  traktRating,
  letterboxdRating,
  mdblistScore,
  malRating,
  rogerEbertRating,
  voteAverage,
  size = "md",
  compact = false,
}: RatingsBarProps) {
  const hasAny = imdbRating || rottenTomatoes || metacritic || rtAudienceScore || traktRating ||
    letterboxdRating || mdblistScore || malRating || rogerEbertRating || (voteAverage && voteAverage > 0);
  if (!hasAny) return null;

  const textSm = size === "sm" ? "text-[10px]" : "text-sm";
  const textXs = size === "sm" ? "text-[9px]"  : "text-xs";
  const gap    = size === "sm" ? "gap-x-1.5 gap-y-0.5" : "gap-4";
  const iconSz = size === "sm" ? "text-[11px]" : "text-base";

  return (
    <div className={`flex items-center flex-wrap ${gap}`}>
      {imdbRating && imdbId ? (
        <a
          href={`https://www.imdb.com/title/${imdbId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 group"
          title="IMDb rating"
        >
          <span className={`font-bold text-[#F5C518] ${textSm}`}>IMDb</span>
          <span className={`font-semibold text-white ${textSm}`}>{imdbRating}</span>
          {!compact && <span className={`text-zinc-500 ${textXs}`}>/10</span>}
          {!compact && imdbVotes && (
            <span className={`text-zinc-500 ${textXs}`}>({formatVotes(imdbVotes)})</span>
          )}
        </a>
      ) : imdbRating ? (
        <div className="flex items-center gap-0.5" title="IMDb rating">
          <span className={`font-bold text-[#F5C518] ${textSm}`}>IMDb</span>
          <span className={`font-semibold text-white ${textSm}`}>{imdbRating}</span>
          {!compact && <span className={`text-zinc-500 ${textXs}`}>/10</span>}
          {!compact && imdbVotes && (
            <span className={`text-zinc-500 ${textXs}`}>({formatVotes(imdbVotes)})</span>
          )}
        </div>
      ) : null}

      {rottenTomatoes && (
        <div className="flex items-center gap-0.5" title="Rotten Tomatoes">
          <span className={iconSz}>{rtIcon(rottenTomatoes)}</span>
          <span className={`font-semibold ${rtColor(rottenTomatoes)} ${textSm}`}>{rottenTomatoes}</span>
        </div>
      )}

      {rtAudienceScore && (
        <div className="flex items-center gap-0.5" title="Rotten Tomatoes Audience">
          <span className={iconSz}>🍿</span>
          <span className={`font-semibold ${rtAudienceColor(rtAudienceScore)} ${textSm}`}>{rtAudienceScore}</span>
        </div>
      )}

      {metacritic && (
        <div className="flex items-center gap-0.5" title="Metacritic">
          <span className={`font-bold text-white rounded px-1 py-0.5 ${textXs} ${metacriticColor(metacritic)}`}>
            {metacritic.replace("/100", "")}
          </span>
          {!compact && <span className={`text-zinc-500 ${textXs}`}>MC</span>}
        </div>
      )}

      {traktRating && (
        <div className="flex items-center gap-0.5" title="Trakt rating">
          <span className={`font-bold text-white rounded px-1 py-0.5 ${textXs} ${traktColor(traktRating)}`}>
            {traktRating}
          </span>
          {!compact && <span className={`text-zinc-500 ${textXs}`}>TR</span>}
        </div>
      )}

      {letterboxdRating && (
        <div className="flex items-center gap-0.5" title="Letterboxd average">
          <span className={`font-semibold ${textXs} text-zinc-400`}>LB</span>
          <span className={`font-semibold ${letterboxdColor(letterboxdRating)} ${textSm}`}>{letterboxdRating}</span>
        </div>
      )}

      {mdblistScore && (
        <div className="flex items-center gap-0.5" title="MDBList score">
          {!compact && <span className={`text-zinc-500 ${textXs}`}>MDB</span>}
          <span className={`font-semibold ${mdblistColor(mdblistScore)} ${textSm}`}>{mdblistScore}</span>
        </div>
      )}

      {malRating && (
        <div className="flex items-center gap-0.5" title="MyAnimeList">
          <span className={`font-semibold text-blue-400 ${textXs}`}>MAL</span>
          <span className={`font-semibold text-white ${textSm}`}>{malRating}</span>
        </div>
      )}

      {rogerEbertRating && (
        <div className="flex items-center gap-0.5" title="Roger Ebert">
          <span className={`font-semibold text-zinc-400 ${textXs}`}>RE</span>
          <span className={`font-semibold text-white ${textSm}`}>{rogerEbertRating}</span>
          {!compact && <span className={`text-zinc-500 ${textXs}`}>/4</span>}
        </div>
      )}

      {voteAverage && voteAverage > 0 ? (
        <div className="flex items-center gap-0.5" title="TMDB score">
          {!compact && <span className={`text-zinc-500 ${textXs}`}>TMDB</span>}
          <span className={`font-semibold text-yellow-400 ${textSm}`}>{voteAverage.toFixed(1)}</span>
        </div>
      ) : null}
    </div>
  );
}
