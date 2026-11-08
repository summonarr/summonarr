// The heatmap drill-down's read (heatmap-cell-popover.tsx): GET
// /api/admin/play-history/heatmap-cell, its answer checked against the route's
// own type before the popover renders it, and the pieces of its body the unit
// suite can read (tests/heatmap-cell-detail.test.mts).
import { withBasePath } from "@/lib/base-path";
import { fetchJson, type FetchJsonResult } from "@/lib/client/fetch-json";
import { v, type Infer } from "@/lib/validate";
import type { HeatmapCellDetail } from "@/lib/play-history";

const count = v.number();

export const HeatmapCellDetailSchema = v.object({
  totalPlays: v.number(),
  watchHours: v.number(),
  avgSessionMinutes: v.number(),
  completedCount: v.number(),
  completedPct: v.number(),
  methods: v.object({ directPlay: count, directStream: count, transcode: count, other: count }),
  topTranscodeReasons: v.array(v.object({ reason: v.string(), count })),
  source: v.object({ plex: count, jellyfin: count }),
  mediaType: v.object({ movie: count, tv: count, other: count }),
  avgBitrateMbps: v.number(),
  dataTransferredGb: v.number(),
  topResolutions: v.array(v.object({ resolution: v.string(), count })),
  network: v.object({ lan: count, wan: count, relay: count }),
  topTitles: v.array(v.object({ title: v.string(), tmdbId: v.nullable(v.number()), mediaType: v.nullable(v.string()), count })),
  topUsers: v.array(v.object({ id: v.string(), username: v.string(), count })),
});

// Both directions: a field the route adds or retypes fails to compile here
// until the schema follows it.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesRoute: Same<Infer<typeof HeatmapCellDetailSchema>, HeatmapCellDetail> = true;
void schemaMatchesRoute;

export function fetchHeatmapCell(queryString: string, signal: AbortSignal): Promise<FetchJsonResult<HeatmapCellDetail>> {
  return fetchJson(withBasePath(`/api/admin/play-history/heatmap-cell?${queryString}`), { schema: HeatmapCellDetailSchema, signal });
}

/**
 * What the popover says when the read failed: the route's own reason (already
 * in the viewer's language — a bad date, say), else a catalog key translated
 * at render. Never a transport message ("Failed to fetch") in browser English.
 */
export type CellLoadError = { text: string } | { key: string };

export function cellLoadError(res: Extract<FetchJsonResult<unknown>, { ok: false }>): CellLoadError {
  if (res.kind === "http" && res.error) return { text: res.error };
  return { key: "adminActivity.history.loadError" };
}

/** The present parts, joined with a middle dot: "LAN 6 · WAN 5". */
export function joinParts(parts: ReadonlyArray<string | null | false | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/** "75%" of a total; "0%" for an empty one. */
export function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";
}
