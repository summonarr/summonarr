"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import type { Genre, WatchProvider } from "@/lib/tmdb-types";
import { X } from "lucide-react";
import { StyledSelect } from "@/components/ui/styled-select";

interface FilterBarProps {
  genres: Genre[];
  watchProviders?: WatchProvider[];
  activeGenreId?: string;
  activeMinRating?: string;
  activeRatingFilter?: string;
  activeMinVoteCount?: string;
  activeFromYear?: string;
  activeToYear?: string;
  activeSortBy?: string;
  activeWatchProvider?: string;
  activeHideAvailable?: boolean;
}

const SORT_OPTIONS = [
  { value: "popularity.desc",     label: "Most Popular" },
  { value: "vote_average.desc",   label: "Top Rated" },
  { value: "release_date.desc",   label: "Newest" },
  { value: "release_date.asc",    label: "Oldest" },
];

const RATING_OPTIONS = [
  { value: "",          label: "Any Rating" },
  { value: "imdb:6",    label: "IMDb 6+" },
  { value: "imdb:6.5",  label: "IMDb 6.5+" },
  { value: "imdb:7",    label: "IMDb 7+" },
  { value: "imdb:7.5",  label: "IMDb 7.5+" },
  { value: "imdb:8",    label: "IMDb 8+" },
  { value: "imdb:8.5",  label: "IMDb 8.5+" },
  { value: "imdb:9",    label: "IMDb 9+" },
  { value: "rt:50",     label: "🍅 RT 50%+" },
  { value: "rt:60",     label: "🍅 RT 60%+" },
  { value: "rt:70",     label: "🍅 RT 70%+" },
  { value: "rt:80",     label: "🍅 RT 80%+" },
  { value: "rt:90",     label: "🍅 RT 90%+" },
  { value: "rta:60",   label: "🍿 Audience 60%+" },
  { value: "rta:70",   label: "🍿 Audience 70%+" },
  { value: "rta:80",   label: "🍿 Audience 80%+" },
  { value: "rta:90",   label: "🍿 Audience 90%+" },
  { value: "tmdb:6",    label: "TMDB 6+" },
  { value: "tmdb:7",    label: "TMDB 7+" },
  { value: "tmdb:7.5",  label: "TMDB 7.5+" },
  { value: "tmdb:8",    label: "TMDB 8+" },
  { value: "tmdb:8.5",  label: "TMDB 8.5+" },
  { value: "tmdb:9",    label: "TMDB 9+" },
];

const VOTE_COUNT_OPTIONS = [
  { value: "",      label: "Any Votes" },
  { value: "100",   label: "100+ votes" },
  { value: "250",   label: "250+ votes" },
  { value: "500",   label: "500+ votes" },
  { value: "1000",  label: "1,000+ votes" },
  { value: "5000",  label: "5,000+ votes" },
  { value: "10000", label: "10,000+ votes" },
];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: currentYear - 1899 }, (_, i) => String(currentYear - i));

function ratingChipLabel(minRating?: string, ratingFilter?: string): string | null {
  if (ratingFilter) {
    const opt = RATING_OPTIONS.find((o) => o.value === ratingFilter);
    return opt?.label ?? ratingFilter;
  }
  if (minRating) {
    const opt = RATING_OPTIONS.find((o) => o.value === `tmdb:${minRating}`);
    return opt?.label ?? `TMDB ${minRating}+`;
  }
  return null;
}

const TOP_PROVIDER_IDS = new Set([
  8,
  9,
  337,
  1899,
  15,
  350,
  386,
  531,
]);

export function FilterBar({
  genres,
  watchProviders,
  activeGenreId,
  activeMinRating,
  activeRatingFilter,
  activeMinVoteCount,
  activeFromYear,
  activeToYear,
  activeSortBy,
  activeWatchProvider,
  activeHideAvailable,
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const push = useCallback((updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || v === "") params.delete(k);
      else params.set(k, v);
    }
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }, [router, pathname, searchParams]);

  const activeRatingValue = activeRatingFilter
    ? activeRatingFilter
    : activeMinRating
    ? `tmdb:${activeMinRating}`
    : "";

  function handleRatingChange(value: string) {
    if (!value) {
      push({ minRating: undefined, ratingFilter: undefined });
    } else if (value.startsWith("tmdb:")) {
      push({ minRating: value.slice(5), ratingFilter: undefined });
    } else {
      push({ ratingFilter: value, minRating: undefined });
    }
  }

  const hasFilters = !!(activeGenreId || activeMinRating || activeRatingFilter || activeMinVoteCount || activeFromYear || activeToYear || activeSortBy || activeWatchProvider || activeHideAvailable);
  const chipLabel = ratingChipLabel(activeMinRating, activeRatingFilter);

  const sortedProviders = (watchProviders ?? []).slice().sort((a, b) => {
    const aTop = TOP_PROVIDER_IDS.has(a.provider_id);
    const bTop = TOP_PROVIDER_IDS.has(b.provider_id);
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    return a.provider_name.localeCompare(b.provider_name);
  });
  const activeProviderName = sortedProviders.find((p) => String(p.provider_id) === activeWatchProvider)?.provider_name;

  return (
    <div className="flex flex-col gap-3 mb-8">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 items-center">
        <StyledSelect
          value={activeSortBy ?? "popularity.desc"}
          onChange={(e) => push({ sortBy: e.target.value === "popularity.desc" ? undefined : e.target.value })}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeGenreId ?? ""}
          onChange={(e) => push({ genreId: e.target.value || undefined })}
        >
          <option value="">All Genres</option>
          {genres.map((g) => (
            <option key={g.id} value={String(g.id)}>{g.name}</option>
          ))}
        </StyledSelect>

        {sortedProviders.length > 0 && (
          <StyledSelect
            value={activeWatchProvider ?? ""}
            onChange={(e) => push({ watchProvider: e.target.value || undefined })}
          >
            <option value="">All Services</option>
            {sortedProviders.map((p) => (
              <option key={p.provider_id} value={String(p.provider_id)}>{p.provider_name}</option>
            ))}
          </StyledSelect>
        )}

        <StyledSelect
          value={activeRatingValue}
          onChange={(e) => handleRatingChange(e.target.value)}
        >
          {RATING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeMinVoteCount ?? ""}
          onChange={(e) => push({ minVoteCount: e.target.value || undefined })}
        >
          {VOTE_COUNT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeFromYear ?? ""}
          onChange={(e) => push({ fromYear: e.target.value || undefined })}
        >
          <option value="">From Year</option>
          {YEARS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeToYear ?? ""}
          onChange={(e) => push({ toYear: e.target.value || undefined })}
        >
          <option value="">To Year</option>
          {YEARS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </StyledSelect>

        <button
          type="button"
          onClick={() => push({ hideAvailable: activeHideAvailable ? undefined : "1" })}
          className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors"
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            fontSize: 12,
            background: activeHideAvailable
              ? "var(--ds-accent-soft)"
              : "var(--ds-bg-2)",
            color: activeHideAvailable
              ? "var(--ds-accent)"
              : "var(--ds-fg-muted)",
            border: `1px solid ${activeHideAvailable ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
          }}
        >
          Hide Available
        </button>

        {hasFilters && (
          <button
            type="button"
            onClick={() => router.push(pathname)}
            className="ds-tap inline-flex items-center gap-1 transition-colors"
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              fontSize: 11,
              background: "var(--ds-bg-2)",
              color: "var(--ds-fg-muted)",
              border: "1px solid var(--ds-border)",
            }}
          >
            <X style={{ width: 12, height: 12 }} />
            Clear filters
          </button>
        )}
      </div>

      {hasFilters && (
        <div className="flex flex-wrap gap-1.5">
          {activeGenreId && (
            <Chip label={genres.find((g) => String(g.id) === activeGenreId)?.name ?? activeGenreId} onRemove={() => push({ genreId: undefined })} />
          )}
          {chipLabel && (
            <Chip label={chipLabel} onRemove={() => push({ minRating: undefined, ratingFilter: undefined })} />
          )}
          {activeMinVoteCount && (
            <Chip
              label={VOTE_COUNT_OPTIONS.find((o) => o.value === activeMinVoteCount)?.label ?? `${activeMinVoteCount}+ votes`}
              onRemove={() => push({ minVoteCount: undefined })}
            />
          )}
          {activeFromYear && (
            <Chip label={`From ${activeFromYear}`} onRemove={() => push({ fromYear: undefined })} />
          )}
          {activeToYear && (
            <Chip label={`To ${activeToYear}`} onRemove={() => push({ toYear: undefined })} />
          )}
          {activeProviderName && (
            <Chip label={activeProviderName} onRemove={() => push({ watchProvider: undefined })} />
          )}
          {activeSortBy && activeSortBy !== "popularity.desc" && (
            <Chip label={SORT_OPTIONS.find((o) => o.value === activeSortBy)?.label ?? activeSortBy} onRemove={() => push({ sortBy: undefined })} />
          )}
          {activeHideAvailable && (
            <Chip label="Hiding Available" onRemove={() => push({ hideAvailable: undefined })} />
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="ds-chip ds-chip-accent">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center transition-colors ml-0.5"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <X style={{ width: 10, height: 10 }} />
      </button>
    </span>
  );
}
