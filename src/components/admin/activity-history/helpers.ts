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

// A YYYY-MM-DD day filter means a whole calendar day in the statistics time zone,
// the zone every per-day count is bucketed in — including the activity heatmap,
// whose cells link here as ?from=&to=. The day is sent as is (fromDay/toDay) and
// the SERVER turns it into that zone's midnights: the browser can't know the
// zone's offset on that date, and the admin's own midnight would not match the
// day the cell counted. A malformed or impossible date (2026-13-01, or
// 2026-02-30, which Date silently rolls forward to Mar 2) is dropped here rather
// than sent, since the API answers it with a 400.
function validDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  const start = new Date(Date.UTC(year, month - 1, date));
  if (
    Number.isNaN(start.getTime()) ||
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== date
  ) {
    return null;
  }
  return day;
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
  const from = fromDate ? validDay(fromDate) : null;
  const to = toDate ? validDay(toDate) : null;
  if (from) {
    params.set("fromDay", from);
  } else if (startDateIso) {
    params.set("startDate", startDateIso);
  }
  if (to) params.set("toDay", to);
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
