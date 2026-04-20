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
      {}
      <div className="inline-flex self-start rounded-lg border border-zinc-700 overflow-hidden text-sm">
        {(["both", "movies", "tv"] as const).map((type) => {
          const active = (activeMediaType ?? "both") === type;
          return (
            <button
              key={type}
              onClick={() => push({ mediaType: type === "both" ? undefined : type })}
              className={`px-4 py-1.5 whitespace-nowrap transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
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
          onClick={() => push({ hideAvailable: activeHideAvailable ? undefined : "1" })}
          className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
            activeHideAvailable
              ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-500"
          }`}
        >
          Hide Available
        </button>

        {hasFilters && (
          <button
            onClick={() => router.push(pathname)}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors px-2 py-1.5 rounded-lg border border-zinc-700 hover:border-zinc-500"
          >
            <X className="w-3 h-3" />
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
    <span className="flex items-center gap-1 text-xs bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-full px-2.5 py-0.5">
      {label}
      <button onClick={onRemove} className="hover:text-white transition-colors ml-0.5">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
