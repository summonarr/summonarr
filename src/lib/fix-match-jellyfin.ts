import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, SafeFetchError } from "@/lib/safe-fetch";
import { jellyfinAdminHeaders, JELLYFIN_NO_COLLECTION_GROUPING } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { mediaInstanceLabel, type MediaInstanceKey } from "@/lib/media-instances";
import type { FixMatchReport } from "@/lib/fix-match-jobs";
import {
  FixMatchDiagnosticError,
  isRecord,
  pause,
  readJsonOrNull,
  refreshBestEffort,
  remoteProgress,
  stringOr,
  type FixMatchDiagnosticKey,
  type RemoteProgress,
} from "@/lib/fix-match-remote";

// The Jellyfin half of a fix-match remap: remote-search for a candidate carrying
// the correct TMDB id, apply it, refresh, then poll until Jellyfin confirms. The
// route's modes (fix-match-apply.ts) call fixJellyfinMatch once per copy.

// Jellyfin item ids are hex UUIDs. Stripping everything else breaks the taint
// from a DB-read or upstream-supplied string before it reaches an admin-key URL
// or the DB.
export function sanitizeJellyfinId(id: string): string {
  return id.replace(/[^0-9a-f-]/gi, "");
}

// ── Reading Jellyfin's answers (pure) ────────────────────────────────────────

/** The TMDB id in an item's `ProviderIds` (either casing), or null. */
export function providerTmdbId(item: unknown): string | null {
  if (!isRecord(item) || !isRecord(item.ProviderIds)) return null;
  const id = item.ProviderIds.Tmdb ?? item.ProviderIds.tmdb;
  return typeof id === "string" ? id : null;
}

/**
 * The name the confirmation fallback searches for. A Series item's Path is the
 * series FOLDER, so its name is the last segment; a Movie's Path is the video
 * file, so its title is the parent folder. A trailing "(Year)" is dropped.
 */
export function fallbackSearchTerm(filePath: string, mediaType: "MOVIE" | "TV"): string {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = (mediaType === "TV" ? segments.at(-1) : segments.at(-2)) ?? "";
  return name.replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

/** How many 5 s confirmation reads a remap gets. */
export function confirmAttemptsFor(background: boolean, applyTimedOut: boolean, mediaType: "MOVIE" | "TV"): number {
  // In background-job mode nothing is waiting on an HTTP request, so the only
  // cost of waiting longer is a slower "done" — while giving up early turns a
  // remap that LANDED into a "failed" report (seen live on a 300-episode show).
  // 120 × 5s ≈ 10 minutes. The synchronous contract keeps the shorter windows:
  // a reverse proxy cuts that request off long before ten minutes anyway.
  if (background) return 120;
  // ~2 extra minutes of polling when the refresh outlived the apply window, and
  // for EVERY series: a Series identify cascades across seasons/episodes, so its
  // new provider ids can become readable minutes after the Apply call returns.
  // Field-verified (2026-08): 13 series applies that "failed to confirm" in the
  // old 20s window had ALL landed correctly when inspected later. Success still
  // breaks out of the loop on the first confirming poll.
  return applyTimedOut || mediaType === "TV" ? 24 : 4;
}

/** One Jellyfin library's folders and its Nfo settings, as the diagnosis reads them. */
export type JellyfinLibraryConfig = { name: string; locations: string[]; nfoReader: boolean; nfoSaver: boolean };

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];

// Field semantics verified against the Jellyfin 10.11 LibraryOptions model:
// local metadata READERS are on by default and DisabledLocalMetadataReaders
// lists the ones turned off; the SAVER is MetadataSavers / SaveLocalMetadata.
/** A /Library/VirtualFolders answer, or null when it isn't a list. */
export function parseVirtualFolders(json: unknown): JellyfinLibraryConfig[] | null {
  if (!Array.isArray(json)) return null;
  const libraries: JellyfinLibraryConfig[] = [];
  for (const folder of json) {
    if (!isRecord(folder)) continue;
    const opts = isRecord(folder.LibraryOptions) ? folder.LibraryOptions : {};
    libraries.push({
      name: stringOr(folder.Name),
      locations: stringList(folder.Locations),
      nfoReader: !stringList(opts.DisabledLocalMetadataReaders).some((r) => r.toLowerCase() === "nfo"),
      nfoSaver: opts.SaveLocalMetadata === true || stringList(opts.MetadataSavers).some((s) => s.toLowerCase() === "nfo"),
    });
  }
  return libraries;
}

/** The library whose folders hold `filePath`, or null. */
export function owningLibrary(libraries: readonly JellyfinLibraryConfig[], filePath: string | null): JellyfinLibraryConfig | null {
  if (!filePath) return null;
  const path = filePath.replace(/\\/g, "/");
  return libraries.find((lib) => lib.locations.some((loc) => {
    const l = loc.replace(/\\/g, "/").replace(/\/$/, "");
    return !!l && (path === l || path.startsWith(l + "/"));
  })) ?? null;
}

/** What the confirmation polls observed when the window ran out unconfirmed. */
export type UnconfirmedObservation = {
  previousTmdbId: number;
  correctTmdbId: number;
  // The last TMDB id the item reported, and whether it is metadata-locked.
  lastSeenTmdbId: string | null;
  itemLocked: boolean;
  readFailures: number;
  attempts: number;
};

const unreadable = (o: UnconfirmedObservation) => o.attempts > 0 && o.readFailures >= o.attempts;

/** Only the "still the old id" diagnosis reads the owning library's configuration. */
export function needsLibraryProbe(o: UnconfirmedObservation): boolean {
  return !unreadable(o) && !o.itemLocked && o.lastSeenTmdbId === String(o.previousTmdbId);
}

const LIBRARY_NAME_MAX = 100;

// Post-mortem for an apply Jellyfin did not confirm in the poll window. Field
// data (2026-08, 13 series across three days) says an item still reporting the
// OLD id at this point is USUALLY a slow series refresh settling after our
// window — every sampled "failure" had actually landed when inspected later —
// so the message leads with "re-sync and check before retrying". A REPEATED
// landing back on the old id is the genuine-revert signature (a stale .nfo
// re-imported by the Nfo reader, or a locked item), so those are named as the
// repeat-offender explanation. `library` is null when its configuration could
// not be read, which degrades to the generic hint.
export function unconfirmedDiagnosis(
  o: UnconfirmedObservation,
  library: JellyfinLibraryConfig | null,
): { key: FixMatchDiagnosticKey; vars: Record<string, string | number> } {
  // Never read the item back at all. Every other branch infers from what
  // Jellyfin REPORTED, so with no successful read there is nothing to infer
  // from — blaming the metadata provider would send the operator to the wrong
  // system (seen live: 120/120 reads failed while the server returned nothing
  // for ten minutes). Whether the match landed is genuinely unknown.
  if (unreadable(o)) return { key: "apiAdmin.fixMatch.jellyfinUnreadable", vars: { tmdbId: o.correctTmdbId, attempts: o.attempts } };
  if (o.itemLocked) return { key: "apiAdmin.fixMatch.jellyfinLocked", vars: { tmdbId: o.correctTmdbId } };
  if (o.lastSeenTmdbId === String(o.previousTmdbId)) {
    const name = library?.name.trim().slice(0, LIBRARY_NAME_MAX) ?? "";
    if (library?.nfoReader && name) {
      return {
        key: library.nfoSaver ? "apiAdmin.fixMatch.jellyfinStillPreviousNfoSaver" : "apiAdmin.fixMatch.jellyfinStillPreviousNfo",
        vars: { previousTmdbId: o.previousTmdbId, library: name },
      };
    }
    return { key: "apiAdmin.fixMatch.jellyfinStillPrevious", vars: { previousTmdbId: o.previousTmdbId } };
  }
  return { key: "apiAdmin.fixMatch.jellyfinNotConfirmed", vars: { tmdbId: o.correctTmdbId } };
}

// ── Talking to the server ────────────────────────────────────────────────────

type JellyfinSession = { baseUrl: string; apiKey: string; headers: Record<string, string>; safeItemId: string; tag: string };

// `instance` selects WHICH configured Jellyfin server gets rewritten — same rule
// as the Plex path: the item id came from one server's library row and is only
// meaningful against that server.
async function openJellyfinSession(safeItemId: string, tag: string, instance: MediaInstanceKey): Promise<JellyfinSession> {
  const cfg = await getJellyfinConfig(instance);
  if (!cfg.url || !cfg.apiKey) throw new Error("Jellyfin server not configured");
  // Dual-send auth (Authorization: MediaBrowser + legacy X-MediaBrowser-Token):
  // RemoteSearch/Apply and /Items/{id}/Refresh are RequiresElevation endpoints,
  // and Jellyfin 10.12 stops reading the bare legacy header entirely (see
  // JELLYFIN_IDENTITY in jellyfin.ts) — a bare-token call would 401 here while
  // the admin-surface calls kept working.
  return { baseUrl: cfg.url.replace(/\/$/, ""), apiKey: cfg.apiKey, headers: jellyfinAdminHeaders(cfg.apiKey), safeItemId, tag };
}

const refreshUrl = (s: JellyfinSession, id: string) =>
  `${s.baseUrl}/Items/${id}/Refresh?MetadataRefreshMode=FullRefresh&ReplaceAllMetadata=true&ImageRefreshMode=FullRefresh&ReplaceAllImages=true`;

// The remote-search result carrying correctTmdbId, as Jellyfin sent it (it is
// posted back whole to Apply). Never searchResults[0]: fuzzy matching can make
// that a different title and remap the library item to the wrong media.
async function findRemoteCandidate(s: JellyfinSession, mediaType: "MOVIE" | "TV", correctTmdbId: number): Promise<Record<string, unknown>> {
  const res = await safeFetchAdminConfigured(`${s.baseUrl}/Items/RemoteSearch/${mediaType === "MOVIE" ? "Movie" : "Series"}`, {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({
      SearchInfo: { ProviderIds: { Tmdb: String(correctTmdbId) } },
      ItemId: s.safeItemId,
      IncludeDisabledProviders: true,
    }),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`Jellyfin remote search failed: ${res.status}`);
  const results = await readJsonOrNull(res);
  if (!Array.isArray(results)) throw new Error("Jellyfin remote search answer was not a list");
  const vars = { tmdbId: correctTmdbId };
  if (results.length === 0) throw new FixMatchDiagnosticError("apiAdmin.fixMatch.jellyfinNoCandidate", vars, "the search returned nothing");
  const target = results.find((r) => providerTmdbId(r) === String(correctTmdbId));
  if (!isRecord(target)) {
    throw new FixMatchDiagnosticError("apiAdmin.fixMatch.jellyfinNoCandidate", vars, `none of ${results.length} results carries it — refusing to apply a different match`);
  }
  return target;
}

// Jellyfin runs the identify's FullRefresh SYNCHRONOUSLY inside the Apply
// request, with CancellationToken.None (ItemLookupController.ApplySearchCriteria,
// verified against the 10.11.x source) — so a client-side timeout does NOT
// cancel the server-side work, and the match routinely lands moments after we
// hang up. True = the apply timed out: "still applying", answered with a LONGER
// confirmation poll instead of a failure. Any other failure (non-2xx, network,
// SSRF) still throws.
async function applyRemoteCandidate(s: JellyfinSession, candidate: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await safeFetchAdminConfigured(`${s.baseUrl}/Items/RemoteSearch/Apply/${s.safeItemId}?replaceAllImages=false`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify(candidate),
      timeoutMs: 90_000,
    });
    if (!res.ok) throw new Error(`Jellyfin apply match failed: ${res.status}`);
    return false;
  } catch (err) {
    if (!(err instanceof SafeFetchError) || err.reason !== "timeout") throw err;
    console.warn("[fix-match]", s.tag, "apply timed out client-side; Jellyfin is still refreshing — extending the confirmation poll");
    return true;
  }
}

// One confirmation read: the TMDB id the item reports and whether it is locked,
// or null when the read failed. A 200 whose body isn't JSON is a failed read
// too: the match is already applied, so it must not escape as the job's failure.
async function readItemState(s: JellyfinSession, itemId: string): Promise<{ tmdbId: string | null; locked: boolean } | null> {
  const res = await safeFetchAdminConfigured(`${s.baseUrl}/Items/${itemId}?Fields=ProviderIds`, { headers: s.headers, timeoutMs: 10_000 })
    .catch(() => null);
  const json = res?.ok ? await readJsonOrNull(res) : null;
  if (!isRecord(json)) return null;
  return { tmdbId: providerTmdbId(json), locked: json.LockData === true };
}

type ConfirmRun = {
  s: JellyfinSession;
  progress: RemoteProgress;
  push: () => void;
  correctTmdbId: number;
  mediaType: "MOVIE" | "TV";
  filePath: string | null;
  siblingItemIds: ReadonlySet<string>;
  targetCopies: () => Promise<ReadonlySet<string> | null>;
};

// The copies of the TARGET title this server already holds (the corrected row's
// ids) — the siblings' twin. A correctly matched copy (the 4K/HD twin guardrail
// 37 allows) carries the target id by construction, while the item being fixed
// is still named after the wrong title and may be missing from the name search
// entirely; accepting that copy "confirmed" this item without ever reading it.
// Read once, when the fallback first needs it; unreadable ⇒ null, and only the
// item's own path may confirm.
function targetCopiesReader(
  correctTmdbId: number, mediaType: "MOVIE" | "TV", instance: MediaInstanceKey, s: JellyfinSession,
): () => Promise<ReadonlySet<string> | null> {
  let read: Promise<ReadonlySet<string> | null> | null = null;
  return () => (read ??= (async () => {
    try {
      const row = await prisma.jellyfinLibraryItem.findUnique({
        where: { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance: instance } },
        select: { jellyfinItemId: true, jellyfinItemIds: true },
      });
      const ids = [...(row?.jellyfinItemId ? [row.jellyfinItemId] : []), ...(row?.jellyfinItemIds ?? [])].map(sanitizeJellyfinId);
      return new Set(ids.filter((id) => id !== s.safeItemId));
    } catch (err) {
      console.warn("[fix-match]", s.tag, "could not read the target title's copies; the fallback confirms by path only:", err instanceof Error ? err.message : err);
      return null;
    }
  })());
}

type FoundItem = { id: string | null; path: string | null; tmdbId: string | null };

// After a failed read, look the item up by name instead. The item's own path
// wins; any other hit must carry the target id and be neither a sibling copy of
// this title (one already remapped reports the correct id) nor a stored copy of
// the target title. Returns the id that CONFIRMS the match, the item's id at its
// own path (unconfirmed — read it there next time), or null.
async function locateByPath(run: ConfirmRun, filePath: string): Promise<{ id: string; confirmed: boolean } | null> {
  const { s, correctTmdbId } = run;
  const searchTerm = fallbackSearchTerm(filePath, run.mediaType);
  const res = await safeFetchAdminConfigured(
    // Without the flag a movie in a collection comes back as its BoxSet and the
    // path lookup below never finds it (guardrail 37d).
    `${s.baseUrl}/Items?Recursive=true&Fields=ProviderIds,Path&IncludeItemTypes=Movie,Series&${JELLYFIN_NO_COLLECTION_GROUPING}` +
    (searchTerm ? `&SearchTerm=${encodeURIComponent(searchTerm)}` : "") +
    `&Limit=50`,
    { headers: s.headers, timeoutMs: 10_000 },
  ).catch(() => null);
  if (!res?.ok) return null;
  const json = await readJsonOrNull(res);
  const listed = isRecord(json) && Array.isArray(json.Items) ? json.Items : [];
  const items: FoundItem[] = [];
  for (const raw of listed) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.Id === "string" ? raw.Id : null;
    if (id !== null && run.siblingItemIds.has(sanitizeJellyfinId(id))) continue;
    items.push({ id, path: typeof raw.Path === "string" ? raw.Path : null, tmdbId: providerTmdbId(raw) });
  }
  const byPath = items.find((i) => i.path === filePath);
  const others = byPath ? null : await run.targetCopies();
  const byTmdb = others
    ? items.find((i) => !(i.id !== null && others.has(sanitizeJellyfinId(i.id))) && i.tmdbId === String(correctTmdbId))
    : undefined;
  const found = byPath ?? byTmdb;
  // Sanitize the upstream-supplied Id before it lands in a URL and the DB.
  if (!found?.id) return null;
  return { id: sanitizeJellyfinId(found.id), confirmed: found.tmdbId === String(correctTmdbId) };
}

type ConfirmState = { confirmed: boolean; resolvedItemId: string; lastSeenTmdbId: string | null; itemLocked: boolean };

async function confirmJellyfinMatch(run: ConfirmRun, attempts: number): Promise<ConfirmState> {
  const { s, progress, push } = run;
  const state: ConfirmState = { confirmed: false, resolvedItemId: s.safeItemId, lastSeenTmdbId: null, itemLocked: false };
  progress.attempts = attempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await pause(5_000);
    progress.attempt = attempt + 1;
    push();
    const read = await readItemState(s, state.resolvedItemId);
    if (read === null) {
      // A read that errors or times out is the media server being busy with
      // its own refresh, not a verdict — say so once (and every 10th time) so
      // a long wait is explained in the log instead of looking stuck.
      progress.readFailures++;
      if (progress.readFailures === 1 || progress.readFailures % 10 === 0) {
        console.warn("[fix-match]", s.tag, `confirmation read failed (${progress.readFailures} so far) — Jellyfin is usually busy refreshing; still polling`);
      }
      push();
      const hit = run.filePath ? await locateByPath(run, run.filePath) : null;
      if (hit) {
        state.resolvedItemId = hit.id;
        if (hit.confirmed) {
          state.confirmed = true;
          break;
        }
      }
      continue;
    }
    if (read.tmdbId !== null) state.lastSeenTmdbId = read.tmdbId;
    if (read.locked) state.itemLocked = true;
    if (read.tmdbId === String(run.correctTmdbId)) {
      state.confirmed = true;
      break;
    }
  }
  return state;
}

// Why the window ran out unconfirmed, for the admin. Only the "still the old id"
// case costs a request: the owning library's configuration names the Nfo hint.
async function diagnoseUnconfirmed(s: JellyfinSession, o: UnconfirmedObservation, filePath: string | null): Promise<FixMatchDiagnosticError> {
  let library: JellyfinLibraryConfig | null = null;
  if (needsLibraryProbe(o)) {
    const res = await safeFetchAdminConfigured(`${s.baseUrl}/Library/VirtualFolders`, { headers: s.headers, timeoutMs: 10_000 }).catch(() => null);
    const libraries = res?.ok ? parseVirtualFolders(await readJsonOrNull(res)) : null;
    library = libraries ? owningLibrary(libraries, filePath) : null;
  }
  const { key, vars } = unconfirmedDiagnosis(o, library);
  return new FixMatchDiagnosticError(key, vars);
}

export type FixJellyfinMatchOptions = {
  itemId: string;
  correctTmdbId: number;
  mediaType: "MOVIE" | "TV";
  instance: MediaInstanceKey;
  // The item's own path, for the confirmation fallback's name search; null
  // confirms only by reading the item itself.
  filePath: string | null;
  // The row's current (wrong) id — only used to diagnose an unconfirmed apply
  // (did the server revert to it?), never sent to Jellyfin.
  previousTmdbId: number;
  // Running as a job (guardrail 37a): nothing waits on an HTTP request, so the
  // confirmation window can be as long as the cascade needs.
  background: boolean;
  report?: FixMatchReport;
  // The OTHER copies of this title (guardrail 37). The fallback search must
  // never resolve to one of them: a sibling already remapped reports the
  // correct tmdbId, and accepting it would "confirm" THIS copy without ever
  // reading it — the unfixed copy then drops out of `jellyfinItemIds` with no
  // partial warning, and the next sync can elect it and revert the correction.
  siblingItemIds?: ReadonlySet<string>;
};

/**
 * Remaps a Jellyfin library item to the correct TMDB id and waits for Jellyfin
 * to confirm it — throws if it never does (a FixMatchDiagnosticError saying
 * what was observed), so the caller's DB write never records an id Jellyfin
 * did not confirm. Returns the (possibly new) item id.
 */
export async function fixJellyfinMatch(opts: FixJellyfinMatchOptions): Promise<{ newItemId: string; baseUrl: string; apiKey: string }> {
  const { correctTmdbId, mediaType } = opts;
  const safeItemId = sanitizeJellyfinId(opts.itemId);
  const tag = `[fix-match/${mediaInstanceLabel("jellyfin", opts.instance)} itemId=${safeItemId} target=tmdb:${correctTmdbId}]`;
  const { progress, push } = remoteProgress(opts.report);
  push();
  const s = await openJellyfinSession(safeItemId, tag, opts.instance);
  const candidate = await findRemoteCandidate(s, mediaType, correctTmdbId);

  progress.phase = "applying";
  push();
  const applyTimedOut = await applyRemoteCandidate(s, candidate);

  // Either way the media server now owns the remap: it accepted the new match
  // (2xx) or is still applying it (timeout) — from here Summonarr only waits.
  progress.remoteApplied = true;
  progress.phase = "confirming";
  push();
  // When the apply timed out, the server is already >90s deep in that apply's
  // own refresh — queueing a second one now only grows the backlog. It is
  // deferred to after confirmation so the image-replacement pass still happens.
  if (!applyTimedOut) await refreshBestEffort(refreshUrl(s, safeItemId), { method: "POST", headers: s.headers }, tag);

  const attempts = confirmAttemptsFor(opts.background, applyTimedOut, mediaType);
  const state = await confirmJellyfinMatch({
    s, progress, push, correctTmdbId, mediaType,
    filePath: opts.filePath,
    siblingItemIds: opts.siblingItemIds ?? new Set(),
    targetCopies: targetCopiesReader(correctTmdbId, mediaType, opts.instance, s),
  }, attempts);

  if (!state.confirmed) {
    if (applyTimedOut) throw new FixMatchDiagnosticError("apiAdmin.fixMatch.jellyfinStillProcessing", { tmdbId: correctTmdbId });
    throw await diagnoseUnconfirmed(s, {
      previousTmdbId: opts.previousTmdbId, correctTmdbId,
      lastSeenTmdbId: state.lastSeenTmdbId, itemLocked: state.itemLocked,
      readFailures: progress.readFailures, attempts,
    }, opts.filePath);
  }
  // The image-replacement refresh deferred above, now that the server has
  // confirmed the match and is no longer busy with the apply's own refresh.
  if (applyTimedOut) await refreshBestEffort(refreshUrl(s, state.resolvedItemId), { method: "POST", headers: s.headers }, tag);
  return { newItemId: state.resolvedItemId, baseUrl: s.baseUrl, apiKey: s.apiKey };
}
