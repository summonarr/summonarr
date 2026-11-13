// The search-param changes still in flight, shared by every usePendingSearchParam
// on a page (src/components/media/use-pending-search-param.ts). Browser-only
// state: one tab, one navigation at a time. Kept apart from the hook so
// tests/pending-query.test.mts can drive it without React.
import { withPending, type PendingDelta } from "@/lib/browse-filters";

let inFlight: { path: string; base: string; delta: PendingDelta } | null = null;

/** The query a change pushes: the committed one, plus changes still in flight against it, plus this one. */
export function nextPendingQuery(path: string, committed: string, param: string, value: string | undefined): string {
  const carried = inFlight && inFlight.path === path && inFlight.base === committed ? inFlight.delta : {};
  const delta: PendingDelta = { ...carried, [param]: value, page: undefined };
  inFlight = { path, base: committed, delta };
  return withPending(committed, delta).toString();
}

/** Drops the carried changes once the URL is no longer the one they were made against. */
export function settlePendingQuery(path: string, committed: string): void {
  if (inFlight && (inFlight.path !== path || inFlight.base !== committed)) inFlight = null;
}
