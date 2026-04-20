"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FixMatchButton } from "@/components/admin/fix-match-button";
import { posterUrl } from "@/lib/tmdb-types";

interface RequestSummary {
  total: number;
  statuses: string[];
}

export interface DiffItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
  overview: string | null;
  voteAverage: number | null;

  relPath: string | null;
  // True when the file path came from Radarr/Sonarr rather than the library item itself
  relPathFromArr: boolean;
  // The TMDB ID Radarr/Sonarr resolved for this file (may differ from the library item's tmdbId)
  arrTmdbId: number | null;
  // Library's tmdbId disagrees with arrTmdbId — fix-match is needed
  arrMismatch: boolean;

  inArr: boolean;
  requests: RequestSummary;
}

export interface BadMatchSideData {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
}

export interface ClientBadMatch {
  relativePath: string;
  plex: BadMatchSideData;
  plexRatingKey: string | null;
  jellyfin: BadMatchSideData;
  jellyfinItemId: string | null;
  arrTmdbId: number | null;
  arrVerdict: "plex" | "jellyfin" | null;
}

type ArrFilter     = "all" | "mismatch" | "not_in_arr" | "matches";
type RequestFilter = "all" | "has_requests";

const STATUS_STYLES: Record<string, string> = {
  PENDING:   "bg-yellow-500/10 text-yellow-400 border-yellow-600/30",
  APPROVED:  "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  AVAILABLE: "bg-green-500/10  text-green-400  border-green-600/30",
  DECLINED:  "bg-red-500/10    text-red-400    border-red-700/30",
};

function MediaCard({
  item,
  highlight = false,
  server,
}: {
  item: DiffItem;
  highlight?: boolean;
  server?: "plex" | "jellyfin";
}) {
  const thumb = posterUrl(item.posterPath, "w342");
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;
  const typeLabel    = item.mediaType === "MOVIE" ? "Movie" : "TV Show";

  return (
    <div
      id={`item-${item.tmdbId}-${item.mediaType}`}
      className={`flex gap-3 rounded-lg bg-zinc-900 border p-3 ${
        highlight ? "border-indigo-500/60 ring-1 ring-indigo-500/40" : "border-zinc-800"
      }`}
    >
      <div className="shrink-0">
        {thumb ? (
          <Image src={thumb} alt={displayTitle} width={56} height={84} className="rounded object-cover" unoptimized />
        ) : (
          <div className="w-14 h-[84px] rounded bg-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
            No art
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="font-medium text-white text-sm leading-snug truncate">{displayTitle}</span>
          {item.releaseYear && (
            <span className="text-xs text-zinc-500 shrink-0 mt-0.5">{item.releaseYear}</span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${
            item.mediaType === "MOVIE"
              ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
              : "bg-teal-500/10 text-teal-400 border-teal-500/20"
          }`}>
            {typeLabel}
          </span>
          {item.voteAverage != null && item.voteAverage > 0 && (
            <span className="text-xs text-zinc-400">⭐ {item.voteAverage.toFixed(1)}</span>
          )}
          <a
            href={`https://www.themoviedb.org/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            TMDB ↗
          </a>
        </div>

        {item.overview && (
          <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed">{item.overview}</p>
        )}

        {item.relPath && (
          <p className="text-[10px] text-zinc-500 font-mono break-all pt-0.5">
            {item.relPath}
            {item.relPathFromArr && (
              <span className="ml-1.5 not-italic font-sans text-zinc-600">(Sonarr path)</span>
            )}
          </p>
        )}

        {item.arrMismatch && item.arrTmdbId !== null ? (
          <div className="pt-0.5 space-y-1">
            <p className="text-[10px] font-mono text-orange-500">
              {item.mediaType === "MOVIE" ? "Radarr" : "Sonarr"}: TMDB #{item.arrTmdbId} ⚠ mismatch
            </p>
            {server && (
              <FixMatchButton
                server={server}
                tmdbId={item.tmdbId}
                mediaType={item.mediaType}
                correctTmdbId={item.arrTmdbId}
                arrTmdbId={item.arrTmdbId}
                label={`Fix ${server === "plex" ? "Plex" : "Jellyfin"} → TMDB #${item.arrTmdbId}`}
              />
            )}
          </div>
        ) : item.inArr ? (
          <p className="text-[10px] font-mono text-emerald-600 pt-0.5">
            {item.mediaType === "MOVIE" ? "Radarr" : "Sonarr"} ✓
          </p>
        ) : item.relPath ? (
          <p className="text-[10px] text-zinc-600 font-mono pt-0.5">
            Not in {item.mediaType === "MOVIE" ? "Radarr" : "Sonarr"}
          </p>
        ) : null}

        {item.requests.total > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            <span className="text-xs text-zinc-600">
              {item.requests.total} request{item.requests.total !== 1 ? "s" : ""}:
            </span>
            {item.requests.statuses.map((s) => (
              <span
                key={s}
                className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                  STATUS_STYLES[s] ?? "bg-zinc-800 text-zinc-400 border-zinc-700"
                }`}
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BadMatchSide({
  item,
  label,
  accent,
  filePath,
}: {
  item: BadMatchSideData;
  label: string;
  accent: "yellow" | "purple";
  filePath?: string | null;
}) {
  const thumb        = posterUrl(item.posterPath, "w342");
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;
  const borderClass  = accent === "yellow" ? "border-yellow-600/30" : "border-purple-600/30";
  const badgeClass   = accent === "yellow"
    ? "bg-yellow-500/10 text-yellow-400 border-yellow-600/30"
    : "bg-purple-500/10 text-purple-400 border-purple-600/30";

  const fileName = filePath ? filePath.split("/").pop() : null;
  const dirPath  = filePath && fileName ? filePath.slice(0, filePath.length - fileName.length).replace(/\/$/, "") : null;

  return (
    <div className={`flex-1 min-w-0 rounded-lg border ${borderClass} bg-zinc-950 p-3 flex gap-3`}>
      <div className="shrink-0">
        {thumb ? (
          <Image src={thumb} alt={displayTitle} width={48} height={72} className="rounded object-cover" unoptimized />
        ) : (
          <div className="w-12 h-[72px] rounded bg-zinc-800 flex items-center justify-center text-zinc-600 text-[10px]">
            No art
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded border font-semibold ${badgeClass}`}>
          {label}
        </span>
        <p className="text-sm font-medium text-white leading-snug truncate">{displayTitle}</p>
        {item.releaseYear && <p className="text-xs text-zinc-500">{item.releaseYear}</p>}
        <a
          href={`https://www.themoviedb.org/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors font-mono"
        >
          TMDB #{item.tmdbId} ↗
        </a>
        {fileName && (
          <div className="pt-0.5">
            <p className="text-[10px] font-mono text-zinc-300 break-all leading-snug">{fileName}</p>
            {dirPath && (
              <p className="text-[10px] font-mono text-zinc-600 break-all leading-snug">{dirPath}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BadMatchCard({ match }: { match: ClientBadMatch }) {
  const { arrVerdict, arrTmdbId } = match;
  const plexCorrectId     = arrTmdbId ?? match.jellyfin.tmdbId;
  const jellyfinCorrectId = arrTmdbId ?? match.plex.tmdbId;

  return (
    <div className="rounded-lg border border-orange-600/30 bg-zinc-900 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-orange-400 text-xs font-semibold mt-0.5">⚠</span>
        <p className="text-[11px] text-zinc-400 font-mono break-all leading-relaxed">
          {match.relativePath}
        </p>
      </div>

      {arrVerdict && arrTmdbId && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-emerald-500/5 border border-emerald-500/20">
          <span className="text-emerald-400 text-xs">✓</span>
          <p className="text-[11px] text-emerald-300">
            Radarr/Sonarr confirms TMDB #{arrTmdbId} is correct —{" "}
            <span className="font-semibold capitalize">{arrVerdict}</span> has the wrong match.
          </p>
        </div>
      )}
      {!arrVerdict && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-800/50 border border-zinc-700/50">
          <span className="text-zinc-500 text-xs">?</span>
          <p className="text-[11px] text-zinc-500">
            {arrTmdbId === null
              ? "Radarr/Sonarr doesn't have this file — both servers shown, pick the correct one."
              : "Both servers disagree with Radarr/Sonarr — manual review needed."}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <div className={`flex-1 min-w-0 space-y-2 ${arrVerdict === "jellyfin" ? "opacity-40" : ""}`}>
          <BadMatchSide item={match.plex} label="Plex" accent="yellow" filePath={match.relativePath} />
          {arrVerdict === "plex" || arrVerdict === null ? (
            match.plexRatingKey ? (
              <FixMatchButton
                server="plex"
                tmdbId={match.plex.tmdbId}
                mediaType={match.plex.mediaType}
                correctTmdbId={plexCorrectId}
                arrTmdbId={match.arrTmdbId}
                label={`Fix Plex → TMDB #${plexCorrectId}`}
              />
            ) : (
              <span className="text-[9px] text-zinc-600">Re-sync to enable fix</span>
            )
          ) : (
            <span className="text-[9px] text-emerald-600">Correct match ✓</span>
          )}
        </div>

        <div className={`flex-1 min-w-0 space-y-2 ${arrVerdict === "plex" ? "opacity-40" : ""}`}>
          <BadMatchSide item={match.jellyfin} label="Jellyfin" accent="purple" filePath={match.relativePath} />
          {arrVerdict === "jellyfin" || arrVerdict === null ? (
            match.jellyfinItemId ? (
              <FixMatchButton
                server="jellyfin"
                tmdbId={match.jellyfin.tmdbId}
                mediaType={match.jellyfin.mediaType}
                correctTmdbId={jellyfinCorrectId}
                arrTmdbId={match.arrTmdbId}
                label={`Fix Jellyfin → TMDB #${jellyfinCorrectId}`}
              />
            ) : (
              <span className="text-[9px] text-zinc-600">Re-sync to enable fix</span>
            )
          ) : (
            <span className="text-[9px] text-emerald-600">Correct match ✓</span>
          )}
        </div>
      </div>
    </div>
  );
}

function FixAllArrButton({ matches }: { matches: ClientBadMatch[] }) {
  const router  = useRouter();
  const fixable = matches.filter((m) => m.arrVerdict !== null && m.arrTmdbId !== null);

  const [state, setRunState] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, failed: 0, total: 0 });

  const handleFixAll = useCallback(async () => {
    setRunState("running");
    setProgress({ done: 0, failed: 0, total: fixable.length });

    let done = 0;
    let failed = 0;

    for (const match of fixable) {
      const { arrVerdict, arrTmdbId } = match;
      if (!arrVerdict || arrTmdbId === null) continue;

      const wrongItem = arrVerdict === "plex" ? match.plex : match.jellyfin;
      try {
        const res = await fetch("/api/admin/fix-match", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            server:        arrVerdict,
            tmdbId:        wrongItem.tmdbId,
            mediaType:     wrongItem.mediaType,
            correctTmdbId: arrTmdbId,
          }),
        });
        const json = await res.json() as { ok?: boolean };
        if (res.ok && json.ok) { done++; } else { failed++; }
      } catch {
        failed++;
      }
      setProgress({ done: done + failed, failed, total: fixable.length });
    }

    setRunState("done");
    if (done > 0) router.refresh();
  }, [fixable, router]);

  if (fixable.length === 0) return null;

  return (
    <button
      onClick={handleFixAll}
      disabled={state === "running"}
      className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border font-medium transition-colors
        bg-emerald-500/10 border-emerald-600/30 text-emerald-400
        hover:bg-emerald-500/20 hover:border-emerald-500/50
        disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {state === "idle"    && `Fix all ${fixable.length} where Arr agrees`}
      {state === "running" && `Fixing ${progress.done}/${progress.total}…`}
      {state === "done"    && `Done — ${progress.total - progress.failed}/${progress.total} fixed`}
    </button>
  );
}

export function LibraryDiffClient({
  onlyPlex,
  onlyJellyfin,
  badMatches,
  plexConfigured,
  jellyfinConfigured,
  highlightServer,
  highlightKey,
}: {
  onlyPlex:           DiffItem[];
  onlyJellyfin:       DiffItem[];
  badMatches:         ClientBadMatch[];
  plexConfigured:     boolean;
  jellyfinConfigured: boolean;
  highlightServer:    string | null;
  highlightKey:       string | null;
}) {
  const [search,        setSearch]        = useState("");
  const [arrFilter,     setArrFilter]     = useState<ArrFilter>("all");
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("all");

  function applyFilters(items: DiffItem[]): DiffItem[] {
    let result = items;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (i) =>
          (i.title ?? "").toLowerCase().includes(q) ||
          (i.relPath ?? "").toLowerCase().includes(q),
      );
    }
    if (arrFilter === "mismatch")   result = result.filter((i) => i.arrMismatch);
    if (arrFilter === "not_in_arr") result = result.filter((i) => !i.inArr);
    if (arrFilter === "matches")    result = result.filter((i) => i.inArr && !i.arrMismatch);
    if (requestFilter === "has_requests") result = result.filter((i) => i.requests.total > 0);
    return result;
  }

  function filterBadMatches(items: ClientBadMatch[]): ClientBadMatch[] {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (m) =>
        m.relativePath.toLowerCase().includes(q) ||
        (m.plex.title     ?? "").toLowerCase().includes(q) ||
        (m.jellyfin.title ?? "").toLowerCase().includes(q),
    );
  }

  const filteredPlex       = applyFilters(onlyPlex);
  const filteredJellyfin   = applyFilters(onlyJellyfin);
  const filteredBadMatches = filterBadMatches(badMatches);

  const filtersActive = search.trim() || arrFilter !== "all" || requestFilter !== "all";

  const arrFilterOptions: { value: ArrFilter; label: string }[] = [
    { value: "all",        label: "All" },
    { value: "mismatch",   label: "Arr mismatch" },
    { value: "not_in_arr", label: "Not in Arr" },
    { value: "matches",    label: "Arr matches" },
  ];

  return (
    <div className="space-y-6">

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search title or path…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200
            placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 w-56"
        />

        <div className="flex items-center gap-1">
          {arrFilterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setArrFilter(opt.value)}
              className={`h-8 text-xs px-3 rounded-full border font-medium transition-colors ${
                arrFilter === opt.value
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-800"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setRequestFilter((f) => (f === "all" ? "has_requests" : "all"))}
          className={`h-8 text-xs px-3 rounded-full border font-medium transition-colors ${
            requestFilter === "has_requests"
              ? "bg-indigo-600 border-indigo-500 text-white"
              : "border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-800"
          }`}
        >
          Has requests
        </button>
      </div>

      {filteredBadMatches.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-500/10 border border-orange-600/30 text-orange-400">
              Suspected bad matches
            </span>
            <span className="text-zinc-500 text-sm">
              {filteredBadMatches.length} item{filteredBadMatches.length !== 1 ? "s" : ""}
              {filteredBadMatches.length !== badMatches.length && ` (${badMatches.length} total)`}
              {" — same file, different TMDB ID"}
            </span>
            <FixAllArrButton matches={filteredBadMatches} />
          </div>
          <div className="space-y-3">
            {filteredBadMatches.map((match) => (
              <BadMatchCard key={match.relativePath} match={match} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">

        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-500/10 border border-yellow-600/30 text-yellow-400">
              Plex only
            </span>
            <span className="text-zinc-500 text-sm">
              {filteredPlex.length} item{filteredPlex.length !== 1 ? "s" : ""}
              {filteredPlex.length !== onlyPlex.length && ` (${onlyPlex.length} total)`}
            </span>
            {!plexConfigured && <span className="text-zinc-600 text-xs">(not synced)</span>}
          </div>
          {filteredPlex.length === 0 ? (
            <p className="text-sm text-zinc-600 px-1">
              {filtersActive
                ? "No items match your filters."
                : jellyfinConfigured
                  ? "Jellyfin has all of Plex's content."
                  : "Plex not synced."}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredPlex.map((item) => (
                <MediaCard
                  key={`${item.tmdbId}:${item.mediaType}`}
                  item={item}
                  server="plex"
                  highlight={
                    highlightServer === "plex" &&
                    highlightKey === `${item.tmdbId}:${item.mediaType}`
                  }
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/10 border border-purple-600/30 text-purple-400">
              Jellyfin only
            </span>
            <span className="text-zinc-500 text-sm">
              {filteredJellyfin.length} item{filteredJellyfin.length !== 1 ? "s" : ""}
              {filteredJellyfin.length !== onlyJellyfin.length && ` (${onlyJellyfin.length} total)`}
            </span>
            {!jellyfinConfigured && <span className="text-zinc-600 text-xs">(not synced)</span>}
          </div>
          {filteredJellyfin.length === 0 ? (
            <p className="text-sm text-zinc-600 px-1">
              {filtersActive
                ? "No items match your filters."
                : plexConfigured
                  ? "Plex has all of Jellyfin's content."
                  : "Jellyfin not synced."}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredJellyfin.map((item) => (
                <MediaCard
                  key={`${item.tmdbId}:${item.mediaType}`}
                  item={item}
                  server="jellyfin"
                  highlight={
                    highlightServer === "jellyfin" &&
                    highlightKey === `${item.tmdbId}:${item.mediaType}`
                  }
                />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
