"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { X } from "@/components/icons";
import { StyledSelect } from "@/components/ui/styled-select";
import { FilterBar as Segments } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import { voteCountLabel } from "./filter-bar";

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

// Chip labels for the active sort ("Sort: …"). Brand names stay literal; the
// MDBList one carries a translatable word, so it is a catalog key.
const SORT_OPTIONS: { value: string; label?: string; labelKey?: string }[] = [
  { value: "",           label: "IMDb" },
  { value: "letterboxd", label: "Letterboxd" },
  { value: "rt",         label: "Rotten Tomatoes" },
  { value: "trakt",      label: "Trakt" },
  { value: "mdblist",    labelKey: "media.filter.mdblistScore" },
];

// Concise labels for the segmented sort control (SORT_OPTIONS keeps the
// "Sort: …" prefix for the active-filter chips below).
//
// Five segments overflowed a 375px track: the design-system FilterBar hides its
// scrollbar and has no edge fade, so "MDBList" (and part of "Trakt") was simply
// cut off with nothing saying more existed. The longest brand abbreviates below
// `sm`; the full name stays the accessible name at every width (sr-only on
// phones, shown from sm — never two names in flow at once).
const SORT_SEGMENTS: { value: string; label: React.ReactNode }[] = [
  { value: "", label: "IMDb" },
  { value: "letterboxd", label: "Letterboxd" },
  {
    value: "rt",
    label: (
      <>
        <span aria-hidden="true" className="sm:hidden">RT</span>
        <span className="sr-only sm:not-sr-only">Rotten Tomatoes</span>
      </>
    ),
  },
  { value: "trakt", label: "Trakt" },
  { value: "mdblist", label: "MDBList" },
];

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

function buildYears(maxYear: number): string[] {
  return Array.from({ length: maxYear - 1899 }, (_, i) => String(maxYear - i));
}

export function TopFilterBar({
  activeMediaType,
  activeSortBy,
  activeMinImdb,
  activeMinVotes,
  activeFromYear,
  activeToYear,
  activeHideAvailable,
  maxYear,
}: TopFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useT();
  const years = useMemo(() => buildYears(maxYear), [maxYear]);
  // /top re-fetches and re-ranks its whole pool on every change, so a push can
  // take a moment to land. Like PillFilter, mark the bar busy and dim it until
  // the new render arrives — the twin bar on /movies gets the same signal via
  // BrowseGrid's spinner; here the bar is the only client surface.
  const [isPending, startTransition] = useTransition();

  // Filter changes we've pushed but the URL hasn't caught up with yet.
  // `searchParams` only shows the URL as it is NOW, and router.push is async,
  // so without this two quick changes in a row would build the second URL from
  // stale params and silently undo the first. Each entry is dropped once the
  // URL shows it. Same approach as filter-bar.tsx — see the longer note there.
  const pendingRef = useRef<Record<string, string | undefined>>({});
  const committed = searchParams.toString();

  useEffect(() => {
    const current = new URLSearchParams(committed);
    for (const [k, v] of Object.entries(pendingRef.current)) {
      const landed = v === undefined || v === "" ? current.get(k) === null : current.get(k) === v;
      if (landed) delete pendingRef.current[k];
    }
  }, [committed]);

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
    // Any filter change invalidates the current page number — the result set
    // it indexed into no longer exists. Without this a user on page 7 who
    // narrows to two pages of results lands on an out-of-range slice.
    // filter-bar.tsx does the same on its own push.
    params.delete("page");
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }, [router, pathname, searchParams]);

  const clearAll = useCallback(() => {
    pendingRef.current = {};
    startTransition(() => router.push(pathname));
  }, [router, pathname]);

  const hasFilters = !!(activeMediaType || activeSortBy || activeMinImdb || activeMinVotes || activeFromYear || activeToYear || activeHideAvailable);

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
        active={activeMediaType ?? "both"}
        onChange={(v) =>
          push({ mediaType: v === "both" ? undefined : v })
        }
        className="mb-0"
      />

      <Segments
        segments={SORT_SEGMENTS}
        active={activeSortBy ?? ""}
        onChange={(v) => push({ sortBy: v || undefined })}
        className="mb-0"
      />

      {/* One row, one height, one radius — see filter-bar.tsx: compact selects
          (h-8, 8px radius) beside minHeight-32 / radius-8 pills. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 items-center">
        <StyledSelect
          compact
          aria-label={t("media.filter.minImdbLabel")}
          value={activeMinImdb ?? ""}
          onChange={(e) => push({ minImdb: e.target.value || undefined })}
        >
          {IMDB_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label ?? t("media.filter.anyImdb")}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          compact
          aria-label={t("media.filter.minVotesLabel")}
          value={activeMinVotes ?? ""}
          onChange={(e) => push({ minVotes: e.target.value || undefined })}
        >
          {VOTE_OPTIONS.map((v) => (
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
          {activeMediaType && (
            <Chip label={activeMediaType === "movies" ? t("media.filter.moviesOnly") : t("media.filter.tvOnly")} onRemove={() => push({ mediaType: undefined })} />
          )}
          {activeSortBy && (
            <Chip
              label={(() => {
                const o = SORT_OPTIONS.find((x) => x.value === activeSortBy);
                const name = o ? (o.labelKey ? t(o.labelKey) : (o.label ?? activeSortBy)) : activeSortBy;
                return t("media.filter.sortChip", { label: name });
              })()}
              onRemove={() => push({ sortBy: undefined })}
            />
          )}
          {activeMinImdb && (
            <Chip
              label={IMDB_OPTIONS.find((o) => o.value === activeMinImdb)?.label ?? `IMDb ${activeMinImdb}+`}
              onRemove={() => push({ minImdb: undefined })}
            />
          )}
          {activeMinVotes && (
            <Chip
              label={voteCountLabel(t, activeMinVotes)}
              onRemove={() => push({ minVotes: undefined })}
            />
          )}
          {activeFromYear && (
            <Chip label={t("media.filter.fromChip", { year: activeFromYear })} onRemove={() => push({ fromYear: undefined })} />
          )}
          {activeToYear && (
            <Chip label={t("media.filter.toChip", { year: activeToYear })} onRemove={() => push({ toYear: undefined })} />
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
          // A 24px box is easy to tap. The negative margins shrink the space it
          // takes in the layout back to 12px (a 2px gap + the 10px icon), so
          // the chip stays the same size and the icon doesn't move.
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
