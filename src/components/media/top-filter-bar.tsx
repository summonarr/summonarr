"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { X } from "lucide-react";
import { StyledSelect } from "@/components/ui/styled-select";

interface TopFilterBarProps {
  activeMediaType?: string;
  activeSortBy?: string;
  activeMinImdb?: string;
  activeMinVotes?: string;
  activeFromYear?: string;
  activeToYear?: string;
  activeHideAvailable?: boolean;
}

const SORT_OPTIONS = [
  { value: "",           label: "Sort: IMDb" },
  { value: "letterboxd", label: "Sort: Letterboxd" },
  { value: "rt",         label: "Sort: Rotten Tomatoes" },
  { value: "trakt",      label: "Sort: Trakt" },
  { value: "mdblist",    label: "Sort: MDBList Score" },
];

const IMDB_OPTIONS = [
  { value: "",    label: "Any IMDb" },
  { value: "6",   label: "IMDb 6+" },
  { value: "6.5", label: "IMDb 6.5+" },
  { value: "7",   label: "IMDb 7+" },
  { value: "7.5", label: "IMDb 7.5+" },
  { value: "8",   label: "IMDb 8+" },
  { value: "8.5", label: "IMDb 8.5+" },
  { value: "9",   label: "IMDb 9+" },
];

const VOTE_OPTIONS = [
  { value: "",      label: "Any Votes" },
  { value: "500",   label: "500+ votes" },
  { value: "1000",  label: "1,000+ votes" },
  { value: "5000",  label: "5,000+ votes" },
  { value: "10000", label: "10,000+ votes" },
  { value: "50000", label: "50,000+ votes" },
];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: currentYear - 1899 }, (_, i) => String(currentYear - i));

export function TopFilterBar({
  activeMediaType,
  activeSortBy,
  activeMinImdb,
  activeMinVotes,
  activeFromYear,
  activeToYear,
  activeHideAvailable,
}: TopFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const push = useCallback((updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || v === "") params.delete(k);
      else params.set(k, v);
    }
    router.push(`${pathname}?${params.toString()}`);
  }, [router, pathname, searchParams]);

  const hasFilters = !!(activeMediaType || activeSortBy || activeMinImdb || activeMinVotes || activeFromYear || activeToYear || activeHideAvailable);

  return (
    <div className="flex flex-col gap-3 mb-8">
      <div
        className="ds-no-scrollbar inline-flex self-start overflow-x-auto"
        style={{
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        {(["both", "movies", "tv"] as const).map((type) => {
          const active = (activeMediaType ?? "both") === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => push({ mediaType: type === "both" ? undefined : type })}
              className="inline-flex items-center whitespace-nowrap font-medium transition-colors"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                border: 0,
                fontSize: 12,
                background: active ? "var(--ds-bg-3)" : "transparent",
                color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                cursor: "pointer",
              }}
            >
              {type === "both" ? "All" : type === "movies" ? "Movies" : "TV Shows"}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 items-center">
        <StyledSelect
          value={activeSortBy ?? ""}
          onChange={(e) => push({ sortBy: e.target.value || undefined })}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeMinImdb ?? ""}
          onChange={(e) => push({ minImdb: e.target.value || undefined })}
        >
          {IMDB_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </StyledSelect>

        <StyledSelect
          value={activeMinVotes ?? ""}
          onChange={(e) => push({ minVotes: e.target.value || undefined })}
        >
          {VOTE_OPTIONS.map((o) => (
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
          {activeMediaType && (
            <Chip label={activeMediaType === "movies" ? "Movies only" : "TV only"} onRemove={() => push({ mediaType: undefined })} />
          )}
          {activeSortBy && (
            <Chip
              label={SORT_OPTIONS.find((o) => o.value === activeSortBy)?.label ?? `Sort: ${activeSortBy}`}
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
              label={VOTE_OPTIONS.find((o) => o.value === activeMinVotes)?.label ?? `${activeMinVotes}+ votes`}
              onRemove={() => push({ minVotes: undefined })}
            />
          )}
          {activeFromYear && (
            <Chip label={`From ${activeFromYear}`} onRemove={() => push({ fromYear: undefined })} />
          )}
          {activeToYear && (
            <Chip label={`To ${activeToYear}`} onRemove={() => push({ toYear: undefined })} />
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
