"use client";

import { memo, useState } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Image from "next/image";
import { ChevronDown, CheckCircle, Circle, Loader2, Tv2, Calendar } from "@/components/icons";
import { cn } from "@/lib/utils";
import { posterUrl, stillUrl, type TmdbSeason } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { v, type Infer } from "@/lib/validate";
import { formatReleaseDate } from "@/lib/format-release-date";
import { DetailActionButton } from "./detail-action-button";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

interface TVSeasonsProps {
  tmdbId: number;
  seasons: TmdbSeason[];

  ownedBySeason: Record<number, number[]>;
}

type LoadState = "idle" | "loading" | "ready" | "error";

// GET /api/tv/[id]/season/[season]: the fields this list reads.
const SeasonAnswer = v.object({
  episodes: v.array(
    v.object({
      episodeNumber: v.int(),
      name: v.string(),
      overview: v.string(),
      airDate: v.nullable(v.string()),
      stillPath: v.nullable(v.string()),
      runtime: v.nullable(v.number()),
    }),
  ),
  owned: v.array(v.int()),
});
type SeasonEpisode = Infer<typeof SeasonAnswer>["episodes"][number];

// UI state only, created lazily the first time a season is touched. Ownership
// from the server props is NOT copied in here: a copy taken at mount went stale
// after a router.refresh, and a season first listed by that refresh had no
// entry at all, so it could not be expanded.
interface SeasonState {
  expanded: boolean;
  loadState: LoadState;
  episodes: SeasonEpisode[];
  // The season fetch's owned episodes; null until it lands, and the collapsed
  // count reads the ownedBySeason prop meanwhile.
  owned: Set<number> | null;
}

const NEW_SEASON: SeasonState = { expanded: false, loadState: "idle", episodes: [], owned: null };

// The year of a season's TMDB `air_date` ("YYYY-MM-DD"), read off the string.
// A bare date parses as UTC midnight everywhere, so server and client agree
// (guardrail 16); a malformed value ("0000-00-00", "2024-13-01") renders
// nothing instead of NaN.
function airYear(airDate: string | null): string | null {
  const m = airDate ? /^(\d{4})-\d{2}-\d{2}/.exec(airDate) : null;
  return m && !Number.isNaN(Date.parse(m[0])) ? m[1] : null;
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
function seasonLabel(season: { seasonNumber: number; name: string }, t: Translator): string {
  const m = /^Season (\d+)$/.exec(season.name.trim());
  if (m && Number(m[1]) === season.seasonNumber) return t("detail.seasons.numbered", { number: season.seasonNumber });
  if (season.name.trim() === "Specials" && season.seasonNumber === 0) return t("detail.seasons.specials");
  return season.name;
}

// One episode of an expanded season. Memoized: a season's fetch or toggle
// re-renders the list, and an open season's cards don't change with it.
const EpisodeCard = memo(function EpisodeCard({
  ep,
  owned,
  aired,
  t,
}: {
  ep: SeasonEpisode;
  owned: boolean;
  // Formatted by the caller, gated on `mounted` (guardrail 16).
  aired: string | null;
  t: Translator;
}) {
  const still = stillUrl(ep.stillPath, "w300");
  const runtime = formatRuntime(ep.runtime, t);
  return (
    <div
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
});

// The expanded season's body: loading, a retryable failure, or the episodes.
function SeasonPanel({
  id,
  s,
  onRetry,
  t,
}: {
  id: string;
  s: SeasonState;
  onRetry: () => void;
  t: Translator;
}) {
  const mounted = useHasMounted();
  const locale = useLocale();
  return (
    <div
      id={id}
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
          <DetailActionButton variant="secondary" size="sm" onClick={onRetry}>
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
          {s.episodes.map((ep) => (
            <EpisodeCard
              key={ep.episodeNumber}
              ep={ep}
              owned={s.owned?.has(ep.episodeNumber) ?? false}
              // Still gated on `mounted` (guardrail 16): the locale's
              // formatting can differ between server and browser. A bare TMDB
              // date is formatted in UTC, so nobody west of UTC sees the
              // previous day, and an unparseable one is dropped rather than
              // shown as "Invalid Date".
              aired={mounted ? formatReleaseDate(ep.airDate, locale) : null}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One season: the disclosure header and, while expanded, its panel.
function SeasonRow({
  season,
  s,
  ownedCount,
  onToggle,
  t,
}: {
  season: TmdbSeason;
  s: SeasonState | undefined;
  // The season fetch's answer once it has one, else the server's props.
  ownedCount: number;
  onToggle: (forceReload: boolean) => void;
  t: Translator;
}) {
  const label = seasonLabel(season, t);
  const year = airYear(season.airDate);
  const panelId = `season-${season.seasonNumber}-panel`;
  const fullyOwned = ownedCount >= season.episodeCount;
  const ownershipLabel =
    ownedCount === 0
      ? null
      : fullyOwned
      ? t("detail.seasons.complete")
      : t("detail.seasons.ownedCount", { owned: ownedCount, total: season.episodeCount });

  return (
    <div
      className="overflow-hidden"
      style={{
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {/* The disclosure-heading pattern: the heading wraps the button, so the
          season name is a real heading and the button holds phrasing content
          only (spans). Hover uses the shared ds-hover-tint class (JS
          mouse-enter/leave handlers got stuck "hovered" after a tap on touch
          screens). The focus ring is drawn inside the button (negative
          outlineOffset) because the card's overflow-hidden would clip one
          drawn outside. */}
      <h3 style={{ margin: 0 }}>
        <button
          type="button"
          onClick={() => onToggle(false)}
          className="ds-hover-tint w-full flex items-center text-left"
          aria-expanded={s?.expanded ?? false}
          // The panel is only in the DOM while expanded; pointing at a
          // missing id is an invalid reference.
          aria-controls={s?.expanded ? panelId : undefined}
          style={{
            gap: 14,
            padding: 12,
            background: "transparent",
            border: 0,
            color: "var(--ds-fg)",
            outlineOffset: -2,
          }}
        >
          <span
            className="relative block shrink-0 overflow-hidden"
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
                alt={label}
                fill
                sizes="44px"
                className="object-cover"
              />
            ) : (
              <span
                className="absolute inset-0 flex items-center justify-center"
                style={{ color: "var(--ds-fg-subtle)" }}
              >
                <Tv2 style={{ width: 16, height: 16 }} />
              </span>
            )}
          </span>
          <span className="block flex-1 min-w-0">
            <span className="flex items-center flex-wrap" style={{ gap: 8 }}>
              {/* min-w-0 lets a flex child shrink below its nowrap content
                  so `truncate` can act; flex-1 would push the meta spans
                  to the far right of the row. */}
              <span
                className="block font-semibold truncate min-w-0"
                style={{
                  fontSize: 14,
                  color: "var(--ds-fg)",
                  margin: 0,
                }}
              >
                {label}
              </span>
              <span
                className="ds-mono"
                style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
              >
                {t("detail.seasons.episodeCount", { count: season.episodeCount })}
              </span>
              {year && (
                <span
                  className="ds-mono flex items-center"
                  style={{
                    gap: 4,
                    fontSize: 10.5,
                    color: "var(--ds-fg-subtle)",
                  }}
                >
                  <Calendar style={{ width: 10, height: 10 }} />
                  {/* Not gated on `mounted`: airYear reads the string, so
                      server and client agree (guardrail 16). */}
                  {year}
                </span>
              )}
            </span>
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
          </span>
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
      </h3>

      {s?.expanded && <SeasonPanel id={panelId} s={s} onRetry={() => onToggle(true)} t={t} />}
    </div>
  );
}

// Collapsible list of seasons. Episodes (and which ones are in the library) are
// only fetched the first time a season is expanded.
export function TVSeasons({ tmdbId, seasons, ownedBySeason }: TVSeasonsProps) {
  const t = useT();
  const action = useAsyncAction();
  // Keyed `${tmdbId}:${seasonNumber}`: a client navigation to another show can
  // reuse this instance, and its seasons share numbers with the last one's — a
  // late answer for the old show lands under a key nothing reads.
  const [state, setState] = useState<Record<string, SeasonState>>({});
  const keyOf = (seasonNumber: number) => `${tmdbId}:${seasonNumber}`;

  const patch = (key: string, next: Partial<SeasonState>) =>
    setState((prev) => ({ ...prev, [key]: { ...(prev[key] ?? NEW_SEASON), ...next } }));

  // A plain function, not a useCallback: it reads this render's `state`, which
  // is current at click time (a callback keyed on [state] was rebuilt on every
  // change anyway).
  async function toggleSeason(seasonNumber: number, forceReload = false) {
    const key = keyOf(seasonNumber);
    const current = state[key] ?? NEW_SEASON;

    // forceReload is used by the Retry button. It skips the early returns
    // below (collapse, "already loaded", "already loading") and always
    // re-fetches. Without it, clicking Retry inside the open error panel would
    // just close the panel.
    if (current.expanded && !forceReload) {
      patch(key, { expanded: false });
      return;
    }

    // Loaded, or still loading from an earlier expand (expand → collapse →
    // expand): just show it. Only Retry starts a second fetch.
    if ((current.loadState === "ready" || current.loadState === "loading") && !forceReload) {
      patch(key, { expanded: true });
      return;
    }

    patch(key, { expanded: true, loadState: "loading" });
    // One run per season key: a Retry replaces the run in flight, whose late
    // answer is then dropped (run resolves undefined).
    const res = await action.run(key, (signal) =>
      fetchJson(withBasePath(`/api/tv/${tmdbId}/season/${seasonNumber}`), { schema: SeasonAnswer, signal }),
    );
    if (!res) return;
    if (!res.ok) {
      patch(key, { loadState: "error" });
      return;
    }
    patch(key, { loadState: "ready", episodes: res.data.episodes, owned: new Set(res.data.owned) });
  }

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
          const s = state[keyOf(season.seasonNumber)];
          // Live across a router.refresh while there is no fetched answer.
          const ownedCount = s?.owned ? s.owned.size : (ownedBySeason[season.seasonNumber]?.length ?? 0);
          return (
            <SeasonRow
              key={season.seasonNumber}
              season={season}
              s={s}
              ownedCount={ownedCount}
              onToggle={(forceReload) => toggleSeason(season.seasonNumber, forceReload)}
              t={t}
            />
          );
        })}
      </div>
    </section>
  );
}
