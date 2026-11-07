import { NextResponse } from "next/server";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { readJsonCapped } from "@/lib/body-size";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted, SafeFetchError } from "@/lib/safe-fetch";

import { tmdbAuth } from "@/lib/tmdb-auth";
import { getPlexEpisodesForShow } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinEpisodesForShow, jellyfinAdminHeaders, JELLYFIN_NO_COLLECTION_GROUPING } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { batchCreateMany, BATCH_TX_TIMEOUT, type EpisodeCacheRow } from "@/lib/cron-auth";
import { auditContext, logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { awaitFixMatchJob, FixMatchError, findRunningFixMatchJob, fixMatchJobKey, startFixMatchJob, type FixMatchJobResult, type FixMatchReport } from "@/lib/fix-match-jobs";
import {
  DEFAULT_MEDIA_INSTANCE,
  isValidMediaInstanceSlug,
  mediaInstanceLabel,
  type MediaInstanceKey,
} from "@/lib/media-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { clearCandidateCache } from "@/lib/fix-match-candidate-cache";
import { cachedTmdbTitle, plexAdminHeaders, tmdbDetailsCacheKey } from "@/lib/fix-match-shared";
import { resolveIssueAfterAction } from "@/lib/issue-transitions";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { carryMeta, JELLYFIN_META_KEYS, LIBRARY_META_KEYS, remainingOnOldRow, unionKeys } from "@/lib/fix-match-rows";
import { dropMatchFlagInTx, findMatchFlag, moveItemToTitleInTx, readLibraryMatchReport } from "@/lib/library-match-data";

const TMDB_HOSTS = ["api.themoviedb.org"];

type FixMatchBody = {
  server:         "plex" | "jellyfin";
  tmdbId:         number;
  mediaType:      "MOVIE" | "TV";
  correctTmdbId:  number;

  canonicalGuid?: string;
  // Run the remap as a background job and answer 202 + jobId at once (guardrail
  // 37a); the caller polls /api/admin/fix-match/status. Absent/false keeps the
  // synchronous contract the iOS client pins.
  async?: boolean;
  // Multi-server support: which configured server's library row to remap.
  // Optional + defaults to the default server ("") so an existing caller that
  // doesn't send it yet keeps targeting the only server that existed before
  // this field was added.
  serverInstance?: string;
  // Item mode: remap ONE server item (Plex ratingKey / Jellyfin item id) that
  // the library match check flagged, instead of every copy holding `tmdbId`.
  // The item's current id, media type and path come from the stored report —
  // `tmdbId` is ignored, and an item the check didn't flag is refused.
  itemKey?: string;
  // Background title mode only: the WRONG_MATCH issue this fix answers (the
  // issue dialog). The job closes it when the remap succeeds, with a note
  // naming `issueTitle` (the title picked, display only).
  issueId?: string;
  issueTitle?: string;
};

// Cuid-shaped; the issue itself is read (and bound to the title) at close time.
const ISSUE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISSUE_TITLE_MAX = 200;
// The PATCH route's resolution cap.
const RESOLUTION_MAX = 1000;

interface PlexSearchResult {
  guid:   string;
  name?:  string;
  year?:  number;
  Guid?:  Array<{ id: string }>;
}

// Thrown by fixPlexMatch when the unmatch PUT succeeded but no re-match was ever
// confirmed: the item now sits in Plex with NO match at all, which is a worse
// state than "nothing changed" and needs its own message (the DB row still
// carries the old id, so the next sync — keyed on a tmdb guid — drops the row
// and the title vanishes from availability until someone re-matches it in Plex).
class PlexUnmatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlexUnmatchedError";
  }
}

// Jellyfin item ids are hex UUIDs. Stripping everything else breaks the taint
// from a DB-read or upstream-supplied string before it reaches an admin-key URL
// or the DB.
function sanitizeJellyfinId(id: string): string {
  return id.replace(/[^0-9a-f-]/gi, "");
}

// A refresh queued after the match was APPLIED: best-effort, because the
// confirmation poll that follows is the sole success arbiter, so a transient
// refresh failure must not report the whole fix-match as failed.
async function refreshBestEffort(url: string, init: { method: string; headers: Record<string, string> }, tag: string): Promise<void> {
  await safeFetchAdminConfigured(url, { ...init, timeoutMs: 30_000 })
    .catch((e: unknown) => { console.warn("[fix-match]", tag, "refresh call failed (non-fatal):", e); return null; });
}

// Whether a /matches result names the title being fixed — by its TMDB or IMDb
// id, in the modern Guid list or a legacy agent guid.
function candidateCarriesTarget(c: PlexSearchResult, correctTmdbId: number, imdbId: string): boolean {
  const tmdb = String(correctTmdbId);
  const ids = Array.isArray(c.Guid) ? c.Guid.map((g) => (typeof g?.id === "string" ? g.id : "")) : [];
  if (ids.includes(`tmdb://${tmdb}`) || (!!imdbId && ids.includes(`imdb://${imdbId}`))) return true;
  const guid = typeof c.guid === "string" ? c.guid : "";
  if (new RegExp(`themoviedb://${tmdb}(?![0-9])`).test(guid)) return true;
  return /^tt\d+$/.test(imdbId) && new RegExp(`imdb://${imdbId}(?![0-9])`).test(guid);
}

// Fallback candidates applied live after the first match did not confirm. Each
// costs an apply, a refresh and a 30 s poll on the item, and holds a job slot
// while it does; the legacy-agent apply still runs after these.
const MAX_FALLBACK_ATTEMPTS = 3;

// Plays recorded while the item carried the wrong id keep it forever otherwise:
// resolveShowTmdbId / the poller read the library row at RECORD time, so a watch
// of the mismatched item landed on the old tmdbId, and after the remap the watch
// grade (guardrail 34a) still scores the request unwatched while activity views
// attribute the plays to the wrong title. Scoped to THIS source + instance —
// another server may legitimately hold the old id (guardrail 35) — and never by
// tmdbId alone. A movie play's `sourceItemId` is the item's own ratingKey /
// item id, so movies are pinned to the remapped ids; an EPISODE play's
// `sourceItemId` is the episode's key, not the show's, so TV is scoped on the
// library row's own key (tmdbId, mediaType, serverInstance): that row is the
// only one a play on this instance could have resolved the old id through.
function playReattributionWhere(
  source: "plex" | "jellyfin",
  serverInstance: string,
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  itemIds: string[],
) {
  return mediaType === "MOVIE"
    ? { source, serverInstance, tmdbId, mediaType: "MOVIE" as const, sourceItemId: { in: itemIds } }
    : { source, serverInstance, tmdbId, mediaType: "TV" as const };
}

// Remaps a Plex library item to the correct TMDB id: unmatch, re-match (via a
// GUID search across imdb/tmdb agents, else a raw tmdb:// fallback), then poll
// until Plex confirms — throws if it never confirms. Returns conflated=true when
// Plex has permanently merged two TMDB ids into one hash but IMDB confirms the film.
//
// `instance` selects WHICH configured Plex server gets rewritten and MUST be the
// same slug the caller used to read the library row: a Plex ratingKey is a small
// server-local integer, so replaying one server's key against another server's
// API remaps an unrelated item. It is threaded, never defaulted, for that reason.
//
// `cleanBundles` runs Plex's library-wide bundle clean between the unmatch and
// the first match, clearing stale metadata bundles before the re-match. It is
// server-wide maintenance, so a multi-copy title asks for it on its first copy
// only.
async function fixPlexMatch(
  ratingKey: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  instance: MediaInstanceKey,
  preselectedGuid: string | undefined,
  report: FixMatchReport | undefined,
  cleanBundles: boolean,
): Promise<{ conflated: boolean; serverUrl: string; token: string }> {
  // Progress the job exposes to the UI (no-op on the synchronous path). Plex used
  // to report once, so a multi-minute search/confirm cascade looked frozen.
  const progress: Parameters<FixMatchReport>[0] = { phase: "searching", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 };
  const push = () => report?.({ ...progress });
  push();
  // Plex rating keys are always integers; coerce to break taint from a DB-read
  // string before it's interpolated into any admin-token URL below.
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const tag = `[fix-match/${mediaInstanceLabel("plex", instance)} ratingKey=${safeKey} target=tmdb://${correctTmdbId}]`;

  const plexConfig = await getPlexConfig(instance);
  if (!plexConfig.url || !plexConfig.token) throw new Error("Plex server not configured");

  const serverUrl = plexConfig.url.replace(/\/$/, "");

  const token = plexConfig.token;
  const headers = plexAdminHeaders(token);

  let title   = "";
  let year    = "";
  let imdbId  = "";

  const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: tmdbDetailsCacheKey(mediaType, correctTmdbId) }, select: { data: true } });
  if (cacheRow) {
    try {
      const parsed = JSON.parse(cacheRow.data) as { title?: string; name?: string; releaseYear?: string; imdbId?: string | null };
      title  = parsed.title ?? parsed.name ?? "";
      year   = parsed.releaseYear?.slice(0, 4) ?? "";
      imdbId = parsed.imdbId ?? "";
    } catch { }
  }

  if (!title) {
    const metaRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}`, {
      headers,
      timeoutMs: 15_000,
    });
    if (metaRes.ok) {
      const metaJson = await metaRes.json() as { MediaContainer?: { Metadata?: Array<{ title?: string; year?: number }> } };
      const meta = metaJson?.MediaContainer?.Metadata?.[0];
      title = meta?.title ?? "";
      year  = meta?.year  ? String(meta.year) : "";
    } else {
      console.warn("[fix-match]", `${tag} Plex metadata fetch failed: ${metaRes.status}`);
    }
  }

  if (!imdbId) {
    const tAuth = tmdbAuth();
    if (tAuth) {
      const mediaTypePath = mediaType === "MOVIE" ? "movie" : "tv";
      const extUrl = new URL(`https://api.themoviedb.org/3/${mediaTypePath}/${correctTmdbId}/external_ids`);
      for (const [k, v] of Object.entries(tAuth.query)) extUrl.searchParams.set(k, v);
      const extRes = await safeFetchTrusted(extUrl.toString(), {
        allowedHosts: TMDB_HOSTS,
        headers: tAuth.headers,
        timeoutMs: 10_000,
      }).catch(() => null);
      if (extRes?.ok) {
        const ext = await extRes.json() as { imdb_id?: string | null };
        imdbId = ext.imdb_id ?? "";
      } else {
        console.warn("[fix-match]", `${tag} TMDB external_ids fetch failed: ${extRes?.status ?? "network error"}`);
      }
    } else {
      console.warn("[fix-match]", `${tag} No TMDB credentials set (TMDB_READ_TOKEN) — cannot fetch IMDB ID`);
    }
  }

  let canonicalGuid: string | null = preselectedGuid ?? null;
  let matchName = title;
  let matchYear = year;

  if (!canonicalGuid) {
    const plexMatchSearch = async (params: Record<string, string>): Promise<PlexSearchResult | null> => {
      const res = await safeFetchAdminConfigured(
        `${serverUrl}/library/metadata/${safeKey}/matches?` + new URLSearchParams(params),
        { headers, timeoutMs: 30_000 },
      ).catch(() => null);
      if (!res?.ok) return null;
      const json = await res.json() as { MediaContainer?: { SearchResult?: PlexSearchResult[] } };
      const results = json?.MediaContainer?.SearchResult ?? [];
      return results[0] ?? null;
    };

    // The first search to answer wins: its guid, and the name/year it reports.
    const takeHit = (hit: PlexSearchResult | null): void => {
      if (!hit) return;
      canonicalGuid = hit.guid;
      if (hit.name) matchName = hit.name;
      if (hit.year) matchYear = String(hit.year);
    };

    if (imdbId) {
      takeHit(await plexMatchSearch({ manual: "1", includeGuids: "1", guid: `imdb://${imdbId}` }));
    }

    if (imdbId && !canonicalGuid) {
      takeHit(await plexMatchSearch({
        manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en",
      }));
    }

    if (!canonicalGuid) {
      takeHit(await plexMatchSearch({
        manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en",
      }));
    }

    if (!canonicalGuid) {
      const textParams: Record<string, string> = { manual: "1", includeGuids: "1" };
      if (title) textParams.title = title;
      if (year)  textParams.year  = year;
      takeHit(await plexMatchSearch(textParams));
      if (!canonicalGuid) console.warn("[fix-match]", `${tag} all search strategies found no candidates — will use raw tmdb:// fallback`);
    }
  }

  // Remember whether the unmatch actually landed: from here on a failure to
  // re-match leaves the item UNMATCHED in Plex, not merely unchanged, and the
  // final throw below has to say so.
  progress.phase = "applying";
  push();
  const unmatchRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}/unmatch`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  }).catch(() => null);
  const unmatched = unmatchRes?.ok === true;

  if (cleanBundles) {
    await safeFetchAdminConfigured(`${serverUrl}/library/clean/bundles`, {
      method: "PUT",
      headers,
      timeoutMs: 60_000,
    }).catch(() => null);
  }

  await new Promise((r) => setTimeout(r, 3_000));

  const applyMatch = async (guid: string, name: string, yr: string): Promise<Response> => {
    const params: Record<string, string> = { guid };
    if (name) params.name = name;
    if (yr)   params.year = yr;
    const url = `${serverUrl}/library/metadata/${safeKey}/match?` + new URLSearchParams(params);
    return safeFetchAdminConfigured(url, { method: "PUT", headers, timeoutMs: 30_000 });
  };

  try {
    if (canonicalGuid) {
      const res = await applyMatch(canonicalGuid, matchName, matchYear);
      if (!res.ok) throw new Error(`Plex fix-match failed with canonical guid: ${res.status}`);
    } else {
      const modernRes = await applyMatch(`tmdb://${correctTmdbId}`, title, year);
      if (!modernRes.ok) {
        const legacyRes = await applyMatch(`com.plexapp.agents.themoviedb://${correctTmdbId}?lang=en`, title, year);
        if (!legacyRes.ok) {
          throw new Error(`Plex fix-match failed: ${modernRes.status} (tmdb://), ${legacyRes.status} (legacy) — and match search returned no result for TMDB #${correctTmdbId}`);
        }
      }
    }
  } catch (err) {
    // Once the unmatch landed, ANY apply failure — a refusal, a timeout, a
    // dropped connection — leaves the item UNMATCHED, not unchanged. The detail
    // stays in the message for the server log.
    if (unmatched && !(err instanceof PlexUnmatchedError)) {
      throw new PlexUnmatchedError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }

  // Best-effort, like the Jellyfin path's refresh: the match was already
  // APPLIED above, and pollForConfirmation below is the sole success arbiter.
  await refreshBestEffort(`${serverUrl}/library/metadata/${safeKey}/refresh?force=1`, { method: "PUT", headers }, tag);

  // The match was APPLIED; from here Summonarr only waits for Plex to confirm it.
  progress.remoteApplied = true;
  progress.phase = "confirming";
  push();

  const pollForConfirmation = async (
    maxAttempts: number,
    intervalMs: number,
  ): Promise<{ confirmed: boolean; conflatedMerge: boolean; plexTmdbId?: string; plexImdbId?: string }> => {
    let plexTmdbId: string | undefined;
    let plexImdbId: string | undefined;
    progress.attempts = maxAttempts;
    progress.attempt = 0;
    push();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      progress.attempt = attempt + 1;
      push();
      const checkRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}?includeGuids=1`, {
        headers,
        timeoutMs: 10_000,
      }).catch(() => null);
      // A body that isn't JSON counts as a failed read, like a non-2xx: the
      // match is already applied, so it must not escape as a failure.
      const checkJson = checkRes?.ok
        ? await checkRes.json().catch(() => null) as { MediaContainer?: { Metadata?: unknown } } | null
        : null;
      if (checkJson === null || typeof checkJson !== "object") {
        progress.readFailures++;
        push();
        continue;
      }
      const metadata = checkJson.MediaContainer?.Metadata;
      const item = (Array.isArray(metadata) ? metadata[0] : undefined) as { guid?: unknown; Guid?: unknown } | undefined;
      const legacyGuid = typeof item?.guid === "string" ? item.guid : "";
      const guidIds = Array.isArray(item?.Guid)
        ? (item.Guid as unknown[]).map((g) => (g as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string")
        : [];
      plexTmdbId = guidIds.find((id) => id.startsWith("tmdb://"))?.replace("tmdb://", "")
                 ?? /themoviedb:\/\/(\d+)/.exec(legacyGuid)?.[1];
      plexImdbId = guidIds.find((id) => id.startsWith("imdb://"))?.replace("imdb://", "");

      const tmdbConfirmed =
        plexTmdbId === String(correctTmdbId) ||
        /themoviedb:\/\/(\d+)/.exec(legacyGuid)?.[1] === String(correctTmdbId);

      const hasOtherTmdb = guidIds.some((id) => id.startsWith("tmdb://") && id !== `tmdb://${correctTmdbId}`);
      const imdbConfirmed = !!imdbId && plexImdbId === imdbId && !hasOtherTmdb;

      const conflated = !tmdbConfirmed &&
        guidIds.includes(`tmdb://${correctTmdbId}`) &&
        plexTmdbId !== String(correctTmdbId);
      if (tmdbConfirmed) return { confirmed: true, conflatedMerge: false, plexTmdbId, plexImdbId };
      if (imdbConfirmed) {
        console.warn("[fix-match]",
          `${tag} IMDB confirmed (imdb://${imdbId}) but Plex primary tmdb is ${plexTmdbId} ` +
          `instead of ${correctTmdbId} — likely duplicate TMDB entries for same film. Treating as matched.`,
        );
        return { confirmed: true, conflatedMerge: false, plexTmdbId, plexImdbId };
      }
      if (conflated) {
        console.warn("[fix-match]",
          `${tag} Plex has both tmdb://${plexTmdbId} (primary) and tmdb://${correctTmdbId} on the same hash — ` +
          `conflated IDs. Primary is wrong; breaking immediately to try legacy agent.`,
        );

        return { confirmed: false, conflatedMerge: true, plexTmdbId, plexImdbId };
      }
    }
    return { confirmed: false, conflatedMerge: false, plexTmdbId, plexImdbId };
  };

  const modern = await pollForConfirmation(10, 3_000);

  let pollConfirmed   = modern.confirmed;
  let allConflated    = modern.conflatedMerge;
  let plexTmdbId      = modern.plexTmdbId;
  let plexImdbId      = modern.plexImdbId;

  if (!pollConfirmed) {
    console.warn("[fix-match]",
      `${tag} modern match resolved to tmdb://${plexTmdbId ?? "?"} imdb://${plexImdbId ?? "?"} — ` +
      `our target is tmdb://${correctTmdbId} imdb://${imdbId || "unknown"}.`,
    );

    if (allConflated) {
      console.warn("[fix-match]",
        `${tag} conflated IDs detected on first poll — skipping fallback attempts. ` +
        `Plex has multiple metadata bundles on disk that conflict. ` +
        `The DB will be updated if IMDB confirms the correct film.`,
      );
    } else {
      const tryGuid = async (guid: string, name: string, yr: string): Promise<boolean> => {
        // A thrown apply is a refused one: the outcome below still reports
        // the state the item is left in.
        const res = await applyMatch(guid, name, yr).catch(() => null);
        if (!res?.ok) return false;
        await refreshBestEffort(`${serverUrl}/library/metadata/${safeKey}/refresh?force=1`, { method: "PUT", headers }, tag);
        const poll = await pollForConfirmation(6, 5_000);
        plexTmdbId = poll.plexTmdbId;
        plexImdbId = poll.plexImdbId;
        if (!poll.conflatedMerge) allConflated = false;
        if (poll.confirmed) { pollConfirmed = true; return true; }
        if (poll.conflatedMerge) { allConflated = true; return false; }
        return false;
      };

      const alreadyTriedGuid = canonicalGuid;
      const altSearches: Array<Record<string, string>> = [];
      if (imdbId) {
        altSearches.push({ manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" });
      }
      altSearches.push({ manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" });

      // Only a result that names the target (its TMDB or IMDb id) is applied,
      // and at most MAX_FALLBACK_ATTEMPTS of them: each is applied live to the
      // item and polled, so every unrelated hit cost minutes of a job slot and
      // left the item matched to it until the next try.
      const tried = new Set<string>(alreadyTriedGuid ? [alreadyTriedGuid] : []);
      let attempts = 0;
      for (const params of altSearches) {
        if (pollConfirmed || allConflated || attempts >= MAX_FALLBACK_ATTEMPTS) break;
        const res = await safeFetchAdminConfigured(
          `${serverUrl}/library/metadata/${safeKey}/matches?` + new URLSearchParams(params),
          { headers, timeoutMs: 30_000 },
        ).catch(() => null);
        if (!res?.ok) continue;
        const json = await res.json().catch(() => null) as { MediaContainer?: { SearchResult?: unknown } } | null;
        const results = json?.MediaContainer?.SearchResult;
        if (!Array.isArray(results)) continue;
        for (const c of results as PlexSearchResult[]) {
          if (c === null || typeof c !== "object" || typeof c.guid !== "string" || tried.has(c.guid)) continue;
          if (!candidateCarriesTarget(c, correctTmdbId, imdbId)) continue;
          if (attempts >= MAX_FALLBACK_ATTEMPTS) break;
          tried.add(c.guid);
          attempts++;
          if (await tryGuid(c.guid, c.name ?? title, c.year ? String(c.year) : year)) break;
          if (allConflated) break;
        }
      }

      if (!pollConfirmed && !allConflated) {
        await tryGuid(`com.plexapp.agents.themoviedb://${correctTmdbId}?lang=en`, title, year);
      }
    }
  }

  if (pollConfirmed) return { conflated: false, serverUrl, token };

  if (allConflated && imdbId && plexImdbId === imdbId) {
    console.warn("[fix-match]",
      `${tag} Plex has permanently merged tmdb://${plexTmdbId} and tmdb://${correctTmdbId} into one hash — ` +
      `IMDB ID ${imdbId} confirms this is the correct film. ` +
      `Accepting conflated match; DB will be updated to ${correctTmdbId}.`,
    );
    return { conflated: true, serverUrl, token };
  }

  const plexState = plexTmdbId
    ? `Plex resolved to tmdb://${plexTmdbId}${plexImdbId ? ` (imdb://${plexImdbId})` : ""}`
    : "Plex state unknown";
  const detail =
    `Plex did not confirm the match to tmdb://${correctTmdbId} — ${plexState}. ` +
    `Plex's metadata database may not have an entry for TMDB #${correctTmdbId}. ` +
    `Try a different candidate from the picker, or fix the match manually in Plex.`;
  if (unmatched) throw new PlexUnmatchedError(`${detail} The item is now UNMATCHED in Plex.`);
  throw new Error(detail);
}

function guidCarriesTmdb(item: { guid?: string; Guid?: Array<{ id: string }> }, tmdbId: number): boolean {
  const id = String(tmdbId);
  return (item.Guid ?? []).some((g) => g.id === `tmdb://${id}`) || new RegExp(`themoviedb://${id}(?![0-9])`).test(item.guid ?? "");
}

// Which title a Plex rating key currently claims. A row's `plexRatingKeys` also
// holds keys that merely ride along (a conflated item, guardrail 37c).
//   "old"     — still the id being replaced; safe to remap
//   "correct" — already the destination id; join that row, don't remap again
//   "other"   — a different title; leave that item alone
//   null      — could not be read
async function plexCopyClaim(
  instance: MediaInstanceKey,
  ratingKey: string,
  oldTmdbId: number,
  correctTmdbId: number,
): Promise<"old" | "correct" | "other" | null> {
  const cfg = await getPlexConfig(instance);
  if (!cfg.url || !cfg.token) return null;
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const res = await safeFetchAdminConfigured(`${cfg.url.replace(/\/$/, "")}/library/metadata/${safeKey}?includeGuids=1`, {
    headers: plexAdminHeaders(cfg.token),
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = await res.json().catch(() => null) as { MediaContainer?: { Metadata?: Array<{ guid?: string; Guid?: Array<{ id: string }> }> } } | null;
  const item = json?.MediaContainer?.Metadata?.[0];
  if (!item) return null;
  if (guidCarriesTmdb(item, oldTmdbId)) return "old";
  if (guidCarriesTmdb(item, correctTmdbId)) return "correct";
  return "other";
}

type JellyfinVirtualFolder = {
  Name?: string;
  Locations?: string[];
  LibraryOptions?: {
    SaveLocalMetadata?: boolean;
    MetadataSavers?: string[] | null;
    DisabledLocalMetadataReaders?: string[] | null;
  };
};

// Post-mortem for a fix-match apply that Jellyfin did not confirm in the poll
// window. Field data (2026-08, 13 series across three days) says an item still
// reporting the OLD id at this point is USUALLY a slow series refresh settling
// after our window — every sampled "failure" had actually landed when inspected
// later — so the message leads with "re-sync and check before retrying". A
// REPEATED landing back on the old id is the genuine-revert signature (a stale
// .nfo re-imported by the Nfo reader, or a locked item), so the probe still
// names those as the repeat-offender explanation. Field semantics verified
// against the Jellyfin 10.11 LibraryOptions model: local metadata READERS are
// on by default and DisabledLocalMetadataReaders lists the ones turned off; the
// SAVER is MetadataSavers / SaveLocalMetadata. Every probe failure degrades
// back to the generic message — diagnosis must never mask the original failure.
async function describeUnconfirmedJellyfinMatch(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  previousTmdbId: number;
  correctTmdbId: number;
  lastSeenTmdbId: string | null;
  itemLocked: boolean;
  filePath: string | null;
  readFailures: number;
  attempts: number;
}): Promise<string> {
  const { baseUrl, headers, previousTmdbId, correctTmdbId, lastSeenTmdbId, itemLocked, filePath, readFailures, attempts } = opts;

  // Never read the item back at all. Every other branch below infers from what
  // Jellyfin REPORTED, so with no successful read there is nothing to infer
  // from: lastSeenTmdbId stays null and itemLocked stays false purely because
  // nothing was observed, and the fall-through message then blamed Jellyfin's
  // metadata provider for what is really an unreachable (or erroring) Jellyfin.
  // Seen live: four items, 120/120 reads failed, each reported as "check that
  // Jellyfin can reach its metadata provider" while the server was returning
  // nothing for ten minutes. Says nothing about whether the match landed,
  // because we genuinely do not know — and an immediate retry only queues
  // another full refresh on a server already failing to answer.
  if (attempts > 0 && readFailures >= attempts) {
    return `Could not read the item back from Jellyfin — all ${attempts} confirmation reads failed, so whether TMDB #${correctTmdbId} applied is unknown and the library mapping was left alone. Check that Jellyfin is up and reachable from Summonarr, then run a library re-sync to see where the item landed before retrying.`;
  }

  if (itemLocked) {
    return `Jellyfin did not keep TMDB #${correctTmdbId} — the item is locked in Jellyfin ("Lock this item" in Edit metadata), so refreshes preserve its old data. Unlock it and retry.`;
  }

  if (lastSeenTmdbId === String(previousTmdbId)) {
    // Still the old id — most likely still settling (see the header comment).
    // Probe the owning library's config so the repeat-offender hint is specific.
    const folders = await safeFetchAdminConfigured(`${baseUrl}/Library/VirtualFolders`, { headers, timeoutMs: 10_000 })
      .then((r) => (r.ok ? (r.json() as Promise<JellyfinVirtualFolder[]>) : null))
      .catch(() => null);
    if (Array.isArray(folders)) {
      const normalizedPath = filePath ? filePath.replace(/\\/g, "/") : null;
      const owns = (f: JellyfinVirtualFolder) =>
        !!normalizedPath && (f.Locations ?? []).some((loc) => {
          const l = loc.replace(/\\/g, "/").replace(/\/$/, "");
          return !!l && (normalizedPath === l || normalizedPath.startsWith(l + "/"));
        });
      const nfoReaderOn = (f: JellyfinVirtualFolder) =>
        !(f.LibraryOptions?.DisabledLocalMetadataReaders ?? []).some((r) => r.toLowerCase() === "nfo");
      const nfoSaverOn = (f: JellyfinVirtualFolder) =>
        f.LibraryOptions?.SaveLocalMetadata === true ||
        (f.LibraryOptions?.MetadataSavers ?? []).some((s) => s.toLowerCase() === "nfo");

      const lib = folders.find(owns) ?? null;
      if (lib && nfoReaderOn(lib)) {
        const saverNote = nfoSaverOn(lib)
          ? " That library also has the Nfo metadata SAVER enabled, which keeps rewriting those files."
          : "";
        return `Jellyfin still reported the previous match (TMDB #${previousTmdbId}) after the confirmation window. Slow refreshes settle late — run a library re-sync in a few minutes and check whether the new match landed before retrying. If it keeps ending up at TMDB #${previousTmdbId}, a stale .nfo is the likely cause: the "${lib.Name ?? "matching"}" library has the Nfo metadata reader enabled, and such a file re-asserts the old id on every refresh.${saverNote}`;
      }
    }
    return `Jellyfin still reported the previous match (TMDB #${previousTmdbId}) after the confirmation window. Slow refreshes settle late — run a library re-sync in a few minutes and check whether the new match landed before retrying. If it keeps ending up at TMDB #${previousTmdbId}, something local is re-asserting it (a stale .nfo file, another metadata provider, or a plugin) — check the Jellyfin server log for this item.`;
  }

  return `Jellyfin did not confirm TMDB #${correctTmdbId} after applying the match — library mapping not updated. Retry, or check that Jellyfin can reach its metadata provider.`;
}

// Remaps a Jellyfin library item to the correct TMDB id: remote-search for a
// candidate carrying correctTmdbId, apply it, refresh, then poll until Jellyfin
// confirms — throws if it never confirms. Returns the (possibly new) item id.
//
// `instance` selects WHICH configured Jellyfin server gets rewritten — same rule
// as the Plex path: the item id came from one server's library row and is only
// meaningful against that server.
//
// `previousTmdbId` is the row's current (wrong) id — only used to diagnose an
// unconfirmed apply (did the server revert to it?), never sent to Jellyfin.
// `background` = running as a job (guardrail 37a): nothing waits on an HTTP
// request, so the confirmation window can be as long as the cascade needs.
// `siblingItemIds` = the OTHER copies of this title (guardrail 37). The
// path/tmdb fallback search must never resolve to one of them: a sibling that
// was already remapped reports the correct tmdbId, and accepting it would
// "confirm" THIS copy without ever reading it — the unfixed copy is then
// dropped from `jellyfinItemIds` with no partial warning, and the next sync can
// elect it and revert the correction.
async function fixJellyfinMatch(
  itemId: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  instance: MediaInstanceKey,
  filePath: string | null,
  previousTmdbId: number,
  background: boolean,
  report?: FixMatchReport,
  siblingItemIds: ReadonlySet<string> = new Set(),
): Promise<{ newItemId: string; baseUrl: string; apiKey: string }> {
  const safeItemId = sanitizeJellyfinId(itemId);
  const tag = `[fix-match/${mediaInstanceLabel("jellyfin", instance)} itemId=${safeItemId} target=tmdb:${correctTmdbId}]`;

  // Progress the job exposes to the UI (no-op on the synchronous path).
  const progress: Omit<import("@/lib/fix-match-jobs").FixMatchProgress, "updatedAt"> =
    { phase: "searching", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 };
  const push = () => report?.({ ...progress });
  push();

  const jellyfinConfig = await getJellyfinConfig(instance);
  if (!jellyfinConfig.url || !jellyfinConfig.apiKey) throw new Error("Jellyfin server not configured");

  const baseUrl = jellyfinConfig.url.replace(/\/$/, "");

  const apiKey  = jellyfinConfig.apiKey;
  // Dual-send auth (Authorization: MediaBrowser + legacy X-MediaBrowser-Token):
  // RemoteSearch/Apply and /Items/{id}/Refresh are RequiresElevation endpoints,
  // and Jellyfin 10.12 stops reading the bare legacy header entirely (see
  // JELLYFIN_IDENTITY in jellyfin.ts) — a bare-token call would 401 here while
  // the admin-surface calls kept working.
  const headers = jellyfinAdminHeaders(apiKey);
  const searchType = mediaType === "MOVIE" ? "Movie" : "Series";
  const searchRes = await safeFetchAdminConfigured(`${baseUrl}/Items/RemoteSearch/${searchType}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      SearchInfo: { ProviderIds: { Tmdb: String(correctTmdbId) } },
      ItemId: safeItemId,
      IncludeDisabledProviders: true,
    }),
    timeoutMs: 30_000,
  });
  if (!searchRes.ok) throw new Error(`Jellyfin remote search failed: ${searchRes.status}`);

  type JellyfinSearchResult = { ProviderIds?: Record<string, string>; Name?: string };
  const searchResults = await searchRes.json() as JellyfinSearchResult[];
  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    throw new Error(`Jellyfin found no match for TMDB #${correctTmdbId} — check that Jellyfin can reach the metadata provider`);
  }

  // Require a result that actually carries correctTmdbId — never fall back to
  // searchResults[0], which fuzzy matching can make a different title and remap
  // the library item to the wrong media. Matches the Plex path.
  const target = searchResults.find((r) => {
    const id = r.ProviderIds?.Tmdb ?? r.ProviderIds?.tmdb;
    return id === String(correctTmdbId);
  });
  if (!target) {
    throw new Error(`Jellyfin remote search returned no candidate matching TMDB #${correctTmdbId} — refusing to apply a different match`);
  }

  // Jellyfin runs the identify's FullRefresh SYNCHRONOUSLY inside the Apply
  // request, with CancellationToken.None (ItemLookupController.ApplySearchCriteria,
  // verified against the 10.11.x source) — so a client-side timeout does NOT
  // cancel the server-side work, and the match routinely lands moments after we
  // hang up (large series, busy box, slow metadata provider). Treat a timeout as
  // "still applying" and fall through to a LONGER confirmation poll instead of
  // failing an operation that is usually still succeeding. Any other apply
  // failure (non-2xx, network, SSRF) still throws as before.
  let applyTimedOut = false;
  progress.phase = "applying";
  push();
  try {
    const applyRes = await safeFetchAdminConfigured(`${baseUrl}/Items/RemoteSearch/Apply/${safeItemId}?replaceAllImages=false`, {
      method: "POST",
      headers,
      body: JSON.stringify(target),
      timeoutMs: 90_000,
    });
    if (!applyRes.ok) throw new Error(`Jellyfin apply match failed: ${applyRes.status}`);
  } catch (err) {
    if (!(err instanceof SafeFetchError) || err.reason !== "timeout") throw err;
    applyTimedOut = true;
    console.warn("[fix-match]", tag, "apply timed out client-side; Jellyfin is still refreshing — extending the confirmation poll");
  }

  // Either way the media server now owns the remap: it accepted the new match
  // (2xx) or is still applying it (timeout) — from here Summonarr only waits.
  progress.remoteApplied = true;
  progress.phase = "confirming";
  push();

  const refreshUrl = (id: string) =>
    `${baseUrl}/Items/${id}/Refresh?MetadataRefreshMode=FullRefresh&ReplaceAllMetadata=true&ImageRefreshMode=FullRefresh&ReplaceAllImages=true`;
  // When the apply timed out, the server is already >90s deep in that apply's own
  // refresh — queueing a second one now only grows the backlog. Defer it to after
  // confirmation (below) so the image-replacement pass still happens on success.
  if (!applyTimedOut) {
    await refreshBestEffort(refreshUrl(safeItemId), { method: "POST", headers }, tag);
  }

  let resolvedItemId = safeItemId;
  let confirmed = false;
  // The copies of the TARGET title this server already holds (the corrected
  // row's ids) — the siblings' twin. A correctly matched copy (the 4K/HD twin
  // guardrail 37 allows) carries the target id by construction, while the item
  // being fixed is still named after the wrong title and may be missing from
  // the name search entirely; accepting that copy "confirmed" this item without
  // ever reading it. Both modes (tmdbId and item) go through here. Read once,
  // when the fallback first needs it; unreadable ⇒ only the item's own path may
  // confirm.
  let targetCopiesRead: Promise<ReadonlySet<string> | null> | null = null;
  const targetCopies = (): Promise<ReadonlySet<string> | null> => (targetCopiesRead ??= (async () => {
    try {
      const row = await prisma.jellyfinLibraryItem.findUnique({
        where: { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance: instance } },
        select: { jellyfinItemId: true, jellyfinItemIds: true },
      });
      const ids = [...(row?.jellyfinItemId ? [row.jellyfinItemId] : []), ...(row?.jellyfinItemIds ?? [])]
        .map(sanitizeJellyfinId);
      return new Set(ids.filter((id) => id !== safeItemId));
    } catch (err) {
      console.warn("[fix-match]", tag, "could not read the target title's copies; the fallback confirms by path only:", err instanceof Error ? err.message : err);
      return null;
    }
  })());
  // Post-mortem inputs: the last TMDB id the item reported, and whether it is
  // metadata-locked — both read off the confirmation polls we already make.
  let lastSeenTmdbId: string | null = null;
  let itemLocked = false;
  // ~2 extra minutes of polling when the refresh outlived the apply window, and
  // for EVERY series: a Series identify cascades across seasons/episodes, so its
  // new provider ids can become readable minutes after the Apply call returns.
  // Field-verified (2026-08): 13 series applies that "failed to confirm" in the
  // old 20s window had ALL landed correctly when inspected later. Success still
  // breaks out of the loop on the first confirming poll, so a fast confirm pays
  // nothing for the longer window.
  // In background-job mode nothing is waiting on an HTTP request, so the only
  // cost of waiting longer is a slower "done" — while giving up early turns a
  // remap that LANDED into a "failed" report (seen live on a 300-episode show).
  // 120 × 5s ≈ 10 minutes. The synchronous contract keeps the shorter windows:
  // a reverse proxy cuts that request off long before ten minutes anyway.
  const confirmAttempts = background ? 120 : (applyTimedOut || mediaType === "TV" ? 24 : 4);
  progress.attempts = confirmAttempts;
  for (let attempt = 0; attempt < confirmAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    progress.attempt = attempt + 1;
    push();

    const checkRes = await safeFetchAdminConfigured(
      `${baseUrl}/Items/${resolvedItemId}?Fields=ProviderIds`,
      { headers, timeoutMs: 10_000 },
    ).catch(() => null);
    // A 200 whose body isn't JSON is a failed read too: the match is already
    // applied, so it must not escape as the job's failure.
    const checkJson = checkRes?.ok
      ? await checkRes.json().catch(() => null) as { ProviderIds?: Record<string, string>; LockData?: boolean } | null
      : null;

    if (checkJson === null || typeof checkJson !== "object") {
      // A read that errors or times out is the media server being busy with
      // its own refresh, not a verdict — say so once (and every 10th time) so
      // a long wait is explained in the log instead of looking stuck.
      progress.readFailures++;
      if (progress.readFailures === 1 || progress.readFailures % 10 === 0) {
        console.warn("[fix-match]", tag, `confirmation read failed (${progress.readFailures} so far) — Jellyfin is usually busy refreshing; still polling`);
      }
      push();
      if (filePath) {
        const folderName = filePath.replace(/\\/g, "/").split("/").at(-2) ?? "";
        const searchTerm = folderName.replace(/\s*\(\d{4}\)\s*$/, "").trim();
        const findRes = await safeFetchAdminConfigured(
          // Without the flag a movie in a collection comes back as its BoxSet
          // and the path lookup below never finds it (guardrail 37d).
          `${baseUrl}/Items?Recursive=true&Fields=ProviderIds,Path&IncludeItemTypes=Movie,Series&${JELLYFIN_NO_COLLECTION_GROUPING}` +
          (searchTerm ? `&SearchTerm=${encodeURIComponent(searchTerm)}` : "") +
          `&Limit=50`,
          { headers, timeoutMs: 10_000 },
        ).catch(() => null);
        if (findRes?.ok) {
          type FoundItem = { Id?: string; ProviderIds?: Record<string, string>; Path?: string };
          const findJson = await findRes.json().catch(() => null) as { Items?: unknown } | null;
          const listed = Array.isArray(findJson?.Items) ? findJson.Items as unknown[] : [];
          const items = listed.filter(
            (i): i is FoundItem => i !== null && typeof i === "object" &&
              !(typeof (i as FoundItem).Id === "string" && siblingItemIds.has(sanitizeJellyfinId((i as FoundItem).Id as string))),
          );
          const byPath = items.find((i) => i.Path === filePath);
          // The item's own path wins; a hit elsewhere must not be a known copy
          // of the target title (targetCopies above).
          const others = byPath ? null : await targetCopies();
          const byTmdb = others ? items.find((i) => {
            if (typeof i.Id === "string" && others.has(sanitizeJellyfinId(i.Id))) return false;
            const pid = i.ProviderIds?.Tmdb ?? i.ProviderIds?.tmdb;
            return pid === String(correctTmdbId);
          }) : undefined;
          const found = byPath ?? byTmdb;
          if (typeof found?.Id === "string" && found.Id) {
            // Sanitize the upstream-supplied Id before it lands in a URL and the DB.
            const foundSafeId = sanitizeJellyfinId(found.Id);
            const pid = found.ProviderIds?.Tmdb ?? found.ProviderIds?.tmdb;
            const isConfirmed = pid === String(correctTmdbId);
            if (isConfirmed) {
              resolvedItemId = foundSafeId;
              confirmed = true;
              break;
            }
            if (byPath) resolvedItemId = foundSafeId;
          }
        }
      }
      continue;
    }

    const providerIds = checkJson.ProviderIds;
    const seenTmdb = providerIds?.Tmdb ?? providerIds?.tmdb ?? null;
    if (seenTmdb !== null) lastSeenTmdbId = seenTmdb;
    if (checkJson?.LockData === true) itemLocked = true;
    confirmed = seenTmdb === String(correctTmdbId);
    if (confirmed) break;
  }

  if (!confirmed) {
    // Throw when unconfirmed so the caller's DB write aborts — otherwise we'd persist
    // a tmdbId Jellyfin never confirmed. Matches the Plex path.
    if (applyTimedOut) {
      throw new Error(`Jellyfin was still processing the match for TMDB #${correctTmdbId} when we stopped waiting — the refresh continues server-side and may finish on its own. Check the item in Jellyfin or run a library re-sync before retrying; an immediate retry only queues another full refresh.`);
    }
    throw new Error(await describeUnconfirmedJellyfinMatch({
      baseUrl, headers, previousTmdbId, correctTmdbId, lastSeenTmdbId, itemLocked, filePath,
      readFailures: progress.readFailures, attempts: confirmAttempts,
    }));
  }
  if (applyTimedOut) {
    // The image-replacement refresh deferred above, now that the server has
    // confirmed the match and is no longer busy with the apply's own refresh.
    await refreshBestEffort(refreshUrl(resolvedItemId), { method: "POST", headers }, tag);
  }
  return { newItemId: resolvedItemId, baseUrl, apiKey };
}

type FixMatchInput = {
  server: "plex" | "jellyfin";
  // Item mode: the item's current TMDB id from the match report, 0 when it has none.
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  canonicalGuid?: string;
  serverInstance: string;
  // Item mode (see FixMatchBody.itemKey) — set only from a stored match flag.
  itemKey?: string;
  itemPath?: string | null;
};
// Who ran the fix, plus the request context (IP, user agent, provider) every
// admin audit row carries — spread at the top level of each FIX_MATCH row.
type FixMatchActor = { userId: string; userName: string | null | undefined; ctx: ReturnType<typeof auditContext> };
type RunOpts = { background: boolean; report?: FixMatchReport };
// The remap is inherently two-phase: the remote library server must be
// rewritten first (to learn the new item id), then the local cache row is
// updated in a DB transaction. If the remote rewrite succeeds but the DB
// transaction then fails, the library server and the cache disagree. Each mode
// sets `remoteRemapped` the moment its remote phase commits, so the shared
// catch can tell the operator the remap landed remotely and a re-sync will
// reconcile the cache, rather than implying nothing happened.
type RunState = { remoteRemapped: boolean };

// The whole remap — remote rewrite, cache-row transaction, audit, episode
// re-cache — as one unit that resolves to the client-facing result or throws a
// FixMatchError carrying the client-safe message + HTTP status. The POST
// handler runs it through the job registry either way (guardrail 37a) and
// either awaits the job (the synchronous contract) or answers with its id; both
// paths see exactly the same outcomes.
async function runFixMatch(input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator): Promise<FixMatchJobResult> {
  try {
    return await runFixMatchOnce(input, actor, opts, t);
  } finally {
    // Whatever happened, Plex's answer for this title may have changed — a cached
    // candidate list would describe the item as it was before the attempt.
    clearCandidateCache();
  }
}

async function runFixMatchOnce(input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator): Promise<FixMatchJobResult> {
  const { server, tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const state: RunState = { remoteRemapped: false };
  try {
    if (input.itemKey !== undefined) return await runItemMode(input, input.itemKey, actor, opts, t, state);
    return server === "plex"
      ? await runPlexTitleMode(input, actor, opts, t, state)
      : await runJellyfinTitleMode(input, actor, opts, t, state);
  } catch (err) {
    if (err instanceof FixMatchError) throw err;
    // Log the real detail server-side only — the message can carry the
    // configured Plex/Jellyfin server URL, internal paths, or upstream
    // response bodies. Return a generic error to the client.
    const serverLabel = mediaInstanceLabel(server, serverInstance);
    const errClass = err instanceof Error ? err.constructor.name : "Error";
    console.error("[fix-match]", `${serverLabel} error (${errClass})`, err instanceof Error ? err.message : err);
    // The unmatch landed but no re-match was confirmed: the item is UNMATCHED
    // in Plex, not unchanged. The generic "operation failed" implied a no-op
    // while the title was about to drop out of availability on the next sync;
    // say what state the item is in and what to do about it.
    if (err instanceof PlexUnmatchedError) {
      throw new FixMatchError(t("apiAdmin.fixMatch.plexUnmatched", { tmdbId: correctTmdbId }), 502);
    }
    // When the remote remap already committed, the failure is in the DB phase:
    // the library server now points at the corrected TMDB id but the local cache
    // still references the old one. Tell the operator so they can re-sync (which
    // rebuilds the cache from the library) instead of assuming the op was a no-op.
    if (state.remoteRemapped) {
      // Name the instance too — on a multi-server deployment the operator needs
      // to know WHICH server now disagrees with the cache to pick the re-sync.
      const base = server === "plex" ? "Plex" : "Jellyfin";
      const serverName = serverInstance === DEFAULT_MEDIA_INSTANCE ? base : `${base} (${serverInstance})`;
      console.warn("[fix-match]", `${serverLabel} remapped remotely but the DB update failed for tmdb:${tmdbId} → ${correctTmdbId}; cache is out of sync until a re-sync runs`);
      // The upstream mutation DID happen — audit it (swallowing variant,
      // guardrail 26) so a change the library server now carries is not
      // invisible to the audit log just because the cache phase failed.
      void logAudit({
        ...actor.ctx,
        userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`,
        details: { type: "fix-match", source: server, fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance, dbUpdated: false },
      });
      throw new FixMatchError(t("apiAdmin.fixMatch.cacheUpdateFailed", { server: serverName, tmdbId: correctTmdbId }), 502);
    }
    throw new FixMatchError(t("apiAdmin.fixMatch.failed"), 502);
  }
}

// Item mode (the library match check's Fix): ONE server item, never every copy
// holding `tmdbId` — a title can hold a correct copy beside the wrong one. Its
// key, path and current id come from the stored flag.
async function runItemMode(
  input: FixMatchInput, itemKey: string, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance } = input;
  let newKey = itemKey;
  let conflatedWarning: string | null = null;
  if (server === "plex") {
    opts.report?.({ phase: "applying", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 });
    const plexResult = await fixPlexMatch(itemKey, correctTmdbId, mediaType, serverInstance, canonicalGuid, opts.report, true);
    if (plexResult.conflated) conflatedWarning = t("apiAdmin.fixMatch.plexConflated", { tmdbId: correctTmdbId });
  } else {
    newKey = (await fixJellyfinMatch(itemKey, correctTmdbId, mediaType, serverInstance, input.itemPath ?? null, tmdbId, opts.background, opts.report)).newItemId;
  }
  state.remoteRemapped = true;
  const keys = Array.from(new Set([itemKey, newKey]));
  await prisma.$transaction(async (tx) => {
    // The sync's library lock, so a concurrent sync can't interleave. The
    // episode cache is left to the next full sync: it has no item key, so
    // one copy's episodes can't be moved out of a shared title.
    if (server === "plex") await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
    await moveItemToTitleInTx(tx, server, serverInstance, mediaType, itemKey, newKey, correctTmdbId, input.itemPath ?? null);
    // Plays of THIS item only, whatever id they were recorded under (none,
    // for an unmatched item): a movie by its own key, an episode by its show's.
    const plays = mediaType === "MOVIE"
      ? { source: server, serverInstance, mediaType: "MOVIE" as const, sourceItemId: { in: keys } }
      : { source: server, serverInstance, mediaType: "TV" as const, sourceShowId: { in: keys } };
    await tx.playHistory.updateMany({ where: plays, data: { tmdbId: correctTmdbId } });
    await tx.activeSession.updateMany({ where: plays, data: { tmdbId: correctTmdbId } });
    await dropMatchFlagInTx(tx, server, serverInstance, itemKey);
  }, { timeout: BATCH_TX_TIMEOUT });
  void logAudit({
    ...actor.ctx,
    userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId > 0 ? tmdbId : correctTmdbId}`,
    details: { type: "fix-match", mode: "item", source: server, itemKey, fromTmdbId: tmdbId > 0 ? tmdbId : null, toTmdbId: correctTmdbId, mediaType, serverInstance },
  });
  return conflatedWarning ? { ok: true, warning: conflatedWarning } : { ok: true };
}

async function runPlexTitleMode(
  input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance } = input;
  const item = await prisma.plexLibraryItem.findFirst({
    where: { tmdbId, mediaType, serverInstance },
    select: { plexRatingKey: true, plexRatingKeys: true, filePath: true },
  });
  if (!item?.plexRatingKey) {
    throw new FixMatchError(t("apiAdmin.fixMatch.plexRatingKeyNotFound"), 404);
  }
  opts.report?.({ phase: "applying", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 });
  const plexRatingKey = item.plexRatingKey;
  // The canonical copy is the one the admin picked a candidate for; its
  // failure aborts the job exactly as before.
  const extraKeys = unionKeys(item.plexRatingKeys).filter((k) => k !== plexRatingKey);
  const totalCopies = 1 + extraKeys.length;
  // Tag every progress report with which copy is being worked on.
  const copyReport = (copy: number): FixMatchReport => (p) => opts.report?.({ ...p, copy, copies: totalCopies });
  const plexResult = await fixPlexMatch(plexRatingKey, correctTmdbId, mediaType, serverInstance, canonicalGuid, copyReport(1), true);
  state.remoteRemapped = true;

  // Every OTHER copy of the title (guardrail 37c) — the Plex twin of the
  // Jellyfin loop. Left on the old match, the next sync could elect an
  // unfixed copy and revert the correction. Serial, like Jellyfin's, and a
  // copy is only remapped if Plex says it still carries the old id. The
  // library-wide bundle clean already ran for the first copy.
  // `movedKeys` join the corrected row and have their plays reattributed.
  // `droppedKeys` only leave the old row: a key Plex says is a third title
  // must not be merged onto the correction or its plays rewritten.
  const movedKeys = new Set<string>([plexRatingKey]);
  const droppedKeys = new Set<string>([plexRatingKey]);
  const failedKeys: string[] = [];
  for (const [idx, key] of extraKeys.entries()) {
    try {
      const claim = await plexCopyClaim(serverInstance, key, tmdbId, correctTmdbId);
      if (claim === null) { failedKeys.push(key); continue; }
      // A different title: drop it from this row and leave its own row,
      // its Plex item, and its plays untouched.
      if (claim === "other") { droppedKeys.add(key); continue; }
      if (claim === "old") {
        await fixPlexMatch(key, correctTmdbId, mediaType, serverInstance, canonicalGuid, copyReport(idx + 2), false);
      }
      movedKeys.add(key);
      droppedKeys.add(key);
    } catch (err) {
      console.error("[fix-match]", `plex copy ${key} failed:`, err instanceof Error ? err.message : err);
      failedKeys.push(key);
    }
  }
  const partialWarning = failedKeys.length > 0
    ? t("apiAdmin.fixMatch.plexPartial", {
      tmdbId: correctTmdbId, applied: movedKeys.size, total: movedKeys.size + failedKeys.length, failed: failedKeys.length,
    })
    : null;

  await prisma.$transaction(async (tx) => {
    // Take the same advisory locks the sync orchestrator uses (2001 library, 2002
    // episode cache) so a concurrent sync can't clobber or interleave this manual
    // remap. Acquire 2001 before 2002 (one consistent global order → no deadlock).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
    // Read both rows BEFORE touching either: the removed row's descriptive
    // columns carry over, and the target's own keys are merged, not replaced.
    const oldWhere = { tmdbId_mediaType_serverInstance: { tmdbId, mediaType, serverInstance } };
    const targetWhere = { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance } };
    const removed = await tx.plexLibraryItem.findUnique({ where: oldWhere });
    const target = await tx.plexLibraryItem.findUnique({ where: targetWhere });
    const remainder = remainingOnOldRow(plexRatingKey, [plexRatingKey, ...extraKeys], droppedKeys);
    if (remainder.delete) {
      // deleteMany, NOT delete: the confirmation poll above ran UNLOCKED for
      // up to minutes, so a library sync may already have reconciled this row
      // under the corrected id. `delete` on a missing unique row throws P2025
      // and would report a landed remap as a failed job (guardrail 37a).
      await tx.plexLibraryItem.deleteMany({ where: { tmdbId, mediaType, serverInstance } });
    } else {
      // Copies that could not be remapped still carry the old match: they stay
      // on the old row so their plays keep resolving, minus the moved file path.
      await tx.plexLibraryItem.update({ where: oldWhere, data: { plexRatingKey: remainder.canonicalKey, plexRatingKeys: remainder.keys, filePath: null } });
    }
    const movedList = [...movedKeys];
    const mergedKeys = unionKeys([target?.plexRatingKey ?? plexRatingKey], target?.plexRatingKeys, movedList);
    const meta = carryMeta(LIBRARY_META_KEYS, target, removed);
    await tx.plexLibraryItem.upsert({
      where: targetWhere,
      create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: item.filePath, plexRatingKey, plexRatingKeys: mergedKeys, ...meta },
      // filePath follows the ratingKey: a pre-existing row for the corrected
      // id (a correctly matched copy) otherwise kept ANOTHER file's path
      // beside this item's key until the next full sync. The target's own
      // canonical key stays canonical; this run's keys join its set.
      update: { plexRatingKey: target?.plexRatingKey ?? plexRatingKey, plexRatingKeys: mergedKeys, filePath: target?.plexRatingKey ? (target.filePath ?? item.filePath) : item.filePath, ...meta },
    });
    // Re-attribute the plays recorded under the wrong id (see
    // playReattributionWhere). Same tx as the row rewrite so the cache and
    // the history never disagree about which title this item is.
    const reattribute = playReattributionWhere("plex", serverInstance, mediaType, tmdbId, movedList);
    await tx.playHistory.updateMany({ where: reattribute, data: { tmdbId: correctTmdbId } });
    await tx.activeSession.updateMany({ where: reattribute, data: { tmdbId: correctTmdbId } });
    await purgeOldEpisodeCacheInTx(tx, "plex", tmdbId, mediaType, serverInstance, remainder.delete);
  }, { timeout: BATCH_TX_TIMEOUT });
  void logAudit({
    ...actor.ctx,
    userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`,
    details: { type: "fix-match", source: "plex", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance },
  });

  if (mediaType === "TV") {
    recacheEpisodesInBackground("plex", () => getPlexEpisodesForShow(plexResult.serverUrl, plexResult.token, plexRatingKey, correctTmdbId), correctTmdbId);
  }

  if (plexResult.conflated) {
    const conflated = t("apiAdmin.fixMatch.plexConflated", { tmdbId: correctTmdbId });
    return { ok: true, warning: partialWarning ? `${conflated} ${partialWarning}` : conflated };
  }
  return partialWarning ? { ok: true, warning: partialWarning } : { ok: true };
}

async function runJellyfinTitleMode(
  input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  const { tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  const item = await prisma.jellyfinLibraryItem.findFirst({
    where: { tmdbId, mediaType, serverInstance },
    select: { jellyfinItemId: true, jellyfinItemIds: true, filePath: true },
  });
  // EVERY copy, not just the stored id (guardrail 37). A title in two
  // libraries is mismatched on the server in both places; remapping one left
  // the other reporting the old tmdbId, so the very next library sync could
  // elect the unfixed copy and the admin's correction silently reverted.
  // Deduped and ordered with the stored id first — `jellyfinItemIds` already
  // contains it on any row written since that column landed.
  const targetItemIds = unionKeys([item?.jellyfinItemId], item?.jellyfinItemIds);
  if (targetItemIds.length === 0) {
    throw new FixMatchError(t("apiAdmin.fixMatch.jellyfinItemNotFound"), 404);
  }
  // Serial, not concurrent: each call drives a FullRefresh on the server and
  // then polls for confirmation, and hammering a Jellyfin box with parallel
  // metadata refreshes is how these calls start timing out.
  const applied: Array<{ originalId: string } & Awaited<ReturnType<typeof fixJellyfinMatch>>> = [];
  const failedCopies: string[] = [];
  const safeCopyIds = targetItemIds.map(sanitizeJellyfinId);
  for (const [copyIdx, targetId] of targetItemIds.entries()) {
    const copyReport: FixMatchReport = (p) => opts.report?.({ ...p, copy: copyIdx + 1, copies: targetItemIds.length });
    // The row's filePath belongs to the canonical copy (`jellyfinItemId`) —
    // it is written from the same winning item. Handing it to another copy
    // pointed that copy's fallback search at the canonical one, so only the
    // canonical copy gets it; the others confirm by reading themselves.
    const copyPath = targetId === item?.jellyfinItemId ? (item?.filePath ?? null) : null;
    const safeTarget = sanitizeJellyfinId(targetId);
    const siblings = new Set(safeCopyIds.filter((id) => id !== safeTarget));
    try {
      const result = await fixJellyfinMatch(targetId, correctTmdbId, mediaType, serverInstance, copyPath, tmdbId, opts.background, copyReport, siblings);
      applied.push({ originalId: targetId, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[fix-match]", `jellyfin copy ${targetId} failed:`, msg);
      failedCopies.push(targetId);
    }
  }
  // Only a total failure aborts. With one copy this is exactly the old
  // behaviour (the throw propagates to the caller's handler); with several,
  // refusing to record the copies that DID move would leave the DB claiming
  // a match the server no longer has.
  if (applied.length === 0) {
    const first = failedCopies[0] ?? "";
    throw new Error(`Jellyfin match failed for every copy of this title (${failedCopies.length}): ${first}`);
  }
  const jellyfinResult = applied[0];
  const resolvedItemId = jellyfinResult.newItemId;
  const resolvedItemIds = unionKeys(applied.map((r) => r.newItemId));
  // The copies that moved, under the ids the old row knew them by. A copy that
  // failed still carries the old match on the server: it stays on the old row
  // (guardrail 37a's "copies that fail stay on the old row", as in the Plex
  // twin) and its plays stay where they are.
  const movedOriginalIds = new Set(applied.map((r) => r.originalId));
  // The row's filePath is the canonical copy's: it moves only with that copy.
  const canonicalMoved = !!item?.jellyfinItemId && movedOriginalIds.has(item.jellyfinItemId);
  const movedFilePath = canonicalMoved ? (item?.filePath ?? null) : null;
  state.remoteRemapped = true;
  const partialWarning = failedCopies.length > 0
    ? t("apiAdmin.fixMatch.jellyfinPartial", {
      tmdbId: correctTmdbId, applied: applied.length, total: targetItemIds.length, failed: failedCopies.length,
    })
    : null;

  await prisma.$transaction(async (tx) => {
    // Same locks as the sync orchestrator (2001 library, 2002 episode), 2001 before
    // 2002, so a concurrent sync can't clobber/interleave this manual remap.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
    const oldWhere = { tmdbId_mediaType_serverInstance: { tmdbId, mediaType, serverInstance } };
    const targetWhere = { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance } };
    const removedRow = await tx.jellyfinLibraryItem.findUnique({ where: oldWhere });
    const remainder = remainingOnOldRow(item?.jellyfinItemId ?? null, targetItemIds, movedOriginalIds);
    if (remainder.delete) {
      // deleteMany, NOT delete: the confirmation poll above ran UNLOCKED for
      // up to ~10 minutes in background mode, so a library sync may already
      // have reconciled this row under the corrected id. `delete` on a missing
      // unique row throws P2025 and would report a landed remap as a failed
      // job (guardrail 37a).
      await tx.jellyfinLibraryItem.deleteMany({ where: { tmdbId, mediaType, serverInstance } });
    } else {
      // updateMany for the same reason: a row a sync already rewrote is a
      // no-op, never a P2025. The file path leaves only with the canonical copy.
      await tx.jellyfinLibraryItem.updateMany({
        where: { tmdbId, mediaType, serverInstance },
        data: { jellyfinItemId: remainder.canonicalKey, jellyfinItemIds: remainder.keys, ...(canonicalMoved ? { filePath: null } : {}) },
      });
    }
    // The target row may already exist — a correctly matched copy of the
    // same title, or the copy a previous partial run DID move (the retry the
    // jellyfinPartial warning itself invites). Its ids are copies this run
    // never touched; REPLACING them dropped them, and until the next full sync
    // rewrote the row the 5s poller's has/hasSome lookup no longer recognised
    // their SeriesId — guardrail 37's exact failure. Write the UNION, its own
    // canonical id included (a legacy row's array can be empty), and keep that
    // canonical id and its file path canonical, as the Plex twin does.
    const existingTarget = await tx.jellyfinLibraryItem.findUnique({ where: targetWhere });
    const meta = carryMeta(JELLYFIN_META_KEYS, existingTarget, removedRow);
    const mergedItemIds = unionKeys([existingTarget?.jellyfinItemId], existingTarget?.jellyfinItemIds, resolvedItemIds);
    await tx.jellyfinLibraryItem.upsert({
      where: targetWhere,
      create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: movedFilePath, jellyfinItemId: resolvedItemId, jellyfinItemIds: resolvedItemIds, ...meta },
      update: {
        jellyfinItemId: existingTarget?.jellyfinItemId ?? resolvedItemId,
        jellyfinItemIds: mergedItemIds,
        filePath: existingTarget?.jellyfinItemId ? (existingTarget.filePath ?? movedFilePath) : movedFilePath,
        ...meta,
      },
    });
    // Re-attribute the plays recorded under the wrong id (see
    // playReattributionWhere): the ids a play could carry are the moved
    // copies as they were BEFORE the remap plus whatever Jellyfin reports them
    // as now — never a copy that failed and still carries the old match.
    const reattribute = playReattributionWhere(
      "jellyfin", serverInstance, mediaType, tmdbId, unionKeys([...movedOriginalIds], resolvedItemIds),
    );
    await tx.playHistory.updateMany({ where: reattribute, data: { tmdbId: correctTmdbId } });
    await tx.activeSession.updateMany({ where: reattribute, data: { tmdbId: correctTmdbId } });
    await purgeOldEpisodeCacheInTx(tx, "jellyfin", tmdbId, mediaType, serverInstance, remainder.delete);
  }, { timeout: BATCH_TX_TIMEOUT });
  void logAudit({
    ...actor.ctx,
    userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`,
    details: { type: "fix-match", source: "jellyfin", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance },
  });

  if (mediaType === "TV") {
    recacheEpisodesInBackground("jellyfin", () => getJellyfinEpisodesForShow(jellyfinResult.baseUrl, jellyfinResult.apiKey, resolvedItemId, correctTmdbId), correctTmdbId);
  }
  return partialWarning ? { ok: true, warning: partialWarning } : { ok: true };
}

// Stale episode cache references the old tmdbId; it must be cleared so the
// re-cache picks up the correct id. TV only: TVEpisodeCache has no mediaType
// column and TMDB's movie and TV ids overlap, so a MOVIE fix purging by its old
// id wiped the episodes of whatever show shares that number. Skipped while this
// instance's old row survives (copies that failed still hold the old id and
// their episodes). TVEpisodeCache has NO serverInstance column either, so the
// purge would also erase another server's legitimately-matched rows for the old
// id: only purge when no other instance still holds it; otherwise the sync
// orchestrator's union rebuild owns the shared namespace.
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
async function purgeOldEpisodeCacheInTx(
  tx: Pick<TxClient, "plexLibraryItem" | "jellyfinLibraryItem" | "tVEpisodeCache">,
  source: "plex" | "jellyfin",
  oldTmdbId: number,
  mediaType: "MOVIE" | "TV",
  serverInstance: string,
  oldRowRemoved: boolean,
): Promise<void> {
  if (mediaType !== "TV" || !oldRowRemoved) return;
  const where = { tmdbId: oldTmdbId, mediaType, serverInstance: { not: serverInstance } };
  const othersHoldOldId = source === "plex"
    ? await tx.plexLibraryItem.count({ where })
    : await tx.jellyfinLibraryItem.count({ where });
  if (othersHoldOldId === 0) {
    await tx.tVEpisodeCache.deleteMany({ where: { source, tmdbId: oldTmdbId } });
  }
}

// Repopulates the corrected show's episode cache from the server just fixed, in
// the background. TVEpisodeCache has NO serverInstance column: every server of a
// source shares one namespace for a given show, so repopulating from the one
// server we just re-matched DELETES any other server's rows for this show. Only
// safe to own when this is the sole registered server of its source; otherwise
// leave the show to the sync orchestrator, which rebuilds from the union of all
// of them.
function recacheEpisodesInBackground(
  source: "plex" | "jellyfin",
  load: () => Promise<EpisodeCacheRow[]>,
  correctTmdbId: number,
): void {
  load()
    .then(async (episodes) => {
      if (episodes.length === 0) return;
      if ((await getMediaInstances(source)).length > 1) return;
      await prisma.$transaction(async (tx) => {
        if (source === "plex") await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
        else await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
        await tx.tVEpisodeCache.deleteMany({ where: { source, tmdbId: correctTmdbId } });
        await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source, ...e })));
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[fix-match]", `${source === "plex" ? "Plex" : "Jellyfin"} episode re-cache failed:`, err));
}

// "Title (Year)" of the row being remapped, for the job tray only — best effort,
// never a reason to refuse the job.
async function libraryTitleFor(input: FixMatchInput): Promise<string | null> {
  try {
    const where = { tmdbId: input.tmdbId, mediaType: input.mediaType, serverInstance: input.serverInstance };
    const row = input.server === "plex"
      ? await prisma.plexLibraryItem.findFirst({ where, select: { title: true, year: true } })
      : await prisma.jellyfinLibraryItem.findFirst({ where, select: { title: true, year: true } });
    return row?.title ? `${row.title}${row.year ? ` (${row.year})` : ""}` : null;
  } catch {
    return null;
  }
}

// The issue a background fix answers. `allowed` is false when closing it is
// refused (maintenance, like the PATCH); the fix itself still runs.
type IssueClose = { issueId: string; title: string | null; allowed: boolean };

// Closes the issue a successful fix answers, from the job itself, so it no
// longer depends on the browser staying until the remap ends. The note is in
// the starting request's language — what the dialog used to PATCH. Never
// throws: the remap has already landed.
async function closeIssueAfterFix(close: IssueClose, input: FixMatchInput, actor: FixMatchActor, t: Translator): Promise<boolean> {
  if (!close.allowed) return false;
  try {
    const title = close.title ?? await cachedTmdbTitle(input.mediaType, input.correctTmdbId) ?? `TMDB #${input.correctTmdbId}`;
    return await resolveIssueAfterAction({
      issueId: close.issueId,
      about: { tmdbId: input.tmdbId, mediaType: input.mediaType },
      resolution: t("adminQueue.fixMatch.resolutionNote", { title }).slice(0, RESOLUTION_MAX),
      trigger: "fix-match",
      actor: { userId: actor.userId, userName: actor.userName ?? null, ctx: actor.ctx },
    });
  } catch (err) {
    console.error("[fix-match] closing the issue failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// withIssueAdmin, not withAdmin: an ISSUE_ADMIN may fix a wrong match to
// resolve a reported issue without holding full admin rights.
export const POST = withIssueAdmin(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // fix-match runs ~60s of Plex/Jellyfin remap calls plus DB writes — without
  // a rate limit, an admin loop (intentional or scripted) can saturate the
  // upstream servers and pile up partial two-phase commits (remote rewrite
  // succeeds, DB tx fails). 10/min/admin matches the broader admin-write cap.
  if (!checkRateLimit(`fix-match:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: t("apiAdmin.fixMatch.tooMany") },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<FixMatchBody>(request, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid } = body;

  if (server !== "plex" && server !== "jellyfin") {
    return NextResponse.json({ error: t("apiAdmin.common.serverPlexOrJellyfin") }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.mediaTypeQuoted") }, { status: 400 });
  }
  const itemMode = body.itemKey !== undefined;
  if (!itemMode && !isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: t("apiAdmin.common.tmdbIdPositive") }, { status: 400 });
  }
  if (!isTmdbIdInRange(correctTmdbId)) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.correctTmdbIdPositive") }, { status: 400 });
  }
  if (!itemMode && tmdbId === correctTmdbId) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.sameIds") }, { status: 400 });
  }
  if (canonicalGuid != null && typeof canonicalGuid !== "string") {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.canonicalGuidString") }, { status: 400 });
  }
  if (body.serverInstance !== undefined && !isValidMediaInstanceSlug(body.serverInstance)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidServerInstance", { slug: String(body.serverInstance) }) }, { status: 400 });
  }
  const serverInstance = body.serverInstance ?? DEFAULT_MEDIA_INSTANCE;
  let input: FixMatchInput = { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance };
  // Shown in the job tray; the match check's flag already carries a title.
  let flaggedTitle: string | null = null;
  if (itemMode) {
    // The key only NAMES an item the last match check flagged on this server;
    // everything else about it is read from that stored flag, never the body.
    const itemKey = body.itemKey;
    const shaped = typeof itemKey === "string" && (server === "plex" ? /^\d{1,12}$/ : /^[0-9a-f-]{32,36}$/i).test(itemKey);
    if (!shaped) {
      return NextResponse.json({ error: t("apiAdmin.fixMatch.itemKeyInvalid") }, { status: 400 });
    }
    const flag = findMatchFlag(await readLibraryMatchReport(), server, serverInstance, itemKey);
    if (!flag || flag.mediaType !== mediaType) {
      return NextResponse.json({ error: t("apiAdmin.fixMatch.itemNotFlagged") }, { status: 404 });
    }
    if (flag.serverTmdbId === correctTmdbId) {
      return NextResponse.json({ error: t("apiAdmin.fixMatch.sameIds") }, { status: 400 });
    }
    input = { ...input, tmdbId: flag.serverTmdbId ?? 0, mediaType: flag.mediaType, itemKey, itemPath: flag.path };
    flaggedTitle = flag.title ? `${flag.title}${flag.year ? ` (${flag.year})` : ""}` : null;
  }
  const actor: FixMatchActor = {
    userId: session.user.id, userName: session.user.name ?? session.user.email, ctx: auditContext(request, session),
  };
  const key = fixMatchJobKey(input);

  // Background mode (guardrail 37a): a series remap waits on the media server
  // for minutes — longer than a reverse proxy keeps one request open — so the
  // browser polls instead of holding the request. An identical job already
  // running is returned as-is, never started twice.
  if (body.async === true) {
    let issueClose: IssueClose | null = null;
    if (body.issueId !== undefined) {
      if (
        itemMode || typeof body.issueId !== "string" || !ISSUE_ID_RE.test(body.issueId) ||
        (body.issueTitle !== undefined && typeof body.issueTitle !== "string")
      ) {
        return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
      }
      // Closing an issue is an issue write: refused during maintenance exactly
      // like the PATCH, while the fix itself still runs.
      issueClose = {
        issueId: body.issueId,
        title: sanitizeOptional(body.issueTitle)?.slice(0, ISSUE_TITLE_MAX) ?? null,
        allowed: (await maintenanceGuard(session)) === null,
      };
    }
    // `joined: true` tells the client its submission attached to an
    // already-running identical remap — whose candidate selection may differ.
    // A joined job closes this caller's issue too, once it succeeds.
    const joinedAnswer = (existing: { id: string; status: string }) => {
      const close = issueClose;
      if (close) {
        void awaitFixMatchJob(existing.id).then((settled) =>
          settled?.status === "done" ? closeIssueAfterFix(close, input, actor, t) : false);
      }
      return NextResponse.json({ ok: true, jobId: existing.id, status: existing.status, joined: true }, { status: 202 });
    };
    const existing = findRunningFixMatchJob(key);
    if (existing) return joinedAnswer(existing);
    try {
      const title = flaggedTitle ?? await libraryTitleFor(input);
      // Re-checked after the await, synchronously with the start below, so a
      // job started meanwhile is joined (and closes the issue) as well.
      const raced = findRunningFixMatchJob(key);
      if (raced) return joinedAnswer(raced);
      const close = issueClose;
      const job = startFixMatchJob(key, async (report) => {
        const result = await runFixMatch(input, actor, { background: true, report }, t);
        // Closed inside the job, before it reads as done, so the poll that
        // sees "done" also learns whether the issue closed.
        return close ? { ...result, issueResolved: await closeIssueAfterFix(close, input, actor, t) } : result;
      }, Date.now(), t, title);
      return NextResponse.json({ ok: true, jobId: job.id, status: job.status }, { status: 202 });
    } catch (err) {
      // The registry's concurrent-running cap (429) — map like the sync branch.
      if (err instanceof FixMatchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  // The synchronous contract the iOS app pins: the same body and status as
  // ever, with the shorter confirmation windows. The remap still runs through
  // the registry, so an identical remap already running (a background job or
  // another synchronous call) is awaited instead of driven a second time
  // against the same item, and the run counts against the running cap.
  let job;
  try {
    const title = flaggedTitle ?? await libraryTitleFor(input);
    job = startFixMatchJob(key, (report) => runFixMatch(input, actor, { background: false, report }, t), Date.now(), t, title);
  } catch (err) {
    // The registry's queue cap (429), mapped like the async branch.
    if (err instanceof FixMatchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const settled = await awaitFixMatchJob(job.id);
  if (settled?.status === "done" && settled.result) {
    // A joined background job may carry its issue's flag; this body never does.
    const { issueResolved: _issueResolved, ...syncResult } = settled.result;
    return NextResponse.json(syncResult);
  }
  // runFixMatch maps every failure to a client-safe FixMatchError; the
  // registry stores its message and status (or the generic 502 for anything
  // unmapped).
  return NextResponse.json(
    { error: settled?.error ?? t("apiAdmin.fixMatch.failed") },
    { status: settled?.errorStatus ?? 502 },
  );
});
