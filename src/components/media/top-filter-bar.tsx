"use client";

import { useMemo, useTransition, type ReactNode } from "react";
import { X } from "@/components/icons";
import { StyledSelect } from "@/components/ui/styled-select";
import { FilterBar as Segments } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import { pendingFlag, pendingValue } from "@/lib/browse-filters";
import type { Translator } from "@/lib/i18n/translate";
import { voteCountLabel } from "./filter-bar";
import { RemovableChip, buildYears } from "./filter-chip";
import { usePendingFilters } from "./use-pending-filters";

interface TopFilterBarProps {
  activeMediaType?: string;
  activeSortBy?: string;
  activeMinImdb?: string;
  activeMinVotes?: string;
  activeFromYear?: string;
  activeToYear?: string;
  activeHideAvailable?: boolean;
  // See filter-bar.tsx — `maxYear` arrives as a prop from the server so SSR
  // and CSR render the same `<option>` list. DO NOT switch back to a
  // module-level `new Date()` here.
  maxYear: number;
}

// The sorts, once: the segmented control's label and the "Sort: …" chip's
// name both come from here. Brand names stay literal; MDBList's chip name
// carries a translatable word, so it is a catalog key.
//
// Five segments overflowed a 375px track: the design-system FilterBar hides its
// scrollbar and has no edge fade, so "MDBList" (and part of "Trakt") was simply
// cut off with nothing saying more existed. The longest brand abbreviates below
// `sm`; the full name stays the accessible name at every width (sr-only on
// phones, shown from sm — never two names in flow at once).
type SortName = { brand: string } | { key: string };
interface SortOption {
  value: string;
  name: SortName;
  segment?: ReactNode;
}

const SORTS: readonly SortOption[] = [
  { value: "", name: { brand: "IMDb" } },
  { value: "letterboxd", name: { brand: "Letterboxd" } },
  {
    value: "rt",
    name: { brand: "Rotten Tomatoes" },
    segment: (
      <>
        <span aria-hidden="true" className="sm:hidden">RT</span>
        <span className="sr-only sm:not-sr-only">Rotten Tomatoes</span>
      </>
    ),
  },
  { value: "trakt", name: { brand: "Trakt" } },
  { value: "mdblist", name: { key: "media.filter.mdblistScore" }, segment: "MDBList" },
];

const SORT_SEGMENTS: { value: string; label: ReactNode }[] = SORTS.map((o) => ({
  value: o.value,
  label: o.segment ?? ("brand" in o.name ? o.name.brand : o.value),
}));

function sortName(t: Translator, value: string): string {
  const o = SORTS.find((x) => x.value === value);
  if (!o) return value;
  return "brand" in o.name ? o.name.brand : t(o.name.key);
}

const IMDB_OPTIONS: { value: string; label?: string }[] = [
  { value: "" },
  { value: "6",   label: "IMDb 6+" },
  { value: "6.5", label: "IMDb 6.5+" },
  { value: "7",   label: "IMDb 7+" },
  { value: "7.5", label: "IMDb 7.5+" },
  { value: "8",   label: "IMDb 8+" },
  { value: "8.5", label: "IMDb 8.5+" },
  { value: "9",   label: "IMDb 9+" },
];

const VOTE_OPTIONS = ["", "500", "1000", "5000", "10000", "50000"];

// The /top filters as shown (committed values overlaid with the pending delta).
interface TopFilters {
  mediaType?: string;
  sortBy?: string;
  minImdb?: string;
  minVotes?: string;
  fromYear?: string;
  toYear?: string;
  hideAvailable: boolean;
}

type FilterPatch = Record<string, string | undefined>;

// One chip per active filter, in display order, each with the patch that
// removes it.
function topFilterChips(f: TopFilters, t: Translator): { key: string; label: string; remove: FilterPatch }[] {
  const chips: { key: string; label: string; remove: FilterPatch }[] = [];
  if (f.mediaType) {
    chips.push({ key: "mediaType", label: f.mediaType === "tv" ? t("media.filter.tvOnly") : t("media.filter.moviesOnly"), remove: { mediaType: undefined } });
  }
  if (f.sortBy) {
    chips.push({ key: "sortBy", label: t("media.filter.sortChip", { label: sortName(t, f.sortBy) }), remove: { sortBy: undefined } });
  }
  if (f.minImdb) {
    chips.push({
      key: "minImdb",
      label: IMDB_OPTIONS.find((o) => o.value === f.minImdb)?.label ?? `IMDb ${f.minImdb}+`,
      remove: { minImdb: undefined },
    });
  }
  if (f.minVotes) chips.push({ key: "minVotes", label: voteCountLabel(t, f.minVotes), remove: { minVotes: undefined } });
  if (f.fromYear) chips.push({ key: "fromYear", label: t("media.filter.fromChip", { year: f.fromYear }), remove: { fromYear: undefined } });
  if (f.toYear) chips.push({ key: "toYear", label: t("media.filter.toChip", { year: f.toYear }), remove: { toYear: undefined } });
  if (f.hideAvailable) chips.push({ key: "hideAvailable", label: t("media.filter.hidingAvailable"), remove: { hideAvailable: undefined } });
  return chips;
}

// A compact select for one filter; "" is the "any" option.
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  children: ReactNode;
}) {
  return (
    <StyledSelect
      compact
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      {children}
    </StyledSelect>
  );
}

export function TopFilterBar({
  activeMediaType: committedMediaType,
  activeSortBy: committedSortBy,
  activeMinImdb: committedMinImdb,
  activeMinVotes: committedMinVotes,
  activeFromYear: committedFromYear,
  activeToYear: committedToYear,
  activeHideAvailable: committedHideAvailable = false,
  maxYear,
}: TopFilterBarProps) {
  const t = useT();
  const years = useMemo(() => buildYears(maxYear), [maxYear]);
  // /top re-fetches and re-ranks its whole pool on every change, so a push can
  // take a moment to land. Like PillFilter, mark the bar busy and dim it until
  // the new render arrives — the twin bar on /movies gets the same signal via
  // BrowseGrid's spinner; here the bar is the only client surface.
  const [isPending, startTransition] = useTransition();

  // Same pending-delta machinery as filter-bar.tsx (use-pending-filters.ts).
  // The props are the server's normalised COMMITTED values; each control shows
  // them overlaid with the change still in flight, so a pick doesn't snap back
  // and the hide-available button toggles from what it shows.
  const { pending, push, clearAll } = usePendingFilters(startTransition);
  const f: TopFilters = {
    mediaType: pendingValue(pending, "mediaType", committedMediaType),
    sortBy: pendingValue(pending, "sortBy", committedSortBy),
    minImdb: pendingValue(pending, "minImdb", committedMinImdb),
    minVotes: pendingValue(pending, "minVotes", committedMinVotes),
    fromYear: pendingValue(pending, "fromYear", committedFromYear),
    toYear: pendingValue(pending, "toYear", committedToYear),
    hideAvailable: pendingFlag(pending, "hideAvailable", committedHideAvailable),
  };
  const chips = topFilterChips(f, t);
  const hasFilters = chips.length > 0;

  return (
    <div
      className="flex flex-col gap-3 mb-6 transition-opacity"
      aria-busy={isPending || undefined}
      style={{ opacity: isPending ? 0.7 : 1 }}
    >
      <Segments
        segments={[
          { value: "both", label: t("browse.type.all") },
          { value: "movies", label: t("nav.movies") },
          { value: "tv", label: t("nav.tvShows") },
        ]}
        active={f.mediaType ?? "both"}
        onChange={(value) =>
          push({ mediaType: value === "both" ? undefined : value })
        }
        className="mb-0"
      />

      <Segments
        segments={SORT_SEGMENTS}
        active={f.sortBy ?? ""}
        onChange={(value) => push({ sortBy: value || undefined })}
        className="mb-0"
      />

      {/* One row, one height, one radius — see filter-bar.tsx: compact selects
          (h-8, 8px radius) beside minHeight-32 / radius-8 pills. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 items-center">
        <FilterSelect label={t("media.filter.minImdbLabel")} value={f.minImdb} onChange={(minImdb) => push({ minImdb })}>
          {IMDB_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label ?? t("media.filter.anyImdb")}</option>
          ))}
        </FilterSelect>

        <FilterSelect label={t("media.filter.minVotesLabel")} value={f.minVotes} onChange={(minVotes) => push({ minVotes })}>
          {VOTE_OPTIONS.map((votes) => (
            <option key={votes} value={votes}>{voteCountLabel(t, votes)}</option>
          ))}
        </FilterSelect>

        <FilterSelect label={t("media.filter.fromYearLabel")} value={f.fromYear} onChange={(fromYear) => push({ fromYear })}>
          <option value="">{t("media.filter.fromYear")}</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </FilterSelect>

        <FilterSelect label={t("media.filter.toYearLabel")} value={f.toYear} onChange={(toYear) => push({ toYear })}>
          <option value="">{t("media.filter.toYear")}</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </FilterSelect>

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

      {hasFilters && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <RemovableChip key={c.key} label={c.label} onRemove={() => push(c.remove)} />
          ))}
        </div>
      )}
    </div>
  );
}
