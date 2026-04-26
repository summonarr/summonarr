import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";

import { tmdbAuth } from "@/lib/tmdb-auth";
import { getPlexEpisodesForShow } from "@/lib/plex";
import { getJellyfinEpisodesForShow } from "@/lib/jellyfin";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";

const TMDB_HOSTS = ["api.themoviedb.org"];

// %s indirection so tainted template results (Plex/TMDB titles, GUIDs, etc.) land
// in the *value* position of console.* and never get format-specifier-interpreted.
const flog   = (msg: string, ...rest: unknown[]): void => { console.log("%s", msg, ...rest); };
const fwarn  = (msg: string, ...rest: unknown[]): void => { console.warn("%s", msg, ...rest); };
const ferror = (msg: string, ...rest: unknown[]): void => { console.error("%s", msg, ...rest); };

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

async function fixPlexMatch(
  ratingKey: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  preselectedGuid?: string,
): Promise<{ conflated: boolean; serverUrl: string; token: string }> {
  // Plex rating keys are always integers; coerce to break taint from DB-read string
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const tag = `[fix-match/plex ratingKey=${safeKey} target=tmdb://${correctTmdbId}]`;
  flog(`${tag} starting`);

  const [urlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);
  if (!urlRow?.value || !tokenRow?.value) throw new Error("Plex server not configured");

  const serverUrl = urlRow.value.replace(/\/$/, "");
  flog(`${tag} server URL: ${serverUrl}`);

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
      flog(`${tag} title from TMDB cache: "${title}" (${year}) imdbId=${imdbId || "none"}`);
    } catch { }
  }

  if (!title) {
    flog(`${tag} no TMDB cache hit — falling back to current Plex metadata`);
    const metaRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}`, {
      headers,
      timeoutMs: 15_000,
    });
    if (metaRes.ok) {
      const metaJson = await metaRes.json() as { MediaContainer?: { Metadata?: Array<{ title?: string; year?: number }> } };
      const meta = metaJson?.MediaContainer?.Metadata?.[0];
      title = meta?.title ?? "";
      year  = meta?.year  ? String(meta.year) : "";
      flog(`${tag} title from Plex metadata: "${title}" (${year})`);
    } else {
      fwarn(`${tag} Plex metadata fetch failed: ${metaRes.status}`);
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
        flog(`${tag} imdbId from TMDB external_ids: ${imdbId || "not found"}`);
      } else {
        fwarn(`${tag} TMDB external_ids fetch failed: ${extRes?.status ?? "network error"}`);
      }
    } else {
      fwarn(`${tag} No TMDB credentials set (TMDB_READ_TOKEN or TMDB_API_KEY) — cannot fetch IMDB ID`);
    }
  }

  let canonicalGuid: string | null = preselectedGuid ?? null;
  let matchName = title;
  let matchYear = year;

  if (canonicalGuid) {
    flog(`${tag} using preselected canonical GUID: ${canonicalGuid}`);
  } else {
    const plexMatchSearch = async (label: string, params: Record<string, string>): Promise<PlexSearchResult | null> => {
      flog(tag, `search [${label}]:`, params);
      const res = await safeFetchAdminConfigured(
        `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
        { headers, timeoutMs: 30_000 },
      ).catch(() => null);
      flog(`${tag} search [${label}] response: ${res?.status ?? "network error"}`);
      if (!res?.ok) return null;
      const json = await res.json() as { MediaContainer?: { SearchResult?: PlexSearchResult[] } };
      const results = json?.MediaContainer?.SearchResult ?? [];
      flog(`${tag} search [${label}] candidates: ${results.length}`);
      results.forEach((c) => flog(`${tag}   [${label}] guid="${c.guid}" name="${c.name}" year=${c.year}`));
      return results[0] ?? null;
    };

    if (imdbId) {
      const hit = await plexMatchSearch("imdb-guid", { manual: "1", includeGuids: "1", guid: `imdb://${imdbId}` });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (imdbId && !canonicalGuid) {
      const hit = await plexMatchSearch("imdb-agent", {
        manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en",
      });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (!canonicalGuid) {
      const hit = await plexMatchSearch("tmdb-agent", {
        manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en",
      });
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
    }

    if (!canonicalGuid) {
      const textParams: Record<string, string> = { manual: "1", includeGuids: "1" };
      if (title) textParams.title = title;
      if (year)  textParams.year  = year;
      const hit = await plexMatchSearch("title-year", textParams);
      if (hit) { canonicalGuid = hit.guid; if (hit.name) matchName = hit.name; if (hit.year) matchYear = String(hit.year); }
      if (!canonicalGuid) fwarn(`${tag} all search strategies found no candidates — will use raw tmdb:// fallback`);
    }
  }

  const unmatchRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/unmatch`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  }).catch(() => null);
  flog(`${tag} PUT /unmatch response: ${unmatchRes?.status ?? "network error"}`);

  const cleanRes = await safeFetchAdminConfigured(`${serverUrl}/library/clean/bundles`, {
    method: "PUT",
    headers,
    timeoutMs: 60_000,
  }).catch(() => null);
  flog(`${tag} PUT /library/clean/bundles response: ${cleanRes?.status ?? "network error"}`);

  await new Promise((r) => setTimeout(r, 3_000));

  const applyMatch = async (guid: string, name: string, yr: string): Promise<Response> => {
    const params: Record<string, string> = { guid };
    if (name) params.name = name;
    if (yr)   params.year = yr;
    const url = `${serverUrl}/library/metadata/${ratingKey}/match?` + new URLSearchParams(params);
    flog(`${tag} PUT /match url=${url}`);
    return safeFetchAdminConfigured(url, { method: "PUT", headers, timeoutMs: 30_000 });
  };

  if (canonicalGuid) {
    const res = await applyMatch(canonicalGuid, matchName, matchYear);
    flog(`${tag} canonical PUT /match response: ${res.status}`);
    if (!res.ok) throw new Error(`Plex fix-match failed with canonical guid: ${res.status}`);
  } else {
    const modernRes = await applyMatch(`tmdb://${correctTmdbId}`, title, year);
    flog(`${tag} modern fallback PUT /match response: ${modernRes.status}`);
    if (!modernRes.ok) {
      const legacyRes = await applyMatch(`com.plexapp.agents.themoviedb://${correctTmdbId}?lang=en`, title, year);
      flog(`${tag} legacy fallback PUT /match response: ${legacyRes.status}`);
      if (!legacyRes.ok) {
        throw new Error(`Plex fix-match failed: ${modernRes.status} (tmdb://), ${legacyRes.status} (legacy) — and match search returned no result for TMDB #${correctTmdbId}`);
      }
    }
  }

  const refreshRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/refresh?force=1`, {
    method: "PUT",
    headers,
    timeoutMs: 30_000,
  });
  flog(`${tag} PUT /refresh response: ${refreshRes.status}`);

  const pollForConfirmation = async (
    label: string,
    maxAttempts: number,
    intervalMs: number,
  ): Promise<{ confirmed: boolean; conflatedMerge: boolean; plexTmdbId?: string; plexImdbId?: string }> => {
    flog(`${tag} ${label}: polling for confirmation (imdbId="${imdbId || "none"}")...`);
    let plexTmdbId: string | undefined;
    let plexImdbId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const checkRes = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}?includeGuids=1`, {
        headers,
        timeoutMs: 10_000,
      }).catch(() => null);
      if (!checkRes?.ok) {
        flog(`${tag} ${label} poll ${attempt + 1}: fetch failed (${checkRes?.status ?? "network error"})`);
        continue;
      }
      const checkJson = await checkRes.json() as {
        MediaContainer?: { Metadata?: Array<{ guid?: string; Guid?: Array<{ id: string }> }> };
      };
      const item = checkJson?.MediaContainer?.Metadata?.[0];
      const guids = item?.Guid?.map((g) => g.id) ?? [];
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
      flog(
        `${tag} ${label} poll ${attempt + 1}: guid="${item?.guid}" crossRefs=${JSON.stringify(guids)} ` +
        `tmdbConfirmed=${tmdbConfirmed} imdbConfirmed=${imdbConfirmed} conflated=${conflated} ` +
        `(our imdbId="${imdbId || "none"}" plexImdb="${plexImdbId ?? "none"}" plexTmdb="${plexTmdbId ?? "none"}")`,
      );
      if (tmdbConfirmed) return { confirmed: true, conflatedMerge: false, plexTmdbId, plexImdbId };
      if (imdbConfirmed) {
        fwarn(
          `${tag} IMDB confirmed (imdb://${imdbId}) but Plex primary tmdb is ${plexTmdbId} ` +
          `instead of ${correctTmdbId} — likely duplicate TMDB entries for same film. Treating as matched.`,
        );
        return { confirmed: true, conflatedMerge: false, plexTmdbId, plexImdbId };
      }
      if (conflated) {
        fwarn(
          `${tag} Plex has both tmdb://${plexTmdbId} (primary) and tmdb://${correctTmdbId} on the same hash — ` +
          `conflated IDs. Primary is wrong; breaking immediately to try legacy agent.`,
        );

        return { confirmed: false, conflatedMerge: true, plexTmdbId, plexImdbId };
      }
    }
    return { confirmed: false, conflatedMerge: false, plexTmdbId, plexImdbId };
  };

  const modern = await pollForConfirmation("modern", 10, 3_000);

  let pollConfirmed   = modern.confirmed;
  let allConflated    = modern.conflatedMerge;
  let plexTmdbId      = modern.plexTmdbId;
  let plexImdbId      = modern.plexImdbId;

  if (!pollConfirmed) {
    fwarn(
      `${tag} modern match resolved to tmdb://${plexTmdbId ?? "?"} imdb://${plexImdbId ?? "?"} — ` +
      `our target is tmdb://${correctTmdbId} imdb://${imdbId || "unknown"}.`,
    );

    if (allConflated) {
      fwarn(
        `${tag} conflated IDs detected on first poll — skipping fallback attempts. ` +
        `Plex has multiple metadata bundles on disk that conflict. ` +
        `The DB will be updated if IMDB confirms the correct film.`,
      );
    } else {
      const tryGuid = async (label: string, guid: string, name: string, yr: string): Promise<boolean> => {
        const res = await applyMatch(guid, name, yr);
        flog(`${tag} [${label}] PUT /match response: ${res.status}`);
        if (!res.ok) return false;
        const ref = await safeFetchAdminConfigured(`${serverUrl}/library/metadata/${ratingKey}/refresh?force=1`, {
          method: "PUT", headers, timeoutMs: 30_000,
        });
        flog(`${tag} [${label}] PUT /refresh response: ${ref.status}`);
        const poll = await pollForConfirmation(label, 6, 5_000);
        plexTmdbId = poll.plexTmdbId;
        plexImdbId = poll.plexImdbId;
        if (!poll.conflatedMerge) allConflated = false;
        if (poll.confirmed) { pollConfirmed = true; return true; }
        if (poll.conflatedMerge) { allConflated = true; return false; }
        return false;
      };

      const alreadyTriedGuid = canonicalGuid;
      const altSearches: Array<[string, Record<string, string>]> = [];
      if (imdbId) {
        altSearches.push(["imdb-agent", { manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" }]);
      }
      altSearches.push(["tmdb-agent", { manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" }]);

      for (const [label, params] of altSearches) {
        if (pollConfirmed || allConflated) break;
        flog(`${tag} trying alternative search [${label}]`);
        const res = await safeFetchAdminConfigured(
          `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
          { headers, timeoutMs: 30_000 },
        ).catch(() => null);
        if (!res?.ok) continue;
        const json = await res.json() as { MediaContainer?: { SearchResult?: PlexSearchResult[] } };
        const results = json?.MediaContainer?.SearchResult ?? [];
        flog(`${tag} [${label}] returned ${results.length} candidates`);
        for (const c of results) {
          flog(`${tag}   [${label}] guid="${c.guid}" name="${c.name}" year=${c.year}`);
          if (c.guid !== alreadyTriedGuid) {
            flog(`${tag} [${label}] found new hash — trying it`);
            if (await tryGuid(label, c.guid, c.name ?? title, c.year ? String(c.year) : year)) break;
            if (allConflated) break;
          }
        }
      }

      if (!pollConfirmed && !allConflated) {
        await tryGuid("legacy-agent", `com.plexapp.agents.themoviedb://${correctTmdbId}?lang=en`, title, year);
      }
    }
  }

  flog(`${tag} done`);
  if (pollConfirmed) return { conflated: false, serverUrl, token };

  if (allConflated && imdbId && plexImdbId === imdbId) {
    fwarn(
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

async function fixJellyfinMatch(
  itemId: string,
  correctTmdbId: number,
  mediaType: "MOVIE" | "TV",
  filePath: string | null,
): Promise<{ newItemId: string; baseUrl: string; apiKey: string }> {
  // Strip itemId to UUID-safe chars to break taint from DB-read string
  const safeItemId = itemId.replace(/[^0-9a-f-]/gi, "");
  const tag = `[fix-match/jellyfin itemId=${safeItemId} target=tmdb:${correctTmdbId}]`;
  flog(`${tag} starting`);

  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);
  if (!urlRow?.value || !keyRow?.value) throw new Error("Jellyfin server not configured");

  const baseUrl = urlRow.value.replace(/\/$/, "");
  flog(`${tag} base URL: ${baseUrl}`);

  const apiKey  = keyRow.value;
  const headers = {
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
  const searchType = mediaType === "MOVIE" ? "Movie" : "Series";
  flog(`${tag} POST /Items/RemoteSearch/${searchType}`);
  const searchRes = await safeFetchAdminConfigured(`${baseUrl}/Items/RemoteSearch/${searchType}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      SearchInfo: { ProviderIds: { Tmdb: String(correctTmdbId) } },
      ItemId: itemId,
      IncludeDisabledProviders: true,
    }),
    timeoutMs: 30_000,
  });
  flog(`${tag} RemoteSearch response: ${searchRes.status}`);
  if (!searchRes.ok) throw new Error(`Jellyfin remote search failed: ${searchRes.status}`);

  type JellyfinSearchResult = { ProviderIds?: Record<string, string>; Name?: string };
  const searchResults = await searchRes.json() as JellyfinSearchResult[];
  flog(`${tag} search results: ${searchResults.length} — ${JSON.stringify(searchResults.map((r) => ({ name: r.Name, ids: r.ProviderIds })))}`);
  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    throw new Error(`Jellyfin found no match for TMDB #${correctTmdbId} — check that Jellyfin can reach the metadata provider`);
  }

  const target = searchResults.find((r) => {
    const id = r.ProviderIds?.Tmdb ?? r.ProviderIds?.tmdb;
    return id === String(correctTmdbId);
  }) ?? searchResults[0];
  flog(`${tag} applying result: name="${(target as JellyfinSearchResult).Name}" ids=${JSON.stringify((target as JellyfinSearchResult).ProviderIds)}`);

  const applyRes = await safeFetchAdminConfigured(`${baseUrl}/Items/RemoteSearch/Apply/${itemId}?replaceAllImages=false`, {
    method: "POST",
    headers,
    body: JSON.stringify(target),
    timeoutMs: 90_000,
  });
  flog(`${tag} Apply response: ${applyRes.status}`);
  if (!applyRes.ok) throw new Error(`Jellyfin apply match failed: ${applyRes.status}`);

  const refreshRes = await safeFetchAdminConfigured(
    `${baseUrl}/Items/${itemId}/Refresh?MetadataRefreshMode=FullRefresh&ReplaceAllMetadata=true&ImageRefreshMode=FullRefresh&ReplaceAllImages=true`,
    { method: "POST", headers, timeoutMs: 30_000 },
  ).catch((e: unknown) => { fwarn(tag, "Refresh call failed (non-fatal):", e); return null; });
  flog(`${tag} Refresh response: ${refreshRes?.status ?? "failed"}`);

  flog(`${tag} polling for confirmation...`);
  let resolvedItemId = itemId;
  let confirmed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));

    const checkRes = await safeFetchAdminConfigured(
      `${baseUrl}/Items/${resolvedItemId}?Fields=ProviderIds`,
      { headers, timeoutMs: 10_000 },
    ).catch(() => null);

    if (!checkRes?.ok) {
      flog(`${tag} poll attempt ${attempt + 1}: itemId ${resolvedItemId} invalid (${checkRes?.status ?? "network error"}), searching by file path`);
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
            const pid = found.ProviderIds?.Tmdb ?? found.ProviderIds?.tmdb;
            const isConfirmed = pid === String(correctTmdbId);
            flog(`${tag} poll attempt ${attempt + 1}: found via search (${byPath ? "path" : "tmdb"}) → id=${found.Id} ProviderIds=${JSON.stringify(found.ProviderIds)} confirmed=${isConfirmed}`);
            if (isConfirmed) {
              resolvedItemId = found.Id;
              confirmed = true;
              break;
            }
            if (byPath) resolvedItemId = found.Id;
          } else {
            flog(`${tag} poll attempt ${attempt + 1}: search returned ${items.length} item(s), none matched path or TMDB ID`);
          }
        } else {
          flog(`${tag} poll attempt ${attempt + 1}: search failed (${findRes?.status ?? "network error"})`);
        }
      } else {
        flog(`${tag} poll attempt ${attempt + 1}: no file path available for search`);
      }
      continue;
    }

    const checkJson = await checkRes.json() as { ProviderIds?: Record<string, string> };
    const providerIds = checkJson?.ProviderIds;
    confirmed = (providerIds?.Tmdb ?? providerIds?.tmdb) === String(correctTmdbId);
    flog(`${tag} poll attempt ${attempt + 1}: ProviderIds=${JSON.stringify(providerIds)} confirmed=${confirmed}`);
    if (confirmed) break;
  }

  if (!confirmed) {
    fwarn(`${tag} could not confirm new item ID after all attempts — item ID unchanged in DB`);
  }
  flog(`${tag} done`);
  return { newItemId: confirmed ? resolvedItemId : itemId, baseUrl, apiKey };
}

export async function POST(request: NextRequest) {
  // ISSUE_ADMIN intentionally has fix-match access to resolve wrong-match issues without full admin privileges
  const session = await requireAuth({ role: "ISSUE_ADMIN" });
  if (session instanceof NextResponse) return session;

  let body: FixMatchBody;
  try {
    body = await request.json() as FixMatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid } = body;

  if (!server || !tmdbId || !mediaType || !correctTmdbId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (tmdbId === correctTmdbId) {
    return NextResponse.json({ error: "TMDB IDs are already the same" }, { status: 400 });
  }

  flog(`[fix-match] request: server=${server} tmdbId=${tmdbId} mediaType=${mediaType} correctTmdbId=${correctTmdbId}`);

  try {
    if (server === "plex") {
      const item = await prisma.plexLibraryItem.findUnique({
        where: { tmdbId_mediaType: { tmdbId, mediaType } },
        select: { plexRatingKey: true, filePath: true },
      });
      flog(`[fix-match] plex DB lookup: ratingKey=${item?.plexRatingKey} filePath=${item?.filePath}`);
      if (!item?.plexRatingKey) {
        return NextResponse.json({ error: "Plex rating key not found — re-sync first" }, { status: 404 });
      }
      const plexResult = await fixPlexMatch(item.plexRatingKey, correctTmdbId, mediaType, canonicalGuid);

      await prisma.$transaction([
        prisma.plexLibraryItem.delete({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
        prisma.plexLibraryItem.upsert({
          where: { tmdbId_mediaType: { tmdbId: correctTmdbId, mediaType } },
          create: { tmdbId: correctTmdbId, mediaType, filePath: item.filePath, plexRatingKey: item.plexRatingKey },
          update: { plexRatingKey: item.plexRatingKey },
        }),
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID
        prisma.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId } }),
      ]);
      flog(`[fix-match] plex DB updated: ${tmdbId} → ${correctTmdbId}`);
      void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "LIBRARY_SYNC", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "plex", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType } });

      if (mediaType === "TV") {
        getPlexEpisodesForShow(plexResult.serverUrl, plexResult.token, item.plexRatingKey, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            await prisma.$transaction(async (tx) => {
              await tx.tVEpisodeCache.deleteMany({ where: { source: "plex", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => ferror("[fix-match] Plex episode re-cache failed:", err));
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
      flog(`[fix-match] jellyfin DB lookup: itemId=${item?.jellyfinItemId} filePath=${item?.filePath}`);
      if (!item?.jellyfinItemId) {
        return NextResponse.json({ error: "Jellyfin item ID not found — re-sync first" }, { status: 404 });
      }
      const jellyfinResult = await fixJellyfinMatch(item.jellyfinItemId, correctTmdbId, mediaType, item.filePath);
      const resolvedItemId = jellyfinResult.newItemId;
      if (resolvedItemId !== item.jellyfinItemId) {
        flog(`[fix-match] jellyfin item ID changed: ${item.jellyfinItemId} → ${resolvedItemId}`);
      }

      await prisma.$transaction([
        prisma.jellyfinLibraryItem.delete({ where: { tmdbId_mediaType: { tmdbId, mediaType } } }),
        prisma.jellyfinLibraryItem.upsert({
          where: { tmdbId_mediaType: { tmdbId: correctTmdbId, mediaType } },
          create: { tmdbId: correctTmdbId, mediaType, filePath: item.filePath, jellyfinItemId: resolvedItemId },
          update: { jellyfinItemId: resolvedItemId },
        }),
        // Stale episode cache references the old tmdbId; must be cleared so re-cache picks up correct ID
        prisma.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId } }),
      ]);
      flog(`[fix-match] jellyfin DB updated: ${tmdbId} → ${correctTmdbId} (itemId: ${resolvedItemId})`);
      void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "LIBRARY_SYNC", target: `tmdb:${tmdbId}`, details: { type: "fix-match", source: "jellyfin", fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType } });

      if (mediaType === "TV") {
        getJellyfinEpisodesForShow(jellyfinResult.baseUrl, jellyfinResult.apiKey, resolvedItemId, correctTmdbId)
          .then(async (episodes) => {
            if (episodes.length === 0) return;
            await prisma.$transaction(async (tx) => {
              await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId: correctTmdbId } });
              await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
            }, { timeout: BATCH_TX_TIMEOUT });
          })
          .catch((err) => ferror("[fix-match] Jellyfin episode re-cache failed:", err));
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const serverLabel = server === "plex" ? "plex" : "jellyfin";
    const errClass = err instanceof Error ? err.constructor.name : "Error";
    ferror(`[fix-match] ${serverLabel} error (${errClass})`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
