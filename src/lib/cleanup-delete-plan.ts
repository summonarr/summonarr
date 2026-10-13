// Pure halves of the shared cleanup delete flow (src/components/admin/cleanup-delete.tsx)
// and the Library cleanup page (src/components/admin/library-cleanup.tsx) — zero
// imports, so the unit runner loads it (the components are .tsx and it can't).

type PlanKey = { tmdbId: number; mediaType: "MOVIE" | "TV" };

// The execute body is built from the PLAN the admin confirmed, never from the
// live selection (guardrail 14b): the route checks only the target COUNT, so a
// selection changed after the dry run — or a title the dry run listed under
// Skipped — would otherwise be deleted under a count that happens to match.
// Only the keys go back; the route re-judges and re-resolves them itself.
export function cleanupExecuteBody(
  plan: { targetCount: number; items: ReadonlyArray<PlanKey> },
  blacklist: boolean,
): { items: PlanKey[]; blacklist: boolean; confirmTargets: number } {
  return {
    items: plan.items.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })),
    blacklist,
    confirmTargets: plan.targetCount,
  };
}

// Case, accents, punctuation and a trailing "(2005)" disambiguator don't make a
// different title — Sonarr appends the year to tell two shows apart.
function comparableTitle(s: string): string {
  return s
    .normalize("NFKD") // "é" → "e" + a combining mark the next strip removes
    .toLowerCase()
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// Whether the confirm panel must name the Radarr/Sonarr entry a target IS. A
// target found through TMDB's TVDB cross-reference (user-edited third-party
// data, guardrail 14a) can be a different series than the library title, and
// the delete removes ITS files — so a mismatch is shown, never hidden.
export function arrTitleDiffers(libraryTitle: string, arrTitle: string | null | undefined): boolean {
  if (!arrTitle) return false;
  const a = comparableTitle(libraryTitle);
  const b = comparableTitle(arrTitle);
  if (!a || !b) return libraryTitle.trim().toLowerCase() !== arrTitle.trim().toLowerCase();
  return a !== b;
}

// The rules draft after a report reload. The admin's unsaved edits survive
// every reload (a protect, a delete) except the one that follows their own save
// (`reset`); an unedited draft — equal to the settings it was taken from —
// follows the fresh settings. Equality is the page's own `dirty` test.
export function nextCleanupDraft<T>(draft: T | null, draftBase: T | null, fresh: T, reset: boolean): T {
  if (reset || draft === null || draftBase === null) return fresh;
  return JSON.stringify(draft) === JSON.stringify(draftBase) ? fresh : draft;
}

// After a Protect / Unprotect the Library cleanup page shows the change at once
// (applyLocalProtection) and reloads the report once the clicks stop: the
// report GET is uncached and limited to 30 a minute per admin, and a reload per
// click let an admin working down the list hit that limit — the newest reload
// was refused and the rows just protected still read "Protect". A reload waits
// for DEBOUNCE quiet, but never more than MAX_WAIT after the first click it
// covers, so steady clicking still reloads every few seconds (≤ 6 a minute).
export const PROTECT_RELOAD_DEBOUNCE_MS = 3_000;
export const PROTECT_RELOAD_MAX_WAIT_MS = 10_000;

export interface ReloadTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: ReloadTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CoalescedReload {
  // Asks for a reload; `fire` is the latest caller's loader.
  schedule(fire: () => void): void;
  // Drops the pending reload (any other load answers for it, or unmount).
  cancel(): void;
}

// One reload for a burst of schedule() calls: `debounceMs` after the last,
// `maxWaitMs` after the first at the latest. Two timers, no clock read.
export function createCoalescedReload(
  timers: ReloadTimers = realTimers,
  debounceMs = PROTECT_RELOAD_DEBOUNCE_MS,
  maxWaitMs = PROTECT_RELOAD_MAX_WAIT_MS,
): CoalescedReload {
  let quiet: unknown = null;
  let cap: unknown = null;
  let fire: (() => void) | null = null;
  const cancel = () => {
    if (quiet !== null) timers.clear(quiet);
    if (cap !== null) timers.clear(cap);
    quiet = null;
    cap = null;
    fire = null;
  };
  const run = () => {
    const f = fire;
    cancel();
    f?.();
  };
  return {
    schedule(f) {
      fire = f;
      if (quiet !== null) timers.clear(quiet);
      quiet = timers.set(run, debounceMs);
      if (cap === null) cap = timers.set(run, maxWaitMs);
    },
    cancel,
  };
}

type ProtectRow = { tmdbId: number; mediaType: string; excludedBy: readonly string[]; candidate: boolean };
type ProtectEntry = { tmdbId: number; mediaType: string; title: string | null; reason: string | null; createdAt: string };

// The report as the server will answer it after a Protect (`on`) or Unprotect
// of one title: its row gains or loses the "protected" exclusion (a row is a
// candidate exactly when nothing excludes it — it is only listed because a rule
// matched) and the protected list gains or loses the title. Display only; the
// coalesced reload replaces it with the server's answer.
export function applyLocalProtection<T extends { rows: ProtectRow[]; protected: ProtectEntry[] }>(
  report: T,
  title: { tmdbId: number; mediaType: string; title: string | null },
  on: boolean,
  createdAt: string,
): T {
  const same = (x: { tmdbId: number; mediaType: string }) => x.tmdbId === title.tmdbId && x.mediaType === title.mediaType;
  const rows = report.rows.map((r) => {
    if (!same(r)) return r;
    const others = r.excludedBy.filter((e) => e !== "protected");
    const excludedBy = on ? [...others, "protected"] : others;
    return { ...r, excludedBy, candidate: excludedBy.length === 0 };
  });
  const rest = report.protected.filter((p) => !same(p));
  const entry = { tmdbId: title.tmdbId, mediaType: title.mediaType, title: title.title, reason: null, createdAt } as T["protected"][number];
  return { ...report, rows, protected: on ? [entry, ...rest] : rest };
}
