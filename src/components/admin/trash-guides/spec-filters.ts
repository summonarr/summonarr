// What a TRaSH spec tab's filter chips, quick-select buttons and header count
// mean (spec-section.tsx). ONE predicate per word: "Managed" listed paused
// specs under the filter while the quick-select and the header count left
// them out, so the three disagreed on the same rows. Paused is its own state.
// Pure and directive-free (tests/trash-spec-filters.test.mts).
import type { SpecStatus } from "./types";

export const SPEC_FILTERS = ["all", "managed", "paused", "unmanaged", "errored"] as const;
export type SpecFilter = (typeof SPEC_FILTERS)[number];

// Literal keys (the i18n dead-key check can't see a built one). Paused reads
// as its status chip does.
export const SPEC_FILTER_LABEL_KEYS: Record<SpecFilter, string> = {
  all: "trash.spec.filter.all",
  managed: "trash.spec.filter.managed",
  paused: "trash.spec.status.paused",
  unmanaged: "trash.spec.filter.unmanaged",
  errored: "trash.spec.filter.errored",
};

type SpecState = Pick<SpecStatus, "application">;

/** Whether a spec is in a filter's set. */
export function specMatches(spec: SpecState, filter: SpecFilter): boolean {
  const app = spec.application;
  switch (filter) {
    case "all": return true;
    // Synced by the nightly run: applied here and not paused.
    case "managed": return app !== null && app.enabled;
    case "paused": return app !== null && !app.enabled;
    case "unmanaged": return app === null;
    case "errored": return app !== null && app.lastError !== null && app.lastError !== "";
  }
}

/** The rows a tab lists: the filter, then the search over name and trashId (case-insensitive). */
export function filterSpecs<S extends Pick<SpecStatus, "application" | "name" | "trashId">>(
  specs: readonly S[],
  filter: SpecFilter,
  search: string,
): S[] {
  const q = search.trim().toLowerCase();
  return specs.filter((s) => {
    if (!specMatches(s, filter)) return false;
    return !q || s.name.toLowerCase().includes(q) || s.trashId.toLowerCase().includes(q);
  });
}

/** How many of `specs` are in a filter's set: the header's counts. */
export function countSpecs(specs: readonly SpecState[], filter: SpecFilter): number {
  let n = 0;
  for (const s of specs) if (specMatches(s, filter)) n++;
  return n;
}
