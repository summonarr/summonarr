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

const PLEX_TINT     = "var(--ds-plex)";
const JELLYFIN_TINT = "oklch(0.72 0.16 305)";

function statusChip(status: string) {
  switch (status) {
    case "PENDING":   return "ds-chip ds-chip-pending";
    case "APPROVED":  return "ds-chip ds-chip-approved";
    case "AVAILABLE": return "ds-chip ds-chip-approved";
    case "DECLINED":  return "ds-chip ds-chip-declined";
    default:          return "ds-chip";
  }
}

function MediaCard({
  item,
  highlight = false,
  server,
}: {
  item: DiffItem;
  highlight?: boolean;
  server?: "plex" | "jellyfin";
}) {
  const thumb        = posterUrl(item.posterPath, "w342");
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;
  const typeLabel    = item.mediaType === "MOVIE" ? "MOVIE" : "TV";
  const arrName      = item.mediaType === "MOVIE" ? "Radarr" : "Sonarr";

  return (
    <div
      id={`item-${item.tmdbId}-${item.mediaType}`}
      className="flex gap-3"
      style={{
        padding: 12,
        background: "var(--ds-bg-2)",
        border: highlight
          ? `1px solid var(--ds-accent-ring)`
          : "1px solid var(--ds-border)",
        borderRadius: 8,
        boxShadow: highlight ? "0 0 0 1px var(--ds-accent-ring)" : undefined,
      }}
    >
      <div className="shrink-0">
        {thumb ? (
          <Image
            src={thumb}
            alt={displayTitle}
            width={56}
            height={84}
            className="rounded object-cover"
            style={{ border: "1px solid var(--ds-border)" }}
            unoptimized
          />
        ) : (
          <div
            className="ds-mono flex items-center justify-center"
            style={{
              width: 56,
              height: 84,
              borderRadius: 4,
              background:
                "repeating-linear-gradient(135deg, var(--ds-bg-3) 0 10px, var(--ds-bg-2) 10px 20px)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-subtle)",
              fontSize: 9,
            }}
          >
            POSTER
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span
            className="font-medium truncate"
            style={{ fontSize: 13.5, color: "var(--ds-fg)", lineHeight: 1.3 }}
          >
            {displayTitle}
          </span>
          {item.releaseYear && (
            <span
              className="ds-mono shrink-0"
              style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
            >
              {item.releaseYear}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="ds-chip"
            style={{
              fontSize: 9.5,
              textTransform: "uppercase",
              padding: "1px 6px",
            }}
          >
            {typeLabel}
          </span>
          {item.voteAverage != null && item.voteAverage > 0 && (
            <span
              className="ds-mono"
              style={{ fontSize: 10.5, color: "var(--ds-fg-muted)" }}
            >
              ★ {item.voteAverage.toFixed(1)}
            </span>
          )}
          <a
            href={`https://www.themoviedb.org/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ds-mono transition-colors"
            style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
          >
            TMDB #{item.tmdbId} ↗
          </a>
        </div>

        {item.overview && (
          <p
            className="line-clamp-2"
            style={{
              margin: 0,
              fontSize: 11.5,
              color: "var(--ds-fg-subtle)",
              lineHeight: 1.45,
            }}
          >
            {item.overview}
          </p>
        )}

        {item.relPath && (
          <p
            className="ds-mono break-all"
            style={{
              margin: 0,
              fontSize: 10,
              color: "var(--ds-fg-subtle)",
              lineHeight: 1.4,
            }}
          >
            {item.relPath}
            {item.relPathFromArr && (
              <span className="not-italic" style={{ fontFamily: "inherit", color: "var(--ds-fg-disabled)", marginLeft: 6 }}>
                (Sonarr path)
              </span>
            )}
          </p>
        )}

        {item.arrMismatch && item.arrTmdbId !== null ? (
          <div style={{ marginTop: 2 }} className="flex items-center gap-2 flex-wrap">
            <span className="ds-mono" style={{ fontSize: 10, color: "var(--ds-warning)" }}>
              {arrName}: TMDB #{item.arrTmdbId} ⚠ MISMATCH
            </span>
            {server && (
              <FixMatchButton
                server={server}
                tmdbId={item.tmdbId}
                mediaType={item.mediaType}
                correctTmdbId={item.arrTmdbId}
                arrTmdbId={item.arrTmdbId}
                label={`Fix ${server === "plex" ? "Plex" : "Jellyfin"} → #${item.arrTmdbId}`}
              />
            )}
          </div>
        ) : item.inArr ? (
          <span className="ds-mono" style={{ marginTop: 2, fontSize: 10, color: "var(--ds-success)" }}>
            {arrName} ✓
          </span>
        ) : item.relPath ? (
          <span className="ds-mono" style={{ marginTop: 2, fontSize: 10, color: "var(--ds-fg-subtle)" }}>
            Not in {arrName}
          </span>
        ) : null}

        {item.requests.total > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: 2 }}>
            <span
              className="ds-mono uppercase"
              style={{ fontSize: 10, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}
            >
              {item.requests.total} request{item.requests.total !== 1 ? "s" : ""}
            </span>
            {item.requests.statuses.map((s) => (
              <span
                key={s}
                className={statusChip(s)}
                style={{ fontSize: 9.5, padding: "1px 6px" }}
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
  tint,
  filePath,
}: {
  item: BadMatchSideData;
  label: string;
  tint: string;
  filePath?: string | null;
}) {
  const thumb        = posterUrl(item.posterPath, "w342");
  const displayTitle = item.title || `TMDB #${item.tmdbId}`;

  const fileName = filePath ? filePath.split("/").pop() : null;
  const dirPath  = filePath && fileName
    ? filePath.slice(0, filePath.length - fileName.length).replace(/\/$/, "")
    : null;

  return (
    <div
      className="flex-1 min-w-0 flex"
      style={{
        padding: 12,
        gap: 10,
        background: "var(--ds-bg-inset, var(--ds-bg))",
        border: `1px solid color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
        borderRadius: 8,
      }}
    >
      <div className="shrink-0">
        {thumb ? (
          <Image
            src={thumb}
            alt={displayTitle}
            width={48}
            height={72}
            className="rounded object-cover"
            style={{ border: "1px solid var(--ds-border)" }}
            unoptimized
          />
        ) : (
          <div
            style={{
              width: 48,
              height: 72,
              borderRadius: 4,
              background:
                "repeating-linear-gradient(135deg, var(--ds-bg-3) 0 8px, var(--ds-bg-2) 8px 16px)",
              border: "1px solid var(--ds-border)",
            }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          className="ds-chip self-start"
          style={{
            background: `color-mix(in oklab, ${tint} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
            color: tint,
            fontSize: 9.5,
            padding: "1px 7px",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span className="font-medium truncate" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
          {displayTitle}
        </span>
        <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>
          {item.releaseYear ? `${item.releaseYear} · ` : ""}
          <a
            href={`https://www.themoviedb.org/${item.mediaType === "MOVIE" ? "movie" : "tv"}/${item.tmdbId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            TMDB #{item.tmdbId} ↗
          </a>
        </span>
        {fileName && (
          <div style={{ marginTop: 4 }}>
            <p className="ds-mono break-all" style={{ margin: 0, fontSize: 10, color: "var(--ds-fg)", lineHeight: 1.35 }}>
              {fileName}
            </p>
            {dirPath && (
              <p className="ds-mono break-all" style={{ margin: 0, fontSize: 9.5, color: "var(--ds-fg-subtle)", lineHeight: 1.35 }}>
                {dirPath}
              </p>
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
    <div
      style={{
        padding: 14,
        background: "var(--ds-bg-2)",
        border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, var(--ds-border))",
        borderRadius: 8,
      }}
    >
      <div className="flex items-start gap-2" style={{ marginBottom: 10 }}>
        <span style={{ color: "var(--ds-warning)", fontWeight: 600, fontSize: 12 }}>⚠</span>
        <p
          className="ds-mono break-all"
          style={{ margin: 0, fontSize: 11, color: "var(--ds-fg-muted)", lineHeight: 1.5 }}
        >
          {match.relativePath}
        </p>
      </div>

      {arrVerdict && arrTmdbId ? (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            marginBottom: 12,
            borderRadius: 6,
            background: "color-mix(in oklab, var(--ds-success) 10%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-success) 28%, var(--ds-border))",
          }}
        >
          <span style={{ color: "var(--ds-success)", fontSize: 12 }}>✓</span>
          <p style={{ margin: 0, fontSize: 11, color: "var(--ds-success)" }}>
            Radarr/Sonarr confirms TMDB #{arrTmdbId} is correct —{" "}
            <span className="font-semibold capitalize">{arrVerdict}</span> has the wrong match.
          </p>
        </div>
      ) : (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "6px 10px",
            marginBottom: 12,
            borderRadius: 6,
            background: "var(--ds-bg-3)",
            border: "1px solid var(--ds-border)",
          }}
        >
          <span style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>?</span>
          <p style={{ margin: 0, fontSize: 11, color: "var(--ds-fg-muted)" }}>
            {arrTmdbId === null
              ? "Radarr/Sonarr doesn't have this file — both servers shown, pick the correct one."
              : "Both servers disagree with Radarr/Sonarr — manual review needed."}
          </p>
        </div>
      )}

      <div className="flex gap-3 flex-wrap md:flex-nowrap">
        <div
          className="flex-1 min-w-0"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            opacity: arrVerdict === "jellyfin" ? 0.4 : 1,
          }}
        >
          <BadMatchSide item={match.plex} label="PLEX" tint={PLEX_TINT} filePath={match.relativePath} />
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
              <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-fg-subtle)" }}>
                Re-sync to enable fix
              </span>
            )
          ) : (
            <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-success)" }}>
              Correct match ✓
            </span>
          )}
        </div>

        <div
          className="flex-1 min-w-0"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            opacity: arrVerdict === "plex" ? 0.4 : 1,
          }}
        >
          <BadMatchSide item={match.jellyfin} label="JELLYFIN" tint={JELLYFIN_TINT} filePath={match.relativePath} />
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
              <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-fg-subtle)" }}>
                Re-sync to enable fix
              </span>
            )
          ) : (
            <span className="ds-mono" style={{ fontSize: 9.5, color: "var(--ds-success)" }}>
              Correct match ✓
            </span>
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
      className="ds-tap inline-flex items-center font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        padding: "5px 12px",
        fontSize: 12,
        borderRadius: 6,
        background: "color-mix(in oklab, var(--ds-success) 14%, transparent)",
        border: "1px solid color-mix(in oklab, var(--ds-success) 35%, var(--ds-border))",
        color: "var(--ds-success)",
      }}
    >
      {state === "idle"    && `Fix all ${fixable.length} where Arr agrees`}
      {state === "running" && `Fixing ${progress.done}/${progress.total}…`}
      {state === "done"    && `Done — ${progress.total - progress.failed}/${progress.total} fixed`}
    </button>
  );
}

function ArrFilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="ds-tap font-medium transition-colors"
      style={{
        padding: "5px 12px",
        fontSize: 12,
        borderRadius: 999,
        background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
        color: active ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
        border: active ? "1px solid var(--ds-accent)" : "1px solid var(--ds-border)",
      }}
    >
      {children}
    </button>
  );
}

function DiffColumn({
  label,
  tint,
  items,
  totalBefore,
  configured,
  otherServer,
  filtersActive,
  server,
  highlightServer,
  highlightKey,
}: {
  label: string;
  tint: string;
  items: DiffItem[];
  totalBefore: number;
  configured: boolean;
  otherServer: "plex" | "jellyfin";
  filtersActive: boolean;
  server: "plex" | "jellyfin";
  highlightServer: string | null;
  highlightKey: string | null;
}) {
  const otherConfiguredMsg = otherServer === "plex"
    ? "Plex has all of Jellyfin's content."
    : "Jellyfin has all of Plex's content.";
  const emptyMsg = !configured
    ? `${server === "plex" ? "Plex" : "Jellyfin"} not synced.`
    : otherConfiguredMsg;

  return (
    <div>
      <div className="flex items-center gap-2.5 flex-wrap" style={{ marginBottom: 12 }}>
        <span
          className="ds-chip"
          style={{
            background: `color-mix(in oklab, ${tint} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${tint} 35%, var(--ds-border))`,
            color: tint,
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 8px",
            fontWeight: 600,
          }}
        >
          {label}
        </span>
        <span
          className="ds-mono"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}
        >
          {items.length} ITEM{items.length !== 1 ? "S" : ""}
          {items.length !== totalBefore ? ` / ${totalBefore}` : ""}
        </span>
      </div>

      {items.length === 0 ? (
        <div
          style={{
            padding: 18,
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            color: "var(--ds-fg-subtle)",
            fontSize: 13,
          }}
        >
          {filtersActive ? "No items match your filters." : emptyMsg}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((item) => (
            <MediaCard
              key={`${item.tmdbId}:${item.mediaType}`}
              item={item}
              server={server}
              highlight={
                highlightServer === server &&
                highlightKey === `${item.tmdbId}:${item.mediaType}`
              }
            />
          ))}
        </div>
      )}
    </div>
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

  const filtersActive = !!search.trim() || arrFilter !== "all" || requestFilter !== "all";

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
          className="focus:outline-none"
          style={{
            height: 32,
            width: 260,
            padding: "0 12px",
            fontSize: 13,
            borderRadius: 8,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            color: "var(--ds-fg)",
          }}
        />

        <div className="flex items-center gap-1.5">
          {arrFilterOptions.map((opt) => (
            <ArrFilterButton
              key={opt.value}
              active={arrFilter === opt.value}
              onClick={() => setArrFilter(opt.value)}
            >
              {opt.label}
            </ArrFilterButton>
          ))}
        </div>

        <ArrFilterButton
          active={requestFilter === "has_requests"}
          onClick={() => setRequestFilter((f) => (f === "all" ? "has_requests" : "all"))}
        >
          Has requests
        </ArrFilterButton>
      </div>

      {filteredBadMatches.length > 0 && (
        <section>
          <div className="flex items-center gap-2.5 flex-wrap" style={{ marginBottom: 12 }}>
            <span
              className="ds-chip"
              style={{
                background: "color-mix(in oklab, var(--ds-warning) 14%, transparent)",
                borderColor: "color-mix(in oklab, var(--ds-warning) 35%, var(--ds-border))",
                color: "var(--ds-warning)",
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "2px 8px",
                fontWeight: 600,
              }}
            >
              Suspected bad matches
            </span>
            <span
              className="ds-mono"
              style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.04em" }}
            >
              {filteredBadMatches.length} ITEM{filteredBadMatches.length !== 1 ? "S" : ""}
              {filteredBadMatches.length !== badMatches.length && ` / ${badMatches.length}`} · SAME FILE · DIFFERENT TMDB ID
            </span>
            <div style={{ marginLeft: "auto" }}>
              <FixAllArrButton matches={filteredBadMatches} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {filteredBadMatches.map((match) => (
              <BadMatchCard key={match.relativePath} match={match} />
            ))}
          </div>
        </section>
      )}

      <div className="ds-two-up" style={{ gap: 20 }}>
        <DiffColumn
          label="Plex only"
          tint={PLEX_TINT}
          items={filteredPlex}
          totalBefore={onlyPlex.length}
          configured={plexConfigured}
          otherServer="jellyfin"
          filtersActive={filtersActive}
          server="plex"
          highlightServer={highlightServer}
          highlightKey={highlightKey}
        />
        <DiffColumn
          label="Jellyfin only"
          tint={JELLYFIN_TINT}
          items={filteredJellyfin}
          totalBefore={onlyJellyfin.length}
          configured={jellyfinConfigured}
          otherServer="plex"
          filtersActive={filtersActive}
          server="jellyfin"
          highlightServer={highlightServer}
          highlightKey={highlightKey}
        />
      </div>
    </div>
  );
}
