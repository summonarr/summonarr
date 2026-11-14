"use client";

import { useMemo, type ReactNode } from "react";
import type { Genre, WatchProvider } from "@/lib/tmdb-types";
import { X } from "@/components/icons";
import { StyledSelect } from "@/components/ui/styled-select";
import { FilterBar as SortSegments } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import { CERTIFICATION_CAPS } from "@/lib/studio-list";
import {
  hasActiveFilters,
  overlayBrowseFilters,
  type BrowseFilters,
} from "@/lib/browse-filters";
import { usePendingFilters } from "./use-pending-filters";
import { RemovableChip, buildYears } from "./filter-chip";
import { FilterToggleButton } from "./filter-toggle-button";
import {
  SORT_OPTIONS,
  VOTE_COUNT_OPTIONS,
  optionsWithActive,
  activeRatingValue,
  filterChips,
  ratingDelta,
  ratingSelectOptions,
  sortProviders,
  voteCountLabel,
} from "./filter-bar-options";

// The option lists and the chip rules live in filter-bar-options.ts; this is
// re-exported for the /top filter bar, which shares the vote labels.
export { voteCountLabel };

interface FilterBarProps {
  genres: Genre[];
  watchProviders?: WatchProvider[];
  // The COMMITTED filters (parseBrowseFilters over the URL). What the controls
  // show is these overlaid with the changes still in flight.
  filters: BrowseFilters;
  // Movies only: TMDB cannot cap a TV discover by content rating.
  showCertification?: boolean;
  // Latest year for the From/To Year dropdowns. Computed server-side so SSR
  // and hydration share one value — see buildYears (filter-chip.tsx).
  maxYear: number;
  // The parent's startTransition. Filter changes are now real navigations that
  // the server answers, so the grid needs to know one is in flight — owning the
  // transition here would keep isPending out of reach of the spinner.
  navigate: (cb: () => void) => void;
  /** That transition's isPending: when it ends, no filter change is in flight. */
  navigating: boolean;
}

export function FilterBar({
  genres,
  watchProviders,
  filters,
  showCertification = false,
  maxYear,
  navigate,
  navigating,
}: FilterBarProps) {
  const t = useT();
  // `maxYear` arrives from the server so SSR and hydration share one list
  // (see buildYears).
  const years = useMemo(() => buildYears(maxYear), [maxYear]);

  // Pushing, the in-flight delta, and its reconciliation with the URL live in
  // usePendingFilters (shared with TopFilterBar). Every control reads `f`, the
  // committed filters with that delta applied, so a pick shows at once instead
  // of snapping back until the server render lands.
  const { pending, push, clearAll } = usePendingFilters(navigate, navigating);
  const f = overlayBrowseFilters(filters, pending);

  const hasFilters = hasActiveFilters(f);
  const sortedProviders = sortProviders(watchProviders ?? []);
  const rating = activeRatingValue(f);
  const chips = filterChips(f, { genres, providers: sortedProviders, showCertification }, t);

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
        <FilterSelect
          label={t("media.filter.genreLabel")}
          value={f.genreId ?? ""}
          onChange={(v) => push({ genreId: v || undefined })}
          options={[{ value: "", label: t("media.filter.allGenres") }, ...genres.map((g) => ({ value: String(g.id), label: g.name }))]}
        />

        {sortedProviders.length > 0 && (
          <FilterSelect
            label={t("media.filter.serviceLabel")}
            value={f.watchProvider ?? ""}
            onChange={(v) => push({ watchProvider: v || undefined })}
            options={[
              { value: "", label: t("media.filter.allServices") },
              ...sortedProviders.map((p) => ({ value: String(p.provider_id), label: p.provider_name })),
            ]}
          />
        )}

        {showCertification && (
          <FilterSelect
            label={t("media.filter.certLabel")}
            value={f.certification ?? ""}
            onChange={(v) => push({ certification: v || undefined })}
            options={[
              { value: "", label: t("media.filter.certAny") },
              ...CERTIFICATION_CAPS.map((c) => ({ value: c, label: t("media.filter.certUpTo", { rating: c }) })),
            ]}
          />
        )}

        <FilterSelect
          label={t("media.filter.minRatingLabel")}
          value={rating}
          onChange={(v) => push(ratingDelta(v))}
          options={ratingSelectOptions(t, rating)}
        />

        <FilterSelect
          label={t("media.filter.minVotesLabel")}
          value={f.minVoteCount ?? ""}
          onChange={(v) => push({ minVoteCount: v || undefined })}
          options={optionsWithActive(VOTE_COUNT_OPTIONS, f.minVoteCount).map((v) => ({ value: v, label: voteCountLabel(t, v) }))}
        />

        <FilterSelect
          label={t("media.filter.fromYearLabel")}
          value={f.fromYear ?? ""}
          onChange={(v) => push({ fromYear: v || undefined })}
          options={[{ value: "", label: t("media.filter.fromYear") }, ...years.map((y) => ({ value: y, label: y }))]}
        />

        <FilterSelect
          label={t("media.filter.toYearLabel")}
          value={f.toYear ?? ""}
          onChange={(v) => push({ toYear: v || undefined })}
          options={[{ value: "", label: t("media.filter.toYear") }, ...years.map((y) => ({ value: y, label: y }))]}
        />

        <FilterToggleButton
          pressed={f.hideAvailable}
          onClick={() => push({ hideAvailable: f.hideAvailable ? undefined : "1" })}
        >
          {t("media.hideAvailable")}
        </FilterToggleButton>

        {hasFilters && <ClearFiltersButton onClick={clearAll} />}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <RemovableChip key={c.key} label={c.label} onRemove={() => push(c.remove)} />
          ))}
        </div>
      )}
    </div>
  );
}

// One compact labelled select of the filter row.
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode }[];
}) {
  return (
    <StyledSelect compact aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </StyledSelect>
  );
}

function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
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
  );
}
