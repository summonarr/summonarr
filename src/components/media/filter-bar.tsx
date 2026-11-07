"use client";

import { useMemo } from "react";
import type { Genre, WatchProvider } from "@/lib/tmdb-types";
import { X } from "@/components/icons";
import { StyledSelect } from "@/components/ui/styled-select";
import { FilterBar as SortSegments } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { CERTIFICATION_CAPS } from "@/lib/studio-list";
import {
  hasActiveFilters,
  overlayBrowseFilters,
  type BrowseFilters,
  type PendingDelta,
} from "@/lib/browse-filters";
import { usePendingFilters } from "./use-pending-filters";

interface FilterBarProps {
  genres: Genre[];
  watchProviders?: WatchProvider[];
  // The COMMITTED filters (parseBrowseFilters over the URL). What the controls
  // show is these overlaid with the changes still in flight.
  filters: BrowseFilters;
  // Movies only: TMDB cannot cap a TV discover by content rating.
  showCertification?: boolean;
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
  filters,
  showCertification = false,
  maxYear,
  navigate,
}: FilterBarProps) {
  const t = useT();
  const years = useMemo(() => buildYears(maxYear), [maxYear]);

  // Pushing, the in-flight delta, and its reconciliation with the URL live in
  // usePendingFilters (shared with TopFilterBar). Every control reads `f`, the
  // committed filters with that delta applied, so a pick shows at once instead
  // of snapping back until the server render lands.
  const { pending, push, clearAll } = usePendingFilters(navigate);
  const f = overlayBrowseFilters(filters, pending);

  const activeRatingValue = f.ratingFilter
    ? f.ratingFilter
    : f.minRating
    ? `tmdb:${f.minRating}`
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

  const hasFilters = hasActiveFilters(f);
  const chipLabel = ratingChipLabel(t, f.minRating, f.ratingFilter);

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
  const activeProviderName = sortedProviders.find((p) => String(p.provider_id) === f.watchProvider)?.provider_name;

  // The chips, built from the same conditions their JSX used to test inline,
  // so the row only renders when it has something in it. A provider id the
  // list doesn't name (the provider fetch failed, or a stale id) still gets a
  // chip: otherwise that filter was active with no way to see or remove it.
  const chips: { key: string; label: string; remove: PendingDelta }[] = [];
  if (f.genreId) {
    chips.push({ key: "genre", label: genres.find((g) => String(g.id) === f.genreId)?.name ?? f.genreId, remove: { genreId: undefined } });
  }
  if (f.keywordId) {
    chips.push({ key: "keyword", label: f.keywordName ?? t("media.filter.keyword"), remove: { keywordId: undefined, keywordName: undefined } });
  }
  if (f.companyId) {
    chips.push({ key: "company", label: f.companyName ?? t("media.filter.studio"), remove: { companyId: undefined, companyName: undefined } });
  }
  if (f.networkId) {
    chips.push({ key: "network", label: f.networkName ?? t("media.filter.network"), remove: { networkId: undefined, networkName: undefined } });
  }
  if (f.certification && showCertification) {
    chips.push({ key: "cert", label: t("media.filter.certUpTo", { rating: f.certification }), remove: { certification: undefined } });
  }
  if (chipLabel) {
    chips.push({ key: "rating", label: chipLabel, remove: { minRating: undefined, ratingFilter: undefined } });
  }
  if (f.minVoteCount) {
    chips.push({ key: "votes", label: voteCountLabel(t, f.minVoteCount), remove: { minVoteCount: undefined } });
  }
  if (f.fromYear) {
    chips.push({ key: "from", label: t("media.filter.fromChip", { year: f.fromYear }), remove: { fromYear: undefined } });
  }
  if (f.toYear) {
    chips.push({ key: "to", label: t("media.filter.toChip", { year: f.toYear }), remove: { toYear: undefined } });
  }
  if (f.watchProvider) {
    chips.push({
      key: "provider",
      label: activeProviderName ?? t("media.filter.serviceChip", { id: f.watchProvider }),
      remove: { watchProvider: undefined },
    });
  }
  if (f.sortBy && f.sortBy !== "popularity.desc") {
    const o = SORT_OPTIONS.find((x) => x.value === f.sortBy);
    chips.push({ key: "sort", label: o ? t(o.labelKey) : f.sortBy, remove: { sortBy: undefined } });
  }
  if (f.hideAvailable) {
    chips.push({ key: "hide", label: t("media.filter.hidingAvailable"), remove: { hideAvailable: undefined } });
  }

  return (
    <div className="flex flex-col gap-3 mb-6">
      <SortSegments
        segments={SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        active={f.sortBy ?? "popularity.desc"}
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
          value={f.genreId ?? ""}
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
            value={f.watchProvider ?? ""}
            onChange={(e) => push({ watchProvider: e.target.value || undefined })}
          >
            <option value="">{t("media.filter.allServices")}</option>
            {sortedProviders.map((p) => (
              <option key={p.provider_id} value={String(p.provider_id)}>{p.provider_name}</option>
            ))}
          </StyledSelect>
        )}

        {showCertification && (
          <StyledSelect
            compact
            aria-label={t("media.filter.certLabel")}
            value={f.certification ?? ""}
            onChange={(e) => push({ certification: e.target.value || undefined })}
          >
            <option value="">{t("media.filter.certAny")}</option>
            {CERTIFICATION_CAPS.map((c) => (
              <option key={c} value={c}>{t("media.filter.certUpTo", { rating: c })}</option>
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
          value={f.minVoteCount ?? ""}
          onChange={(e) => push({ minVoteCount: e.target.value || undefined })}
        >
          {VOTE_COUNT_OPTIONS.map((v) => (
            <option key={v} value={v}>{voteCountLabel(t, v)}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          compact
          aria-label={t("media.filter.fromYearLabel")}
          value={f.fromYear ?? ""}
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
          value={f.toYear ?? ""}
          onChange={(e) => push({ toYear: e.target.value || undefined })}
        >
          <option value="">{t("media.filter.toYear")}</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </StyledSelect>

        <button
          type="button"
          onClick={() => push({ hideAvailable: f.hideAvailable ? undefined : "1" })}
          aria-pressed={f.hideAvailable}
          className="ds-tap ds-hover-tint inline-flex items-center gap-1.5 font-medium"
          style={{
            padding: "5px 12px",
            minHeight: 32,
            borderRadius: 8,
            fontSize: 12,
            background: f.hideAvailable
              ? "var(--ds-accent-soft)"
              : "var(--ds-bg-2)",
            color: f.hideAvailable
              ? "var(--ds-accent-text)"
              : "var(--ds-fg-muted)",
            border: `1px solid ${f.hideAvailable ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
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

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} onRemove={() => push(c.remove)} />
          ))}
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
