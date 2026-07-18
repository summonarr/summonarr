// Pure helpers for the admin history table. No React, no state — the parent
// (activity-history-table.tsx) memoizes/threads these as needed.

import type { SortDir, SortField } from "./types";

// Format a millisecond offset as m:ss / h:mm:ss for marker labels in the
// session detail panel. Matches the formatter on the Now Playing card so the
// numbers line up visually.
export function fmtMarkerOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Filter/sort state serialized as query params for both the table fetch
// (/api/play-history) and the CSV/JSON export (/api/play-history/export).
// Field names mirror the parent component's state variables.
export interface HistoryFilterInput {
  globalSource?: string;
  globalMediaType?: string;
  startDateIso?: string;
  fromDate: string;
  toDate: string;
  debouncedSearch: string;
  watched: string;
  method: string;
  platform: string;
  userFilter: string;
  sortBy: SortField;
  sortDir: SortDir;
  grouped: boolean;
}

export function buildHistoryFilterParams({
  globalSource,
  globalMediaType,
  startDateIso,
  fromDate,
  toDate,
  debouncedSearch,
  watched,
  method,
  platform,
  userFilter,
  sortBy,
  sortDir,
  grouped,
}: HistoryFilterInput): URLSearchParams {
  const params = new URLSearchParams();
  if (globalSource) params.set("source", globalSource);
  if (globalMediaType) params.set("mediaType", globalMediaType);
  if (fromDate) {
    params.set("startDate", new Date(`${fromDate}T00:00:00`).toISOString());
  } else if (startDateIso) {
    params.set("startDate", startDateIso);
  }
  if (toDate)
    params.set("endDate", new Date(`${toDate}T23:59:59`).toISOString());
  if (debouncedSearch) params.set("search", debouncedSearch);
  if (watched) params.set("watched", watched);
  if (method) params.set("playMethod", method);
  if (platform) params.set("platform", platform);
  if (userFilter) params.set("userId", userFilter);
  params.set("sortBy", sortBy);
  params.set("sortDir", sortDir);
  // API defaults to grouped; only set the flag in the ungrouped case so a
  // bare-URL share still lands on the default-on behaviour.
  if (!grouped) params.set("ungrouped", "true");
  return params;
}
