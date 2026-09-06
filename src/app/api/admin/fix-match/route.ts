import { NextResponse } from "next/server";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { readJsonCapped } from "@/lib/body-size";
import { withIssueAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted, SafeFetchError } from "@/lib/safe-fetch";

import { tmdbAuth } from "@/lib/tmdb-auth";
import { getPlexEpisodesForShow } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinEpisodesForShow, jellyfinAdminHeaders } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { FixMatchError, findRunningFixMatchJob, fixMatchJobKey, startFixMatchJob, type FixMatchJobResult, type FixMatchReport } from "@/lib/fix-match-jobs";
import {
  DEFAULT_MEDIA_INSTANCE,
  isValidMediaInstanceSlug,
  mediaInstanceLabel,
  type MediaInstanceKey,
} from "@/lib/media-instances";

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
};

interface PlexSearchResult {
  guid:   string;
  name?:  string;
  year?:  number;
  Guid?:  Array<{ id: string }>;
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
async function fixPlexMatch(
  ratingKey: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  instance: MediaInstanceKey,
  preselectedGuid?: string,
): Promise<{ conflated: boolean; serverUrl: string; token: string }> {
  // Plex rating keys are always integers; coerce to break taint from a DB-read
  // string before it's interpolated into any admin-token URL below.
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const tag = `[fix-match/${mediaInstanceLabel("plex", instance)} ratingKey=${safeKey} target=tmdb://${correctTmdbId}]`;

  const plexConfig = await getPlexConfig(instance);
  if (!plexConfig.url || !plexConfig.token) throw new Error("Plex server not configured");

  const serverUrl = plexConfig.url.replace(/\/$/, "");

  const token = plexConfig.token;
  const headers = {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": "summonarr-server",
    "X-Plex-Product": "Summonarr",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };

  let title   = "";
  let year    = "";
  let imdbId  = "";

  const cacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${correctTmdbId}:details`;
  const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: cacheKey }, select: { data: true } });
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

    if (imdbId) {
      const hit = await plexMatchSearch({ manual: "1", includeGuids: "1", guid: `imdb://${imdbId}` });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (imdbId && !canonicalGuid) {
      const hit = await plexMatchSearch({
        manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en",
      });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (!canonicalGuid) {
      const hit = await plexMatchSearch({
        manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en",
      });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (!canonicalGuid) {
      const textParams: Record<string, string> = { manual: "1", includeGuids: "1" };
      if (title) textParams.title = title;
      if (year)  textParams.year  = year;
      const hit = await plexMatchSearch(textParams);
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
      if (!canonicalGuid) console.warn("[fix-match]", `${tag} all search strategies found no candidates — will use raw tmdb:// fallback`);
    }
  }

  await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}/unmatch`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  }).catch(() => null);

  await safeFetchAdminConfigured(`${serverUrl}/library/clean/bundles`, {
    method: "PUT",
    headers,
    timeoutMs: 60_000,
  }).catch(() => null);

  await new Promise((r) => setTimeout(r, 3_000));

  const applyMatch = async (guid: string, name: string, yr: string): Promise<Response> => {
    const params: Record<string, string> = { guid };
    if (name) params.name = name;
    if (yr)   params.year = yr;
    const url = `${serverUrl}/library/metadata/${safeKey}/match?` + new URLSearchParams(params);
    return safeFetchAdminConfigured(url, { method: "PUT", headers, timeoutMs: 30_000 });
  };

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

  // Best-effort, like the Jellyfin path's refresh: the match was already
  // APPLIED above, and pollForConfirmation below is the sole success arbiter —
  // a transient refresh failure must not report the whole fix-match as failed.
  await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}/refresh?force=1`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  }).catch((e: unknown) => { console.warn("[fix-match]", tag, "refresh call failed (non-fatal):", e); return null; });

  const pollForConfirmation = async (
    maxAttempts: number,
    intervalMs: number,
  ): Promise<{ confirmed: boolean; conflatedMerge: boolean; plexTmdbId?: string; plexImdbId?: string }> => {
    let plexTmdbId: string | undefined;
    let plexImdbId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const checkRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}?includeGuids=1`, {
        headers,
        timeoutMs: 10_000,
      }).catch(() => null);
      if (!checkRes?.ok) {
        continue;
      }
      const checkJson = await checkRes.json() as {
        MediaContainer?: { Metadata?: Array<{ guid?: string; Guid?: Array<{ id: string }> }> };
      };
      const item = checkJson?.MediaContainer?.Metadata?.[0];
      plexTmdbId = item?.Guid?.find((g) => g.id.startsWith("tmdb://"))?.id.replace("tmdb://", "")
                 ?? /themoviedb:\/\/(\d+)/.exec(item?.guid ?? "")?.[1];
      plexImdbId = item?.Guid?.find((g) => g.id.startsWith("imdb://"))?.id.replace("imdb://", "");

      const tmdbConfirmed =
        plexTmdbId === String(correctTmdbId) ||
        /themoviedb:\/\/(\d+)/.exec(item?.guid ?? "")?.[1] === String(correctTmdbId);

      const hasOtherTmdb = item?.Guid?.some(
        (g) => g.id.startsWith("tmdb://") && g.id !== `tmdb://${correctTmdbId}`,
      ) ?? false;
      const imdbConfirmed = !!imdbId && plexImdbId === imdbId && !hasOtherTmdb;

      const conflated = !tmdbConfirmed &&
        item?.Guid?.some((g) => g.id === `tmdb://${correctTmdbId}`) &&
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
        const res = await applyMatch(guid, name, yr);
        if (!res.ok) return false;
        await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${safeKey}/refresh?force=1`, {
          method: "PUT", headers, timeoutMs: 30_000,
        }).catch((e: unknown) => { console.warn("[fix-match]", tag, "refresh call failed (non-fatal):", e); return null; });
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

      for (const params of altSearches) {
        if (pollConfirmed || allConflated) break;
        const res = await safeFetchAdminConfigured(
          `${serverUrl}/library/metadata/${safeKey}/matches?` + new URLSearchParams(params),
          { headers, timeoutMs: 30_000 },
        ).catch(() => null);
        if (!res?.ok) continue;
        const json = await res.json() as { MediaContainer?: { SearchResult?: PlexSearchResult[] } };
        const results = json?.MediaContainer?.SearchResult ?? [];
        for (const c of results) {
          if (c.guid !== alreadyTriedGuid) {
            if (await tryGuid(c.guid, c.name ?? title, c.year ? String(c.year) : year)) break;
            if (allConflated) break;
          }
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
  throw new Error(
    `Plex did not confirm the match to tmdb://${correctTmdbId} — ${plexState}. ` +
    `Plex's metadata database may not have an entry for TMDB #${correctTmdbId}. ` +
    `Try a different candidate from the picker, or fix the match manually in Plex.`,
  );
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
}): Promise<string> {
  const { baseUrl, headers, previousTmdbId, correctTmdbId, lastSeenTmdbId, itemLocked, filePath } = opts;

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
async function fixJellyfinMatch(
  itemId: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  instance: MediaInstanceKey,
  filePath: string | null,
  previousTmdbId: number,
  background: boolean,
  report?: FixMatchReport,
): Promise<{ newItemId: string; baseUrl: string; apiKey: string }> {
  // Strip itemId to UUID-safe chars to break taint from a DB-read string before
  // it's interpolated into any admin-token URL below.
  const safeItemId = itemId.replace(/[^0-9a-f-]/gi, "");
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
    await safeFetchAdminConfigured(
      refreshUrl(safeItemId),
      { method: "POST", headers, timeoutMs: 30_000 },
    ).catch((e: unknown) => { console.warn("[fix-match]", tag, "Refresh call failed (non-fatal):", e); return null; });
  }

  let resolvedItemId = safeItemId;
  let confirmed = false;
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

    if (!checkRes?.ok) {
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
          `${baseUrl}/Items?Recursive=true&Fields=ProviderIds,Path&IncludeItemTypes=Movie,Series` +
          (searchTerm ? `&SearchTerm=${encodeURIComponent(searchTerm)}` : "") +
          `&Limit=50`,
          { headers, timeoutMs: 10_000 },
        ).catch(() => null);
        if (findRes?.ok) {
          const findJson = await findRes.json() as { Items?: Array<{ Id?: string; ProviderIds?: Record<string, string>; Path?: string }> };
          const items = findJson.Items ?? [];
          const byPath = items.find((i) => i.Path === filePath);
          const byTmdb = items.find((i) => {
            const pid = i.ProviderIds?.Tmdb ?? i.ProviderIds?.tmdb;
            return pid === String(correctTmdbId);
          });
          const found = byPath ?? byTmdb;
          if (found?.Id) {
            // Sanitize the upstream-supplied Id before it lands in a URL and the DB.
            const foundSafeId = found.Id.replace(/[^0-9a-f-]/gi, "");
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

    const checkJson = await checkRes.json() as { ProviderIds?: Record<string, string>; LockData?: boolean };
    const providerIds = checkJson?.ProviderIds;
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
    }));
  }
  if (applyTimedOut) {
    // The image-replacement refresh deferred above, now that the server has
    // confirmed the match and is no longer busy with the apply's own refresh.
    await safeFetchAdminConfigured(
      refreshUrl(resolvedItemId),
      { method: "POST", headers, timeoutMs: 30_000 },
    ).catch((e: unknown) => { console.warn("[fix-match]", tag, "Refresh call failed (non-fatal):", e); return null; });
  }
  return { newItemId: resolvedItemId, baseUrl, apiKey };
}

// ISSUE_ADMIN intentionally has fix-match access to resolve wrong-match issues without full admin privileges
type FixMatchInput = {
  server: "plex" | "jellyfin";
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  canonicalGuid?: string;
  serverInstance: string;
};
type FixMatchActor = { userId: string; userName: string | null | undefined };

// The whole remap — remote rewrite, cache-row transaction, audit, episode
// re-cache — as one unit that resolves to the client-facing result or throws a
// FixMatchError carrying the client-safe message + HTTP status. The POST
// handler either awaits it inline (the synchronous contract) or hands it to the
// job registry (guardrail 37a); both paths see exactly the same outcomes.
async function runFixMatch(input: FixMatchInput, actor: FixMatchActor, opts: { background: boolean; report?: FixMatchReport }): Promise<FixMatchJobResult> {
  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance } = input;

  // The remap is inherently two-phase: the remote library server must be
  // rewritten first (to learn the new item id), then the local cache row is
  // updated in a DB transaction. If the remote rewrite succeeds but the DB
  // transaction then fails, the library server and the cache disagree. Track
  // the moment the remote phase commits so the catch block can tell the
  // operator the remap landed remotely and a re-sync will reconcile the cache,
  // rather than implying nothing happened.
  let remoteRemapped = false;
  // Set when a title had several copies on the server and only some could be
  // remapped — the operator has to know the rest still carry the old match.
  let partialWarning: string | null = null;
  try {
    if (server === "plex") {
      const item = await prisma.plexLibraryItem.findFirst({
        where: { tmdbId, mediaType, serverInstance },
        select: { plexRatingKey: true, filePath: true },
      });
      if (!item?.plexRatingKey) {
        throw new FixMatchError("Plex rating key not found — re-sync first", 404);
      }
      opts.report?.({ phase: "applying", remoteApplied: false, attempt: 0, attempts: 0, readFailures: 0 });
      const plexResult = await fixPlexMatch(item.plexRatingKey, correctTmdbId, mediaType, serverInstance, canonicalGuid);
      remoteRemapped = true;

      await prisma.$transaction(async (tx) => {
        // Take the same advisory locks the sync orchestrator uses (2001 library, 2002
        // episode cache) so a concurrent sync can't clobber or interleave this manual
        // remap. Acquire 2001 before 2002 (one consistent global order → no deadlock).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
        // deleteMany, NOT delete: the confirmation poll above ran UNLOCKED for
        // up to minutes, so a library sync may already have reconciled this row
        // under the corrected id. `delete` on a missing unique row throws P2025
        // and would report a landed remap as a failed job (guardrail 37a).
        await tx.plexLibraryItem.deleteMany({ where: { tmdbId, mediaType, serverInstance } });
        await tx.plexLibraryItem.upsert({
          where: { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance } },
          create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: item.filePath, plexRatingKey: item.plexRatingKey },
          update: { plexRatingKey: item.plexRatingKey },
        });
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID.
        // TVEpisodeCache has NO serverInstance column, so this purge would also
        // erase another plex server's legitimately-matched rows for the old id.
        // Only purge when no other instance still holds it; otherwise the sync
        // orchestrator's union rebuild owns the shared namespace.
        const othersHoldOldId = await tx.plexLibraryItem.count({
          where: { tmdbId, mediaType, serverInstance: { not: serverInstance } },
        });
        if (othersHoldOldId === 0) {
          await tx.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId } });
        }
      }, { timeout: BATCH_TX_TIMEOUT });
      void logAudit({ userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "plex", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance } });

      if (mediaType === "TV") {
        getPlexEpisodesForShow(plexResult.serverUrl, plexResult.token, item.plexRatingKey, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            // TVEpisodeCache has NO serverInstance column: every plex server shares
            // one `source` namespace for a given show. Repopulating from the one
            // server we just re-matched therefore DELETES any other plex
            // server rows for this show. Only safe to own when this is the sole
            // registered plex server; otherwise leave the show to the sync
            // orchestrator, which rebuilds from the union of all of them.
            if ((await getMediaInstances("plex")).length > 1) return;
            await prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
              await tx.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => console.error("[fix-match]", "Plex episode re-cache failed:", err));
      }

      if (plexResult.conflated) {
        return {
          ok: true,
          warning: `DB updated to TMDB #${correctTmdbId}. However, Plex's metadata database has permanently merged both TMDB IDs into one entry — Plex will continue to display the old metadata. To fix the Plex display, delete the conflicting metadata bundles from the Plex server's Metadata/Movies directory and run a full Plex scan.`,
        };
      }

    } else {
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
      const targetItemIds = Array.from(new Set([
        ...(item?.jellyfinItemId ? [item.jellyfinItemId] : []),
        ...(item?.jellyfinItemIds ?? []),
      ]));
      if (targetItemIds.length === 0) {
        throw new FixMatchError("Jellyfin item ID not found — re-sync first", 404);
      }
      // Serial, not concurrent: each call drives a FullRefresh on the server and
      // then polls for confirmation, and hammering a Jellyfin box with parallel
      // metadata refreshes is how these calls start timing out.
      const applied: Array<Awaited<ReturnType<typeof fixJellyfinMatch>>> = [];
      const failedCopies: string[] = [];
      for (const targetId of targetItemIds) {
        try {
          applied.push(await fixJellyfinMatch(targetId, correctTmdbId, mediaType, serverInstance, item?.filePath ?? null, tmdbId, opts.background, opts.report));
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
      const resolvedItemIds = Array.from(new Set(applied.map((r) => r.newItemId)));
      remoteRemapped = true;
      if (failedCopies.length > 0) {
        partialWarning =
          `DB updated to TMDB #${correctTmdbId}, and ${applied.length} of ${targetItemIds.length} copies of this title were re-matched on Jellyfin. ` +
          `${failedCopies.length} could not be — those copies still report the old match, so a later library sync may bring it back. Retry, or fix them in Jellyfin directly.`;
      }

      await prisma.$transaction(async (tx) => {
        // Same locks as the sync orchestrator (2001 library, 2002 episode), 2001 before
        // 2002, so a concurrent sync can't clobber/interleave this manual remap.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
        // deleteMany, NOT delete: the confirmation poll above ran UNLOCKED for
        // up to ~10 minutes in background mode, so a library sync may already
        // have reconciled this row under the corrected id. `delete` on a missing
        // unique row throws P2025 and would report a landed remap as a failed
        // job (guardrail 37a).
        await tx.jellyfinLibraryItem.deleteMany({ where: { tmdbId, mediaType, serverInstance } });
        await tx.jellyfinLibraryItem.upsert({
          where: { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance } },
          create: { tmdbId: correctTmdbId, mediaType, serverInstance, filePath: item?.filePath ?? null, jellyfinItemId: resolvedItemId, jellyfinItemIds: resolvedItemIds },
          update: { jellyfinItemId: resolvedItemId, jellyfinItemIds: resolvedItemIds },
        });
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID.
        // TVEpisodeCache has NO serverInstance column, so this purge would also
        // erase another jellyfin server's legitimately-matched rows for the old
        // id. Only purge when no other instance still holds it; otherwise the
        // sync orchestrator's union rebuild owns the shared namespace.
        const othersHoldOldId = await tx.jellyfinLibraryItem.count({
          where: { tmdbId, mediaType, serverInstance: { not: serverInstance } },
        });
        if (othersHoldOldId === 0) {
          await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId } });
        }
      }, { timeout: BATCH_TX_TIMEOUT });
      void logAudit({ userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "jellyfin", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance } });

      if (mediaType === "TV") {
        getJellyfinEpisodesForShow(jellyfinResult.baseUrl, jellyfinResult.apiKey, resolvedItemId, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            // TVEpisodeCache has NO serverInstance column: every jellyfin server shares
            // one `source` namespace for a given show. Repopulating from the one
            // server we just re-matched therefore DELETES any other jellyfin
            // server rows for this show. Only safe to own when this is the sole
            // registered jellyfin server; otherwise leave the show to the sync
            // orchestrator, which rebuilds from the union of all of them.
            if ((await getMediaInstances("jellyfin")).length > 1) return;
            await prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
              await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => console.error("[fix-match]", "Jellyfin episode re-cache failed:", err));
      }
    }

    return partialWarning ? { ok: true, warning: partialWarning } : { ok: true };
  } catch (err) {
    if (err instanceof FixMatchError) throw err;
    // Log the real detail server-side only — the message can carry the
    // configured Plex/Jellyfin server URL, internal paths, or upstream
    // response bodies. Return a generic error to the client.
    const serverLabel = mediaInstanceLabel(server, serverInstance);
    const errClass = err instanceof Error ? err.constructor.name : "Error";
    console.error("[fix-match]", `${serverLabel} error (${errClass})`, err instanceof Error ? err.message : err);
    // When the remote remap already committed, the failure is in the DB phase:
    // the library server now points at the corrected TMDB id but the local cache
    // still references the old one. Tell the operator so they can re-sync (which
    // rebuilds the cache from the library) instead of assuming the op was a no-op.
    if (remoteRemapped) {
      // Name the instance too — on a multi-server deployment the operator needs
      // to know WHICH server now disagrees with the cache to pick the re-sync.
      const base = server === "plex" ? "Plex" : "Jellyfin";
      const serverName = serverInstance === DEFAULT_MEDIA_INSTANCE ? base : `${base} (${serverInstance})`;
      console.warn("[fix-match]", `${serverLabel} remapped remotely but the DB update failed for tmdb:${tmdbId} → ${correctTmdbId}; cache is out of sync until a re-sync runs`);
      throw new FixMatchError(`${serverName} was re-matched to TMDB #${correctTmdbId}, but updating the local library cache failed. Run a library re-sync to reconcile the cache with ${serverName}.`, 502);
    }
    throw new FixMatchError("Fix-match operation failed", 502);
  }
}

export const POST = withIssueAdmin(async (request, _ctx, session) => {
  // fix-match runs ~60s of Plex/Jellyfin remap calls plus DB writes — without
  // a rate limit, an admin loop (intentional or scripted) can saturate the
  // upstream servers and pile up partial two-phase commits (remote rewrite
  // succeeds, DB tx fails). 10/min/admin matches the broader admin-write cap.
  if (!checkRateLimit(`fix-match:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "Too many fix-match operations — try again in a minute." },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<FixMatchBody>(request, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid } = body;

  if (server !== "plex" && server !== "jellyfin") {
    return NextResponse.json({ error: "server must be 'plex' or 'jellyfin'" }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be 'MOVIE' or 'TV'" }, { status: 400 });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  if (!Number.isInteger(correctTmdbId) || correctTmdbId <= 0) {
    return NextResponse.json({ error: "correctTmdbId must be a positive integer" }, { status: 400 });
  }
  if (tmdbId === correctTmdbId) {
    return NextResponse.json({ error: "TMDB IDs are already the same" }, { status: 400 });
  }
  if (body.serverInstance !== undefined && !isValidMediaInstanceSlug(body.serverInstance)) {
    return NextResponse.json({ error: `invalid serverInstance: ${body.serverInstance}` }, { status: 400 });
  }
  const serverInstance = body.serverInstance ?? DEFAULT_MEDIA_INSTANCE;
  const input: FixMatchInput = { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance };
  const actor: FixMatchActor = { userId: session.user.id, userName: session.user.name ?? session.user.email };

  // Background mode (guardrail 37a): a series remap waits on the media server
  // for minutes — longer than a reverse proxy keeps one request open — so the
  // browser polls instead of holding the request. An identical job already
  // running is returned as-is, never started twice.
  if (body.async === true) {
    // Join detection before start (both synchronous, so atomic per request):
    // `joined: true` tells the client its submission attached to an
    // already-running identical remap — whose candidate selection may differ.
    const key = fixMatchJobKey(input);
    const existing = findRunningFixMatchJob(key);
    if (existing) {
      return NextResponse.json({ ok: true, jobId: existing.id, status: existing.status, joined: true }, { status: 202 });
    }
    try {
      const job = startFixMatchJob(key, (report) => runFixMatch(input, actor, { background: true, report }));
      return NextResponse.json({ ok: true, jobId: job.id, status: job.status }, { status: 202 });
    } catch (err) {
      // The registry's concurrent-running cap (429) — map like the sync branch.
      if (err instanceof FixMatchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  try {
    return NextResponse.json(await runFixMatch(input, actor, { background: false }));
  } catch (err) {
    if (err instanceof FixMatchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // runFixMatch maps every failure to a FixMatchError; this is defensive.
    console.error("[fix-match] unexpected error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Fix-match operation failed" }, { status: 502 });
  }
});
