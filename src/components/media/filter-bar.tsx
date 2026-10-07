"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Genre, WatchProvider } from "@/lib/tmdb-types";
import { X } from "@/components/icons";
import { StyledSelect } from "@/components/ui/styled-select";
import { FilterBar as SortSegments } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

interface FilterBarProps {
  genres: Genre[];
  watchProviders?: WatchProvider[];
  activeGenreId?: string;
  activeKeywordId?: string;
  activeKeywordName?: string;
  activeMinRating?: string;
  activeRatingFilter?: string;
  activeMinVoteCount?: string;
  activeFromYear?: string;
  activeToYear?: string;
  activeSortBy?: string;
  activeWatchProvider?: string;
  activeHideAvailable?: boolean;
  // Latest year for the From/To Year dropdowns. Computed server-side so SSR
  // and hydration share one value — see the comment over `buildYears` below.
  maxYear: number;
  // The parent's startTransition. Filter changes are now real navigations that
  // the server answers, so the grid needs to know one is in flight — owning the
  // transition here would keep isPending out of reach of the spinner.
  navigate: (cb: () => void) => void;
}

// Labels are catalog keys, translated at render (module scope has no locale).
const SORT_OPTIONS = [
  { value: "popularity.desc",     labelKey: "media.filter.sort.popular" },
  { value: "vote_average.desc",   labelKey: "media.filter.sort.topRated" },
  { value: "release_date.desc",   labelKey: "media.filter.sort.newest" },
  { value: "release_date.asc",    labelKey: "media.filter.sort.oldest" },
];

// A `label` is a literal (brand + number, same in every language); `labelKey`
// + `pct` is translated at render.
const RATING_OPTIONS: { value: string; label?: string; labelKey?: string; pct?: number }[] = [
  { value: "",          labelKey: "media.filter.anyRating" },
  { value: "imdb:6",    label: "IMDb 6+" },
  { value: "imdb:6.5",  label: "IMDb 6.5+" },
  { value: "imdb:7",    label: "IMDb 7+" },
  { value: "imdb:7.5",  label: "IMDb 7.5+" },
  { value: "imdb:8",    label: "IMDb 8+" },
  { value: "imdb:8.5",  label: "IMDb 8.5+" },
  { value: "imdb:9",    label: "IMDb 9+" },
  // No glyphs: the IMDb and TMDB rows of this one <select> carry none, so a
  // tomato/popcorn prefix on the RT rows alone read as two styles in one list
  // (and leaked into the active-filter chip).
  { value: "rt:50",     label: "RT 50%+" },
  { value: "rt:60",     label: "RT 60%+" },
  { value: "rt:70",     label: "RT 70%+" },
  { value: "rt:80",     label: "RT 80%+" },
  { value: "rt:90",     label: "RT 90%+" },
  { value: "rta:60",   labelKey: "media.filter.audienceScore", pct: 60 },
  { value: "rta:70",   labelKey: "media.filter.audienceScore", pct: 70 },
  { value: "rta:80",   labelKey: "media.filter.audienceScore", pct: 80 },
  { value: "rta:90",   labelKey: "media.filter.audienceScore", pct: 90 },
  { value: "tmdb:6",    label: "TMDB 6+" },
  { value: "tmdb:7",    label: "TMDB 7+" },
  { value: "tmdb:7.5",  label: "TMDB 7.5+" },
  { value: "tmdb:8",    label: "TMDB 8+" },
  { value: "tmdb:8.5",  label: "TMDB 8.5+" },
  { value: "tmdb:9",    label: "TMDB 9+" },
];

const VOTE_COUNT_OPTIONS = ["", "100", "250", "500", "1000", "5000", "10000"];

function ratingOptionLabel(t: Translator, o: (typeof RATING_OPTIONS)[number]): string {
  return o.labelKey ? t(o.labelKey, o.pct !== undefined ? { pct: o.pct } : undefined) : (o.label ?? o.value);
}

// "1,000+ votes". Grouped by hand with the catalog's separator rather than
// Intl.NumberFormat: the <option> text is server-rendered, and the server's and
// browser's ICU data can disagree on grouping (guardrail 16's locale cousin).
export function voteCountLabel(t: Translator, value: string): string {
  if (!value) return t("media.filter.anyVotes");
  const n = value.replace(/\B(?=(\d{3})+(?!\d))/g, t("media.filter.thousandsSeparator"));
  return t("media.filter.votesMin", { n });
}

// `maxYear` is a prop, not a module-level constant. DO NOT introduce a
// module-level `const x = new Date()...` here — that's the canonical React
// #418 hydration source: Node freezes it at module load, the client
// re-evaluates at page load, and once the year rolls over (or the bundler
// bakes the build-time year), the SSR and CSR `<option>` lists drift.
// Compute on the server, pass through props, so SSR + hydration agree.
function buildYears(maxYear: number): string[] {
  return Array.from({ length: maxYear - 1899 }, (_, i) => String(maxYear - i));
}

function ratingChipLabel(t: Translator, minRating?: string, ratingFilter?: string): string | null {
  if (ratingFilter) {
    const opt = RATING_OPTIONS.find((o) => o.value === ratingFilter);
    return opt ? ratingOptionLabel(t, opt) : ratingFilter;
  }
  if (minRating) {
    const opt = RATING_OPTIONS.find((o) => o.value === `tmdb:${minRating}`);
    return opt ? ratingOptionLabel(t, opt) : `TMDB ${minRating}+`;
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
  activeKeywordId,
  activeKeywordName,
  activeMinRating,
  activeRatingFilter,
  activeMinVoteCount,
  activeFromYear,
  activeToYear,
  activeSortBy,
  activeWatchProvider,
  activeHideAvailable,
  maxYear,
  navigate,
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useT();
  const years = useMemo(() => buildYears(maxYear), [maxYear]);

  // Filter changes we have pushed but that the URL has not caught up with yet.
  //
  // `searchParams` reflects the COMMITTED url, and router.push is async — so
  // changing two filters in quick succession used to rebuild the second query
  // string from a snapshot that still held the first filter's OLD value, wiping
  // the change the user had just made. It presented as a dropdown reverting to
  // a year nobody picked, with the chip agreeing, so nothing on screen showed
  // that a change had been dropped. Waiting ~2s between changes worked because
  // the first navigation had committed by then.
  //
  // Keeping a DELTA rather than a full snapshot is what makes this correct for
  // a third change too: every not-yet-committed change is reapplied on top of
  // whatever `searchParams` currently says.
  const pendingRef = useRef<Record<string, string | undefined>>({});
  const committed = searchParams.toString();

  // Drop deltas the URL has caught up with; anything still in flight stays.
  useEffect(() => {
    const current = new URLSearchParams(committed);
    for (const [k, v] of Object.entries(pendingRef.current)) {
      const landed = v === undefined || v === "" ? current.get(k) === null : current.get(k) === v;
      if (landed) delete pendingRef.current[k];
    }
  }, [committed]);

  // Back/forward replaces the query string wholesale, so any optimistic delta
  // is void — without this it would be reapplied on the next filter change and
  // silently undo the user's Back.
  useEffect(() => {
    const onPop = () => { pendingRef.current = {}; };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const push = useCallback((updates: Record<string, string | undefined>) => {
    Object.assign(pendingRef.current, updates);
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(pendingRef.current)) {
      if (v === undefined || v === "") params.delete(k);
      else params.set(k, v);
    }
    params.delete("page");
    // Wrapped by the parent's transition so the grid can show a pending
    // overlay for the whole navigation, not just its tail.
    navigate(() => router.push(`${pathname}?${params.toString()}`));
  }, [router, pathname, searchParams, navigate]);

  // Clearing bypasses `push` (it drops every param rather than editing some),
  // so it has to drop the delta too or the next change resurrects the filters
  // that were just cleared.
  const clearAll = useCallback(() => {
    pendingRef.current = {};
    navigate(() => router.push(pathname));
  }, [router, pathname, navigate]);

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

  const hasFilters = !!(activeGenreId || activeKeywordId || activeMinRating || activeRatingFilter || activeMinVoteCount || activeFromYear || activeToYear || activeSortBy || activeWatchProvider || activeHideAvailable);
  const chipLabel = ratingChipLabel(t, activeMinRating, activeRatingFilter);

  const sortedProviders = (watchProviders ?? []).slice().sort((a, b) => {
    const aTop = TOP_PROVIDER_IDS.has(a.provider_id);
    const bTop = TOP_PROVIDER_IDS.has(b.provider_id);
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    // Pinned locale. Bare localeCompare uses the RUNTIME default — Node's on
    // the server, the browser's on the client — and this list is rendered into
    // SSR HTML. Czech and Slovak sort the "ch" digraph after "h" (moving the
    // real provider "Chili"), Lithuanian and Latvian collate Y next to I, and
    // Estonian puts Z between S and T; any of those reorders the <option> list
    // between server and client and reports a hydration mismatch. Guardrail 16
    // is written around the clock, but locale is the same class of bug.
    return a.provider_name.localeCompare(b.provider_name, "en");
  });
  const activeProviderName = sortedProviders.find((p) => String(p.provider_id) === activeWatchProvider)?.provider_name;

  return (
    <div className="flex flex-col gap-3 mb-6">
      <SortSegments
        segments={SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        active={activeSortBy ?? "popularity.desc"}
        onChange={(v) =>
          push({ sortBy: v === "popularity.desc" ? undefined : v })
        }
        className="mb-0"
      />

      {/* One row, one height, one radius: every select is `compact` (h-8,
          rounded-lg = 8px) and every pill beside them is minHeight 32 /
          borderRadius 8. The default 44px select left the pills sitting in a
          6px band above and below, two radii apart. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 items-center">
        <StyledSelect
          compact
          aria-label={t("media.filter.genreLabel")}
          value={activeGenreId ?? ""}
          onChange={(e) => push({ genreId: e.target.value || undefined })}
        >
          <option value="">{t("media.filter.allGenres")}</option>
          {genres.map((g) => (
            <option key={g.id} value={String(g.id)}>{g.name}</option>
          ))}
        </StyledSelect>

        {sortedProviders.length > 0 && (
          <StyledSelect
            compact
            aria-label={t("media.filter.serviceLabel")}
            value={activeWatchProvider ?? ""}
            onChange={(e) => push({ watchProvider: e.target.value || undefined })}
          >
            <option value="">{t("media.filter.allServices")}</option>
            {sortedProviders.map((p) => (
              <option key={p.provider_id} value={String(p.provider_id)}>{p.provider_name}</option>
            ))}
          </StyledSelect>
        )}

        <StyledSelect
          compact
          aria-label={t("media.filter.minRatingLabel")}
          value={activeRatingValue}
          onChange={(e) => handleRatingChange(e.target.value)}
        >
          {RATING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{ratingOptionLabel(t, o)}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          compact
          aria-label={t("media.filter.minVotesLabel")}
          value={activeMinVoteCount ?? ""}
          onChange={(e) => push({ minVoteCount: e.target.value || undefined })}
        >
          {VOTE_COUNT_OPTIONS.map((v) => (
            <option key={v} value={v}>{voteCountLabel(t, v)}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          compact
          aria-label={t("media.filter.fromYearLabel")}
          value={activeFromYear ?? ""}
          onChange={(e) => push({ fromYear: e.target.value || undefined })}
        >
          <option value="">{t("media.filter.fromYear")}</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          compact
          aria-label={t("media.filter.toYearLabel")}
          value={activeToYear ?? ""}
          onChange={(e) => push({ toYear: e.target.value || undefined })}
        >
          <option value="">{t("media.filter.toYear")}</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </StyledSelect>

        <button
          type="button"
          onClick={() => push({ hideAvailable: activeHideAvailable ? undefined : "1" })}
          aria-pressed={!!activeHideAvailable}
          className="ds-tap ds-hover-tint inline-flex items-center gap-1.5 font-medium"
          style={{
            padding: "5px 12px",
            minHeight: 32,
            borderRadius: 8,
            fontSize: 12,
            background: activeHideAvailable
              ? "var(--ds-accent-soft)"
              : "var(--ds-bg-2)",
            color: activeHideAvailable
              ? "var(--ds-accent-text)"
              : "var(--ds-fg-muted)",
            border: `1px solid ${activeHideAvailable ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
          }}
        >
          {t("media.hideAvailable")}
        </button>

        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="ds-tap ds-hover-tint inline-flex items-center gap-1"
            style={{
              padding: "5px 10px",
              minHeight: 32,
              borderRadius: 8,
              fontSize: 11,
              background: "var(--ds-bg-2)",
              color: "var(--ds-fg-muted)",
              border: "1px solid var(--ds-border)",
            }}
          >
            <X style={{ width: 12, height: 12 }} />
            {t("browse.clearFilters")}
          </button>
        )}
      </div>

      {hasFilters && (
        <div className="flex flex-wrap gap-1.5">
          {activeGenreId && (
            <Chip label={genres.find((g) => String(g.id) === activeGenreId)?.name ?? activeGenreId} onRemove={() => push({ genreId: undefined })} />
          )}
          {activeKeywordId && (
            <Chip label={activeKeywordName ?? t("media.filter.keyword")} onRemove={() => push({ keywordId: undefined, keywordName: undefined })} />
          )}
          {chipLabel && (
            <Chip label={chipLabel} onRemove={() => push({ minRating: undefined, ratingFilter: undefined })} />
          )}
          {activeMinVoteCount && (
            <Chip
              label={voteCountLabel(t, activeMinVoteCount)}
              onRemove={() => push({ minVoteCount: undefined })}
            />
          )}
          {activeFromYear && (
            <Chip label={t("media.filter.fromChip", { year: activeFromYear })} onRemove={() => push({ fromYear: undefined })} />
          )}
          {activeToYear && (
            <Chip label={t("media.filter.toChip", { year: activeToYear })} onRemove={() => push({ toYear: undefined })} />
          )}
          {activeProviderName && (
            <Chip label={activeProviderName} onRemove={() => push({ watchProvider: undefined })} />
          )}
          {activeSortBy && activeSortBy !== "popularity.desc" && (
            <Chip label={(() => { const o = SORT_OPTIONS.find((x) => x.value === activeSortBy); return o ? t(o.labelKey) : activeSortBy; })()} onRemove={() => push({ sortBy: undefined })} />
          )}
          {activeHideAvailable && (
            <Chip label={t("media.filter.hidingAvailable")} onRemove={() => push({ hideAvailable: undefined })} />
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const t = useT();
  return (
    <span className="ds-chip ds-chip-accent">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("media.filter.remove", { label })}
        title={t("media.filter.remove", { label })}
        className="ds-hover-tint inline-flex items-center justify-center shrink-0"
        style={{
          // 24px hit box. The negative margins pull it back to the 12px
          // footprint the 2px gap + 10px glyph occupied, so the chip keeps its
          // size and the glyph stays exactly where it was.
          width: 24,
          height: 24,
          margin: "-6px -7px -6px -5px",
          borderRadius: 999,
          background: "transparent",
          border: 0,
          padding: 0,
          color: "inherit",
        }}
      >
        <X style={{ width: 10, height: 10 }} />
      </button>
    </span>
  );
}
