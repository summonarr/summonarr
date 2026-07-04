import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withIssueAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";

import { tmdbAuth } from "@/lib/tmdb-auth";
import { getPlexEpisodesForShow } from "@/lib/plex";
import { getJellyfinEpisodesForShow } from "@/lib/jellyfin";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const TMDB_HOSTS = ["api.themoviedb.org"];

type FixMatchBody = {
  server:         "plex" | "jellyfin";
  tmdbId:         number;
  mediaType:      "MOVIE" | "TV";
  correctTmdbId:  number;

  canonicalGuid?: string;
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
async function fixPlexMatch(
  ratingKey: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  preselectedGuid?: string,
): Promise<{ conflated: boolean; serverUrl: string; token: string }> {
  // Plex rating keys are always integers; coerce to break taint from a DB-read
  // string before it's interpolated into any admin-token URL below.
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const tag = `[fix-match/plex ratingKey=${safeKey} target=tmdb://${correctTmdbId}]`;

  const [urlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);
  if (!urlRow?.value || !tokenRow?.value) throw new Error("Plex server not configured");

  const serverUrl = urlRow.value.replace(/\/$/, "");

  const token = tokenRow.value;
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
        `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
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

  await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/unmatch`, {
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
    const url = `${serverUrl}/library/metadata/${ratingKey}/match?` + new URLSearchParams(params);
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

  await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/refresh?force=1`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  });

  const pollForConfirmation = async (
    maxAttempts: number,
    intervalMs: number,
  ): Promise<{ confirmed: boolean; conflatedMerge: boolean; plexTmdbId?: string; plexImdbId?: string }> => {
    let plexTmdbId: string | undefined;
    let plexImdbId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const checkRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}?includeGuids=1`, {
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
        await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/refresh?force=1`, {
          method: "PUT", headers, timeoutMs: 30_000,
        });
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
          `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
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

// Remaps a Jellyfin library item to the correct TMDB id: remote-search for a
// candidate carrying correctTmdbId, apply it, refresh, then poll until Jellyfin
// confirms — throws if it never confirms. Returns the (possibly new) item id.
async function fixJellyfinMatch(
  itemId: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  filePath: string | null,
): Promise<{ newItemId: string; baseUrl: string; apiKey: string }> {
  // Strip itemId to UUID-safe chars to break taint from a DB-read string before
  // it's interpolated into any admin-token URL below.
  const safeItemId = itemId.replace(/[^0-9a-f-]/gi, "");
  const tag = `[fix-match/jellyfin itemId=${safeItemId} target=tmdb:${correctTmdbId}]`;

  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);
  if (!urlRow?.value || !keyRow?.value) throw new Error("Jellyfin server not configured");

  const baseUrl = urlRow.value.replace(/\/$/, "");

  const apiKey  = keyRow.value;
  const headers = {
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
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

  const applyRes = await safeFetchAdminConfigured(`${baseUrl}/Items/RemoteSearch/Apply/${safeItemId}?replaceAllImages=false`, {
    method: "POST",
    headers,
    body: JSON.stringify(target),
    timeoutMs: 90_000,
  });
  if (!applyRes.ok) throw new Error(`Jellyfin apply match failed: ${applyRes.status}`);

  await safeFetchAdminConfigured(
    `${baseUrl}/Items/${safeItemId}/Refresh?MetadataRefreshMode=FullRefresh&ReplaceAllMetadata=true&ImageRefreshMode=FullRefresh&ReplaceAllImages=true`,
    { method: "POST", headers, timeoutMs: 30_000 },
  ).catch((e: unknown) => { console.warn("[fix-match]", tag, "Refresh call failed (non-fatal):", e); return null; });

  let resolvedItemId = safeItemId;
  let confirmed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));

    const checkRes = await safeFetchAdminConfigured(
      `${baseUrl}/Items/${resolvedItemId}?Fields=ProviderIds`,
      { headers, timeoutMs: 10_000 },
    ).catch(() => null);

    if (!checkRes?.ok) {
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

    const checkJson = await checkRes.json() as { ProviderIds?: Record<string, string> };
    const providerIds = checkJson?.ProviderIds;
    confirmed = (providerIds?.Tmdb ?? providerIds?.tmdb) === String(correctTmdbId);
    if (confirmed) break;
  }

  if (!confirmed) {
    // Throw when unconfirmed so the caller's DB write aborts — otherwise we'd persist
    // a tmdbId Jellyfin never confirmed. Matches the Plex path.
    throw new Error(`Jellyfin did not confirm TMDB #${correctTmdbId} after applying the match — library mapping not updated. Retry, or check that Jellyfin can reach its metadata provider.`);
  }
  return { newItemId: resolvedItemId, baseUrl, apiKey };
}

// ISSUE_ADMIN intentionally has fix-match access to resolve wrong-match issues without full admin privileges
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

  // The remap is inherently two-phase: the remote library server must be
  // rewritten first (to learn the new item id), then the local cache row is
  // updated in a DB transaction. If the remote rewrite succeeds but the DB
  // transaction then fails, the library server and the cache disagree. Track
  // the moment the remote phase commits so the catch block can tell the
  // operator the remap landed remotely and a re-sync will reconcile the cache,
  // rather than implying nothing happened.
  let remoteRemapped = false;
  try {
    if (server === "plex") {
      const item = await prisma.plexLibraryItem.findUnique({
        where: { tmdbId_mediaType: { tmdbId, mediaType } },
        select: { plexRatingKey: true, filePath: true },
      });
      if (!item?.plexRatingKey) {
        return NextResponse.json({ error: "Plex rating key not found — re-sync first" }, { status: 404 });
      }
      const plexResult = await fixPlexMatch(item.plexRatingKey, correctTmdbId, mediaType, canonicalGuid);
      remoteRemapped = true;

      await prisma.$transaction(async (tx) => {
        // Take the same advisory locks the sync orchestrator uses (2001 library, 2002
        // episode cache) so a concurrent sync can't clobber or interleave this manual
        // remap. Acquire 2001 before 2002 (one consistent global order → no deadlock).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
        await tx.plexLibraryItem.delete({ where: { tmdbId_mediaType: { tmdbId, mediaType } } });
        await tx.plexLibraryItem.upsert({
          where: { tmdbId_mediaType: { tmdbId: correctTmdbId, mediaType } },
          create: { tmdbId: correctTmdbId, mediaType, filePath: item.filePath, plexRatingKey: item.plexRatingKey },
          update: { plexRatingKey: item.plexRatingKey },
        });
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID
        await tx.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId } });
      }, { timeout: BATCH_TX_TIMEOUT });
      void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "FIX_MATCH", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "plex", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType } });

      if (mediaType === "TV") {
        getPlexEpisodesForShow(plexResult.serverUrl, plexResult.token, item.plexRatingKey, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            await prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
              await tx.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => console.error("[fix-match]", "Plex episode re-cache failed:", err));
      }

      if (plexResult.conflated) {
        return NextResponse.json({
          ok: true,
          warning: `DB updated to TMDB #${correctTmdbId}. However, Plex's metadata database has permanently merged both TMDB IDs into one entry — Plex will continue to display the old metadata. To fix the Plex display, delete the conflicting metadata bundles from the Plex server's Metadata/Movies directory and run a full Plex scan.`,
        });
      }

    } else {
      const item = await prisma.jellyfinLibraryItem.findUnique({
        where: { tmdbId_mediaType: { tmdbId, mediaType } },
        select: { jellyfinItemId: true, filePath: true },
      });
      if (!item?.jellyfinItemId) {
        return NextResponse.json({ error: "Jellyfin item ID not found — re-sync first" }, { status: 404 });
      }
      const jellyfinResult = await fixJellyfinMatch(item.jellyfinItemId, correctTmdbId, mediaType, item.filePath);
      const resolvedItemId = jellyfinResult.newItemId;
      remoteRemapped = true;

      await prisma.$transaction(async (tx) => {
        // Same locks as the sync orchestrator (2001 library, 2002 episode), 2001 before
        // 2002, so a concurrent sync can't clobber/interleave this manual remap.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
        await tx.jellyfinLibraryItem.delete({ where: { tmdbId_mediaType: { tmdbId, mediaType } } });
        await tx.jellyfinLibraryItem.upsert({
          where: { tmdbId_mediaType: { tmdbId: correctTmdbId, mediaType } },
          create: { tmdbId: correctTmdbId, mediaType, filePath: item.filePath, jellyfinItemId: resolvedItemId },
          update: { jellyfinItemId: resolvedItemId },
        });
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID
        await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId } });
      }, { timeout: BATCH_TX_TIMEOUT });
      void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "FIX_MATCH", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "jellyfin", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType } });

      if (mediaType === "TV") {
        getJellyfinEpisodesForShow(jellyfinResult.baseUrl, jellyfinResult.apiKey, resolvedItemId, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            await prisma.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
              await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => console.error("[fix-match]", "Jellyfin episode re-cache failed:", err));
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Log the real detail server-side only — the message can carry the
    // configured Plex/Jellyfin server URL, internal paths, or upstream
    // response bodies. Return a generic error to the client.
    const serverLabel = server === "plex" ? "plex" : "jellyfin";
    const errClass = err instanceof Error ? err.constructor.name : "Error";
    console.error("[fix-match]", `${serverLabel} error (${errClass})`, err instanceof Error ? err.message : err);
    // When the remote remap already committed, the failure is in the DB phase:
    // the library server now points at the corrected TMDB id but the local cache
    // still references the old one. Tell the operator so they can re-sync (which
    // rebuilds the cache from the library) instead of assuming the op was a no-op.
    if (remoteRemapped) {
      const serverName = server === "plex" ? "Plex" : "Jellyfin";
      console.warn("[fix-match]", `${serverLabel} remapped remotely but the DB update failed for tmdb:${tmdbId} → ${correctTmdbId}; cache is out of sync until a re-sync runs`);
      return NextResponse.json(
        {
          error: `${serverName} was re-matched to TMDB #${correctTmdbId}, but updating the local library cache failed. Run a library re-sync to reconcile the cache with ${serverName}.`,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "Fix-match operation failed" }, { status: 502 });
  }
});
