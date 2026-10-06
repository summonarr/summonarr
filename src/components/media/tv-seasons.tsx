"use client";

import { useState, useCallback } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Image from "next/image";
import { ChevronDown, CheckCircle, Circle, Loader2, Tv2, Calendar } from "@/components/icons";
import { cn } from "@/lib/utils";
import { posterUrl, stillUrl, type TmdbSeason, type TmdbEpisode } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { DetailActionButton } from "./detail-action-button";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

interface TVSeasonsProps {
  tmdbId: number;
  seasons: TmdbSeason[];

  ownedBySeason: Record<number, number[]>;
}

type LoadState = "idle" | "loading" | "ready" | "error";

interface SeasonState {
  expanded: boolean;
  loadState: LoadState;
  episodes: TmdbEpisode[];

  owned: Set<number>;
}

// Formats in the active UI locale. The call site below still waits for
// `mounted` (guardrail 16) — the date path stays client-only as before.
//
// TMDB's `air_date` is a bare date ("2024-03-05"), which `new Date` reads as
// midnight UTC. Showing that in the viewer's time zone gave the PREVIOUS day to
// everyone west of UTC, so a bare date is formatted in UTC (the same fix as
// format-release-date.ts). Only the language/locale comes from the browser.
function formatAirDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  try {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    return new Date(iso).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...(dateOnly ? { timeZone: "UTC" } : {}),
    });
  } catch {
    return iso;
  }
}

function formatRuntime(min: number | null, t: Translator): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return t("detail.runtime.minutes", { minutes: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0
    ? t("detail.runtime.hours", { hours: h })
    : t("detail.runtime.hoursMinutes", { hours: h, minutes: m });
}

// TMDB's season names are English and, almost always, generic ("Season 2",
// "Specials") — those two read in the viewer's language; a real name ("Book
// One: Water") is shown as TMDB has it. Localizing real names would cost a TMDB
// call per season (guardrail 40a keeps the overlay to one call per title).
function seasonLabel(season: { seasonNumber: number; name: string }, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const m = /^Season (\d+)$/.exec(season.name.trim());
  if (m && Number(m[1]) === season.seasonNumber) return t("detail.seasons.numbered", { number: season.seasonNumber });
  if (season.name.trim() === "Specials" && season.seasonNumber === 0) return t("detail.seasons.specials");
  return season.name;
}

// Collapsible list of seasons. Episodes (and which ones are in the library) are
// only fetched the first time a season is expanded.
export function TVSeasons({ tmdbId, seasons, ownedBySeason }: TVSeasonsProps) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<Record<number, SeasonState>>(() => {
    const init: Record<number, SeasonState> = {};
    for (const s of seasons) {
      init[s.seasonNumber] = {
        expanded: false,
        loadState: "idle",
        episodes: [],
        owned: new Set(ownedBySeason[s.seasonNumber] ?? []),
      };
    }
    return init;
  });

  const toggleSeason = useCallback(
    async (seasonNumber: number, forceReload = false) => {
      const current = state[seasonNumber];
      if (!current) return;

      // forceReload is used by the Retry button. It skips the two early returns
      // below (collapse, and "already loaded") and always re-fetches. Without it,
      // clicking Retry inside the open error panel would just close the panel.
      if (current.expanded && !forceReload) {
        setState((prev) => ({ ...prev, [seasonNumber]: { ...prev[seasonNumber], expanded: false } }));
        return;
      }

      if (current.loadState === "ready" && !forceReload) {
        setState((prev) => ({ ...prev, [seasonNumber]: { ...prev[seasonNumber], expanded: true } }));
        return;
      }

      setState((prev) => ({
        ...prev,
        [seasonNumber]: { ...prev[seasonNumber], expanded: true, loadState: "loading" },
      }));
      try {
        const res = await fetch(withBasePath(`/api/tv/${tmdbId}/season/${seasonNumber}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { episodes: TmdbEpisode[]; owned: number[] };
        setState((prev) => ({
          ...prev,
          [seasonNumber]: {
            ...prev[seasonNumber],
            loadState: "ready",
            episodes: data.episodes ?? [],
            owned: new Set(data.owned ?? []),
          },
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          [seasonNumber]: { ...prev[seasonNumber], loadState: "error" },
        }));
      }
    },
    [state, tmdbId],
  );

  if (seasons.length === 0) return null;

  return (
    <section className="ds-detail-section">
      <h2
        className="font-semibold"
        style={{
          fontSize: 15,
          letterSpacing: "-0.01em",
          color: "var(--ds-fg)",
          margin: "0 0 12px",
        }}
      >
        {t("detail.seasons.heading")}
      </h2>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {seasons.map((season) => {
          const s = state[season.seasonNumber];
          const ownedCount = s?.owned.size ?? 0;
          const ownershipLabel =
            ownedCount === 0
              ? null
              : ownedCount >= season.episodeCount
              ? t("detail.seasons.complete")
              : t("detail.seasons.ownedCount", { owned: ownedCount, total: season.episodeCount });
          const fullyOwned = ownedCount >= season.episodeCount;

          return (
            <div
              key={season.seasonNumber}
              className="overflow-hidden"
              style={{
                background: "var(--ds-bg-2)",
                border: "1px solid var(--ds-border)",
                borderRadius: 8,
              }}
            >
              {/* Hover uses the shared ds-hover-tint class (JS mouse-enter/leave
                  handlers got stuck "hovered" after a tap on touch screens). The
                  focus ring is drawn inside the button (negative outlineOffset)
                  because the card's overflow-hidden would clip one drawn outside. */}
              <button
                type="button"
                onClick={() => toggleSeason(season.seasonNumber)}
                className="ds-hover-tint w-full flex items-center text-left"
                aria-expanded={s?.expanded ?? false}
                aria-controls={`season-${season.seasonNumber}-panel`}
                style={{
                  gap: 14,
                  padding: 12,
                  background: "transparent",
                  border: 0,
                  color: "var(--ds-fg)",
                  outlineOffset: -2,
                }}
              >
                <div
                  className="relative shrink-0 overflow-hidden"
                  style={{
                    width: 44,
                    aspectRatio: "2 / 3",
                    borderRadius: 4,
                    background: "var(--ds-bg-3)",
                  }}
                >
                  {season.posterPath ? (
                    <Image
                      src={posterUrl(season.posterPath, "w342") ?? ""}
                      alt={seasonLabel(season, t)}
                      fill
                      sizes="44px"
                      className="object-cover"
                    />
                  ) : (
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ color: "var(--ds-fg-subtle)" }}
                    >
                      <Tv2 style={{ width: 16, height: 16 }} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
                    {/* min-w-0 lets a flex child shrink below its nowrap content
                        so `truncate` can act; flex-1 would push the meta spans
                        to the far right of the row. */}
                    <h3
                      className="font-semibold truncate min-w-0"
                      style={{
                        fontSize: 14,
                        color: "var(--ds-fg)",
                        margin: 0,
                      }}
                    >
                      {seasonLabel(season, t)}
                    </h3>
                    <span
                      className="ds-mono"
                      style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                    >
                      {t("detail.seasons.episodeCount", { count: season.episodeCount })}
                    </span>
                    {season.airDate && (
                      <span
                        className="ds-mono flex items-center"
                        style={{
                          gap: 4,
                          fontSize: 10.5,
                          color: "var(--ds-fg-subtle)",
                        }}
                      >
                        <Calendar style={{ width: 10, height: 10 }} />
                        {/* Not gated on `mounted`: a bare YYYY-MM-DD parses as UTC
                            midnight everywhere, so getUTCFullYear() is identical on
                            server and client (guardrail 16 is about values that
                            differ between the two). */}
                        {new Date(season.airDate).getUTCFullYear()}
                      </span>
                    )}
                  </div>
                  {ownershipLabel && (
                    <span
                      className={cn(
                        "ds-chip inline-flex items-center",
                        fullyOwned ? "ds-chip-approved" : "ds-chip-accent",
                      )}
                      style={{ marginTop: 6 }}
                    >
                      <CheckCircle style={{ width: 10, height: 10 }} />
                      {ownershipLabel}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "shrink-0 transition-transform",
                    s?.expanded && "rotate-180",
                  )}
                  style={{
                    width: 18,
                    height: 18,
                    color: "var(--ds-fg-subtle)",
                  }}
                />
              </button>

              {s?.expanded && (
                <div
                  id={`season-${season.seasonNumber}-panel`}
                  style={{
                    borderTop: "1px solid var(--ds-border)",
                    padding: 12,
                  }}
                >
                  {s.loadState === "loading" && (
                    <div
                      className="ds-mono flex items-center justify-center"
                      style={{
                        gap: 8,
                        fontSize: 12,
                        color: "var(--ds-fg-subtle)",
                        padding: "16px 0",
                      }}
                    >
                      <Loader2
                        className="animate-spin"
                        style={{
                          width: 14,
                          height: 14,
                          color: "var(--ds-accent-text)",
                        }}
                      />
                      {t("detail.seasons.loadingEpisodes")}
                    </div>
                  )}

                  {s.loadState === "error" && (
                    <div
                      className="flex flex-col items-center"
                      style={{ gap: 10, padding: "16px 0" }}
                    >
                      <span className="ds-mono" style={{ fontSize: 12, color: "var(--ds-danger)" }}>
                        {t("detail.seasons.loadFailed")}
                      </span>
                      <DetailActionButton
                        variant="secondary"
                        size="sm"
                        onClick={() => toggleSeason(season.seasonNumber, true)}
                      >
                        {t("detail.seasons.retry")}
                      </DetailActionButton>
                    </div>
                  )}

                  {s.loadState === "ready" && s.episodes.length === 0 && (
                    <p
                      className="ds-mono text-center"
                      style={{
                        fontSize: 12,
                        color: "var(--ds-fg-subtle)",
                        padding: "16px 0",
                      }}
                    >
                      {t("detail.seasons.noEpisodes")}
                    </p>
                  )}

                  {s.loadState === "ready" && s.episodes.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {s.episodes.map((ep) => {
                        const owned = s.owned.has(ep.episodeNumber);
                        const still = stillUrl(ep.stillPath, "w300");
                        const runtime = formatRuntime(ep.runtime, t);
                        const aired = mounted ? formatAirDate(ep.airDate, locale) : null;
                        return (
                          <div
                            key={ep.episodeNumber}
                            className="group relative flex"
                            style={{
                              gap: 12,
                              padding: 8,
                              borderRadius: 8,
                              background: owned
                                ? "color-mix(in oklab, var(--ds-success) 6%, transparent)"
                                : "var(--ds-bg-1)",
                              border: `1px solid ${owned ? "color-mix(in oklab, var(--ds-success) 25%, transparent)" : "var(--ds-border)"}`,
                            }}
                          >
                            <div
                              className="relative aspect-video shrink-0 overflow-hidden"
                              style={{
                                width: 112,
                                borderRadius: 4,
                                background: "var(--ds-bg-3)",
                              }}
                            >
                              {still ? (
                                <Image
                                  src={still}
                                  alt={ep.name}
                                  fill
                                  sizes="112px"
                                  className="object-cover"
                                />
                              ) : (
                                <div
                                  className="absolute inset-0 flex items-center justify-center"
                                  style={{ color: "var(--ds-fg-subtle)" }}
                                >
                                  <Tv2 style={{ width: 16, height: 16 }} />
                                </div>
                              )}
                              <div
                                className="ds-mono absolute"
                                style={{
                                  top: 4,
                                  left: 4,
                                  padding: "1px 6px",
                                  borderRadius: 3,
                                  fontSize: 9.5,
                                  fontWeight: 700,
                                  color: "#fff",
                                  background: "color-mix(in oklab, black 70%, transparent)",
                                }}
                              >
                                {t("detail.seasons.episodeAbbrev", { number: ep.episodeNumber })}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start" style={{ gap: 8 }}>
                                <p
                                  className="font-semibold line-clamp-2 flex-1"
                                  style={{ fontSize: 13, color: "var(--ds-fg)" }}
                                >
                                  {ep.name}
                                </p>
                                {owned ? (
                                  <CheckCircle
                                    style={{
                                      width: 14,
                                      height: 14,
                                      color: "var(--ds-success)",
                                      marginTop: 2,
                                    }}
                                    aria-label={t("detail.seasons.inLibrary")}
                                    role="img"
                                  />
                                ) : (
                                  <Circle
                                    style={{
                                      width: 14,
                                      height: 14,
                                      color: "var(--ds-fg-disabled)",
                                      marginTop: 2,
                                    }}
                                    aria-label={t("detail.seasons.notInLibrary")}
                                    role="img"
                                  />
                                )}
                              </div>
                              <div
                                className="ds-mono flex items-center"
                                style={{
                                  gap: 6,
                                  fontSize: 10.5,
                                  color: "var(--ds-fg-subtle)",
                                  marginTop: 2,
                                }}
                              >
                                {aired && <span>{aired}</span>}
                                {aired && runtime && <span>·</span>}
                                {runtime && <span>{runtime}</span>}
                              </div>
                              {ep.overview && (
                                <p
                                  className="line-clamp-2"
                                  style={{
                                    fontSize: 11.5,
                                    color: "var(--ds-fg-muted)",
                                    marginTop: 4,
                                  }}
                                >
                                  {ep.overview}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
