// Shared types for the admin history table (activity-history-table.tsx and
// the extracted pieces under this directory). The wire shapes derive from the
// runtime schemas in ./schema, so a row is exactly what the table checked.

import type { Infer } from "@/lib/validate";
import type { historyRowSchema, userOptionsSchema } from "./schema";

export type HistoryRow = Infer<typeof historyRowSchema>;

export type HistoryMediaType = NonNullable<HistoryRow["mediaType"]>;

export type MediaServerUserOption = Infer<typeof userOptionsSchema>[number];

export const SORT_FIELDS = ["startedAt", "title", "playDuration", "duration", "platform"] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDir = "asc" | "desc";

export type WatchedFilter = "" | "true" | "false";

// The stream methods the Stream filter offers (and the URL may carry).
export const PLAY_METHODS = ["DirectPlay", "DirectStream", "Transcode"] as const;

// The rows-per-page choices; the first page size a fresh table uses is
// DEFAULT_PAGE_SIZE.
export const PAGE_SIZES = [10, 25, 50, 100, 150, 200] as const;
export const DEFAULT_PAGE_SIZE = 25;

// The table's own filters ("" = no filter). `search` is the COMMITTED text:
// the input box holds its own draft and commits it after the debounce, so a
// keystroke never refetches or re-pages.
export interface HistoryFilters {
  search: string;
  watched: WatchedFilter;
  method: string;
  platform: string;
  userId: string;
  // YYYY-MM-DD, whole days in the statistics zone (the API reads them there).
  fromDate: string;
  toDate: string;
}

// Everything that decides which rows the table asks for.
export interface HistoryQuery {
  filters: HistoryFilters;
  // Resume-grouping, default on: one row per chain (latest segment + chain
  // aggregates). The API param is the inverse (`?ungrouped=true`) because the
  // server defaults to grouped.
  grouped: boolean;
  sortBy: SortField;
  sortDir: SortDir;
  limit: number;
  page: number;
}

// Every change but a page change starts again from page 1 (historyQueryReducer).
export type HistoryQueryAction =
  | { type: "filter"; patch: Partial<HistoryFilters> }
  | { type: "clearFilters" }
  | { type: "grouped"; grouped: boolean }
  | { type: "sort"; field: SortField }
  | { type: "limit"; limit: number }
  | { type: "page"; page: number };
