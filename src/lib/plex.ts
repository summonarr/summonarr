import { safeFetchTrusted, safeFetchAdminConfigured } from "./safe-fetch";

const PLEX_TV_HOSTS = ["plex.tv"];

export const PLEX_CLIENT_ID = "summonarr-server";

const PLEX_HEADERS = {
  "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
  "X-Plex-Product": "Summonarr",
  "X-Plex-Version": "1.0",
  "X-Plex-Model": "hosted",
  "X-Plex-Device": "Web",
  "X-Plex-Device-Name": "Summonarr",
  "X-Plex-Platform": "Web",
  Accept: "application/json",
};

export interface PlexUser {
  id: string;
  email: string;
  username: string;
  thumb: string;
}

export async function pingPlexToken(token: string, clientId?: string): Promise<boolean> {
  try {
    const res = await safeFetchTrusted("https://plex.tv/api/v2/ping", {
      allowedHosts: PLEX_TV_HOSTS,
      headers: {
        ...PLEX_HEADERS,
        ...(clientId ? { "X-Plex-Client-Identifier": clientId } : {}),
        "X-Plex-Token": token,
      },
      timeoutMs: 10_000,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getPlexUser(token: string, clientId?: string): Promise<PlexUser> {
  const res = await safeFetchTrusted("https://plex.tv/api/v2/user", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: {
      ...PLEX_HEADERS,
      ...(clientId ? { "X-Plex-Client-Identifier": clientId } : {}),
      "X-Plex-Token": token,
    },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch Plex user: ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  const email = typeof data.email === "string" ? data.email : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Plex user response missing valid email");
  }
  // Plex /api/v2/user returns id as a number; coerce to string for stable provider-subject binding
  const rawId = data.id;
  const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
  if (!id) {
    throw new Error("Plex user response missing required id");
  }
  return {
    id,
    email,
    username: (typeof data.username === "string" ? data.username : typeof data.title === "string" ? data.title : typeof data.friendlyName === "string" ? data.friendlyName : "") as string,
    thumb: (typeof data.thumb === "string" ? data.thumb : "") as string,
  };
}

export interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show";
}

interface PlexGuid {
  id: string;
}

interface PlexMetadataItem {
  guid?: string;
  Guid?: PlexGuid[];
  Media?: Array<{ Part?: Array<{ file?: string }> }>;
  ratingKey?: string;
  type?: string;
  title?: string;
  year?: number;
  summary?: string;
  contentRating?: string;
  addedAt?: number;
}

function plexServerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
    "X-Plex-Product": "Summonarr",
    "X-Plex-Version": "1.0",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

const FETCH_TIMEOUT_MS = 60_000;
// Timeout for a small single-shot server probe (/identity). The 60s default is
// calibrated for the paged library walk, not a ~1 KB identity read: multi-server
// callers iterate instances SEQUENTIALLY (the sign-in membership loop in auth.ts,
// the settings connection test), so one dead-but-configured server would
// otherwise add a full minute of dead wait per instance before the next one is
// even tried.
export const PLEX_IDENTITY_TIMEOUT_MS = 10_000;
const PLEX_PAGE_SIZE   = 1_000;
// Response cap per fetch. The safe-fetch default is 10 MB decompressed; a
// 1000-item page has ~10× headroom today, but match jellyfin.ts/arr.ts's 50 MB
// so a verbose Plex response (extra Guids/Media parts) can never abort a sync
// on the same undersized-cap failure arr.ts hit (guardrail 5).
const LIBRARY_FETCH_MAX_BYTES = 50 * 1024 * 1024;
const PAGE_RETRY_ATTEMPTS = 3;
const PAGE_RETRY_DELAY_MS = 2_000;

// Retry wrapper for the library walk's page fetches — the Jellyfin twin's
// fetchPage shape (its per-page retry is test-pinned precedent). One transient
// blip used to abort an entire instance's sync arm and defer availability by a
// full SYNC_INTERVAL. Retries are safe here: pages are idempotent GETs consumed
// before any DB write begins. attemptFn tags an error `noRetry` for non-429 4xx
// (a revoked token can never succeed on retry). Deliberately NOT inside
// plexFetch itself: the allLeaves probes and refreshPlexSection are single-shot
// best-effort by design.
async function withPlexRetry<T>(label: string, attemptFn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, PAGE_RETRY_DELAY_MS * attempt));
      console.warn(`[plex] retry ${attempt}/${PAGE_RETRY_ATTEMPTS} for ${label}`);
    }
    try {
      return await attemptFn();
    } catch (err) {
      lastErr = err;
      if ((err as { noRetry?: boolean }).noRetry) break;
    }
  }
  throw lastErr;
}

function tagNoRetryOn4xx(err: Error, status: number): Error {
  if (status >= 400 && status < 500 && status !== 429) return Object.assign(err, { noRetry: true });
  return err;
}

async function plexFetchAllPages<T>(
  baseUrl: string,
  token: string,
  // Return `true` to stop paging after this batch — the recentOnly early-stop
  // uses it once an entire addedAt-desc page predates the window.
  processItems: (items: T[]) => void | boolean,
): Promise<void> {
  // Hard ceiling on the walk. `total` comes from the SERVER's reported totalSize, so a
  // hostile or buggy Plex answer that keeps reporting more (or always returns a full
  // page) span this loop forever, streaming unbounded rows into the caller's accumulator.
  // The URL is an admin Setting, which makes the host trusted-ish but not infallible.
  // 2M items is far beyond any real library and still bounds memory and wall-clock.
  const MAX_ITEMS = 2_000_000;
  const MAX_PAGES = Math.ceil(MAX_ITEMS / PLEX_PAGE_SIZE);
  let pages = 0;
  let start = 0;
  let total = Infinity;
  while (start < total) {
    if (++pages > MAX_PAGES) {
      console.warn(`[plex] paginated fetch hit the ${MAX_ITEMS}-item ceiling at start=${start}; truncating.`);
      break;
    }
    const sep = baseUrl.includes("?") ? "&" : "?";
    const container = await withPlexRetry(`start=${start}`, async () => {
      const res = await plexFetch(
        `${baseUrl}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PLEX_PAGE_SIZE}`,
        token,
      );
      if (!res.ok) {
        throw tagNoRetryOn4xx(new Error(`Plex paginated fetch failed: ${res.status} at start=${start}`), res.status);
      }
      const data = await res.json() as { MediaContainer?: { Metadata?: T[]; totalSize?: number; size?: number } };
      if (!data.MediaContainer) throw new Error(`Plex paginated fetch returned no MediaContainer at start=${start}`);
      return data.MediaContainer;
    });
    const items = container.Metadata ?? [];
    // Use totalSize as the authoritative count. Do NOT fall back to container.size
    // (the current PAGE's item count, ≤ PLEX_PAGE_SIZE) — that makes `start < total`
    // false after one page and silently truncates any library larger than a page
    // when a Plex build omits totalSize. Infinity defers termination to the
    // empty-page break below, the correct terminator on that path.
    if (start === 0) total = container.totalSize ?? Infinity;
    const stop = processItems(items) === true;
    start += items.length;
    if (stop || items.length === 0) break;
  }
}

function plexFetch(url: string, token: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  return safeFetchAdminConfigured(url, {
    headers: plexServerHeaders(token),
    timeoutMs,
    maxResponseBytes: LIBRARY_FETCH_MAX_BYTES,
  });
}

// Plex exposes two GUID shapes: modern items use the Guid[] array; older library agents use a single guid string.
// Returns EVERY tmdb id on the item — a merged show carries one per merged entry, and both the availability
// and the episode-cache paths must agree on the full set (a first-match-only twin left merged ids episode-less).
function extractAllTmdbIds(item: PlexMetadataItem): number[] {
  const ids: number[] = [];
  if (item.Guid) {
    for (const g of item.Guid) {
      if (g.id.startsWith("tmdb://")) {
        const n = parseInt(g.id.slice(7), 10);
        if (!isNaN(n)) ids.push(n);
      }
    }
  }
  if (ids.length === 0 && item.guid) {
    const m = item.guid.match(/themoviedb:\/\/(\d+)/);
    if (m) ids.push(parseInt(m[1], 10));
  }
  return ids;
}

// Legacy-agent items whose guid scheme carries NO tmdb id at all:
// com.plexapp.agents.thetvdb://<id> (the pre-2020 default TV agent) and
// com.plexapp.agents.imdb://tt<id> (the pre-2020 movie agent). These items were
// entirely invisible to availability and the episode cache. The library walk
// collects them as a secondary channel for the SYNC layer to batch-resolve to
// tmdb ids via TMDB /find (best-effort — plex.ts itself stays DB-free).
export interface PlexLegacyGuidRef {
  ratingKey: string;
  tvdbId?: number;
  imdbId?: string;
  data: PlexLibraryItemData;
}

function extractLegacyExternalId(item: PlexMetadataItem): { tvdbId?: number; imdbId?: string } | null {
  // Only the legacy single-guid string — a modern Guid[] array without a tmdb
  // entry stays excluded (that exclusion is pinned deliberate in tests/plex).
  if (item.Guid?.length || !item.guid) return null;
  const tv = item.guid.match(/thetvdb:\/\/(\d+)/);
  if (tv) {
    const n = parseInt(tv[1], 10);
    if (!isNaN(n)) return { tvdbId: n };
  }
  const im = item.guid.match(/imdb:\/\/(tt\d+)/);
  if (im) return { imdbId: im[1] };
  return null;
}

export async function getPlexLibrarySections(
  serverUrl: string,
  token: string,
): Promise<PlexSection[]> {
  const data = await withPlexRetry("/library/sections", async () => {
    const res = await plexFetch(`${serverUrl}/library/sections`, token);
    if (!res.ok) throw tagNoRetryOn4xx(new Error(`Plex sections: ${res.status}`), res.status);
    return await res.json() as {
      MediaContainer: { Directory?: Array<{ key: string; title: string; type: string }> };
    };
  });
  return (data.MediaContainer.Directory ?? [])
    .filter((d) => d.type === "movie" || d.type === "show")
    .map((d) => ({ key: d.key, title: d.title, type: d.type as "movie" | "show" }));
}

export async function refreshPlexSection(
  serverUrl: string,
  token: string,
  sectionKey: string,
): Promise<void> {
  const res = await plexFetch(`${serverUrl}/library/sections/${sectionKey}/refresh`, token);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Plex section=${sectionKey} refresh status=${res.status}${body ? ` body=${body.slice(0, 200)}` : ""}`,
    );
  }
}

export interface PlexLibraryItemData {
  filePath:      string | null;
  ratingKey:     string | null;
  title:         string | null;
  year:          string | null;
  overview:      string | null;
  contentRating: string | null;
  addedAt:       Date | null;
}

export async function getPlexSectionTmdbIds(
  serverUrl: string,
  token: string,
  sectionKey: string,
  sectionType: "movie" | "show",
  recentOnly: boolean,
  // Accumulates every show's ratingKey → tmdb ids across sections so the
  // episode walk can reuse this type=2 listing instead of re-paging it.
  // Accumulated HERE (per section, where each section's rows still exist)
  // rather than inverted from the merged map — the merge keeps only the
  // first-seen entry per tmdbId, which would drop a duplicated show's second
  // ratingKey and lose that copy's exclusive episodes.
  ratingKeyToTmdbOut?: Map<string, number[]>,
  // Secondary channel for legacy-agent items with no tmdb id (see
  // PlexLegacyGuidRef). Keyed by ratingKey.
  legacyOut?: Map<string, PlexLegacyGuidRef>,
  // Full-sync callers whose flow ALWAYS runs the type=4 episode walk next set
  // this to skip the one-allLeaves-request-per-show filePath probe here — the
  // episode listing already carries the same file paths (captured via
  // getPlexTVEpisodes' episodeFilePathsOut) and the caller patches them onto
  // the rows post-write. recentOnly and walk-less callers keep the probe.
  skipShowFilePaths?: boolean,
  // recentOnly window cutoff (epoch seconds). /recentlyAdded is addedAt-desc,
  // so once an ENTIRE page predates this the walk stops — without it the
  // "incremental" sync paged the whole section every run. Trade, stated
  // plainly: the unbounded walk incidentally backfilled arbitrarily old gaps;
  // the windowed walk does not (Jellyfin's MinDateLastSaved already accepts
  // this — a full Resync covers backfill).
  recentSinceEpochSec?: number,
): Promise<Map<number, PlexLibraryItemData>> {
  const plexType = sectionType === "movie" ? 1 : 2;
  const path = recentOnly
    ? `/library/sections/${sectionKey}/recentlyAdded`
    : `/library/sections/${sectionKey}/all`;
  const baseUrl = `${serverUrl}${path}?type=${plexType}&includeGuids=1`;
  const items = new Map<number, PlexLibraryItemData>();
  await plexFetchAllPages<PlexMetadataItem>(baseUrl, token, (batch) => {
    for (const item of batch) {
      if (item.type === "collection") continue;
      const ids = extractAllTmdbIds(item);
      const entry: PlexLibraryItemData = {
        filePath:      item.Media?.[0]?.Part?.[0]?.file ?? null,
        ratingKey:     item.ratingKey ?? null,
        title:         item.title ?? null,
        year:          item.year != null ? String(item.year) : null,
        overview:      item.summary ?? null,
        contentRating: item.contentRating ?? null,
        addedAt:       item.addedAt != null ? new Date(item.addedAt * 1000) : null,
      };
      if (ids.length === 0) {
        if (legacyOut && item.ratingKey) {
          const legacy = extractLegacyExternalId(item);
          if (legacy) legacyOut.set(item.ratingKey, { ratingKey: item.ratingKey, ...legacy, data: entry });
        }
        continue;
      }
      if (sectionType === "show" && ratingKeyToTmdbOut && item.ratingKey) {
        ratingKeyToTmdbOut.set(item.ratingKey, ids);
      }
      for (const id of ids) items.set(id, entry);
    }
    // recentOnly early stop: every item on this page is KNOWN older than the
    // window (an unknown addedAt keeps paging — age can't be assumed).
    if (
      recentSinceEpochSec !== undefined &&
      batch.length > 0 &&
      batch.every((i) => i.addedAt != null && i.addedAt < recentSinceEpochSec)
    ) {
      return true;
    }
  });

  if (sectionType === "show" && !skipShowFilePaths) {
    // TV show items from /all don't include episode file paths; fetch one episode leaf per show to get a real path
    const ratingKeys = new Set<string>();
    for (const entry of items.values()) {
      if (entry.ratingKey) ratingKeys.add(entry.ratingKey);
    }

    const ratingKeyFilePaths = new Map<string, string>();
    const showEntries = Array.from(ratingKeys);
    const BATCH_SIZE = 10;
    for (let i = 0; i < showEntries.length; i += BATCH_SIZE) {
      await Promise.all(showEntries.slice(i, i + BATCH_SIZE).map(async (ratingKey) => {
        try {
          const res = await plexFetch(
            `${serverUrl}/library/metadata/${ratingKey}/allLeaves?X-Plex-Container-Start=0&X-Plex-Container-Size=1`,
            token,
          );
          if (!res.ok) return;
          const data = await res.json() as {
            MediaContainer: { Metadata?: Array<{ Media?: Array<{ Part?: Array<{ file?: string }> }> }> };
          };
          const file = data.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.file;
          if (file) ratingKeyFilePaths.set(ratingKey, file);
        } catch { }
      }));
    }

    for (const [tmdbId, entry] of items) {
      if (entry.ratingKey && ratingKeyFilePaths.has(entry.ratingKey)) {
        items.set(tmdbId, { ...entry, filePath: ratingKeyFilePaths.get(entry.ratingKey)! });
      }
    }
  }

  return items;
}

export async function getPlexTmdbIds(
  serverUrl: string,
  token: string,
  mediaType: "MOVIE" | "TV",
  recentOnly = false,
  selectedKeys?: Set<string>,
  sections?: PlexSection[],
  ratingKeyToTmdbOut?: Map<string, number[]>,
  legacyOut?: Map<string, PlexLegacyGuidRef>,
  skipShowFilePaths?: boolean,
  recentSinceEpochSec?: number,
): Promise<Map<number, PlexLibraryItemData>> {
  const sectionType = mediaType === "MOVIE" ? "movie" : "show";
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token);
  const matching = allSections.filter((s) => s.type === sectionType && (!selectedKeys?.size || selectedKeys.has(s.key)));
  const results = await Promise.all(
    matching.map((s) => getPlexSectionTmdbIds(serverUrl, token, s.key, sectionType, recentOnly, ratingKeyToTmdbOut, legacyOut, skipShowFilePaths, recentSinceEpochSec))
  );
  const combined = new Map<number, PlexLibraryItemData>();
  for (const map of results) {
    for (const [id, data] of map) {
      if (combined.has(id)) {
        // A TMDB ID appearing in multiple sections (e.g. duplicated libraries) keeps the first-seen entry
      } else {
        combined.set(id, data);
      }
    }
  }
  return combined;
}

interface PlexShowMeta extends PlexMetadataItem {
  ratingKey: string;
}

interface PlexEpisodeMeta {
  grandparentRatingKey: string;
  parentIndex: number;
  index: number;
  // Present on the type=4 section listing — the same file attribute the movie
  // branch reads from /all at type=1. Consumed only when the caller asked for
  // episode file paths (episodeFilePathsOut).
  Media?: Array<{ Part?: Array<{ file?: string }> }>;
}

export interface PlexTVEpisodeData {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
}

export async function getPlexTVEpisodes(
  serverUrl: string,
  token: string,
  selectedKeys?: Set<string>,
  sections?: PlexSection[],
  // The ratingKey → tmdb ids map accumulated by getPlexTmdbIds' type=2 walk in
  // the SAME sync run. When provided, the per-section type=2 re-walk below is
  // skipped — the full sync used to page every show section twice for the
  // identical listing. ratingKeys are server-local: only pass a map built
  // against the same serverUrl/instance.
  precomputedRatingKeyToTmdb?: Map<string, number[]>,
  // Captures the first episode file path per show (grandparentRatingKey) from
  // the type=4 listing — the same data the per-show allLeaves probe fetched
  // one HTTP request at a time. Full-sync callers pass this together with
  // getPlexTmdbIds' skipShowFilePaths and patch the paths onto the library
  // rows after the write.
  episodeFilePathsOut?: Map<string, string>,
): Promise<PlexTVEpisodeData[]> {
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token);
  const showSections = allSections.filter(
    (s) => s.type === "show" && (!selectedKeys?.size || selectedKeys.has(s.key))
  );

  const sectionResults = await Promise.all(showSections.map(async (section) => {
    // Multi-valued to match the availability path (getPlexSectionTmdbIds uses extractAllTmdbIds):
    // a Plex-merged show carries several tmdb:// GUIDs, and taking only the first one marked the
    // other id "available" at show level while its TVEpisodeCache stayed empty — every season/episode
    // rendered missing and users re-requested content already on disk.
    let ratingKeyToTmdb = precomputedRatingKeyToTmdb;
    if (!ratingKeyToTmdb) {
      const walked = new Map<string, number[]>();
      await plexFetchAllPages<PlexShowMeta>(
        `${serverUrl}/library/sections/${section.key}/all?type=2&includeGuids=1`,
        token,
        (batch) => {
          for (const show of batch) {
            const tmdbIds = extractAllTmdbIds(show);
            if (tmdbIds.length > 0) walked.set(show.ratingKey, tmdbIds);
          }
        },
      );
      ratingKeyToTmdb = walked;
    }

    if (ratingKeyToTmdb.size === 0) return [] as PlexTVEpisodeData[];

    const episodes: PlexTVEpisodeData[] = [];
    await plexFetchAllPages<PlexEpisodeMeta>(
      `${serverUrl}/library/sections/${section.key}/all?type=4`,
      token,
      (batch) => {
        for (const ep of batch) {
          const tmdbIds = ratingKeyToTmdb.get(ep.grandparentRatingKey);
          if (!tmdbIds) continue;
          // First-wins per show; captured even for episodes the index filters
          // below skip (a specials-only file is still a real path).
          if (episodeFilePathsOut && !episodeFilePathsOut.has(ep.grandparentRatingKey)) {
            const file = ep.Media?.[0]?.Part?.[0]?.file;
            if (file) episodeFilePathsOut.set(ep.grandparentRatingKey, file);
          }
          if (!Number.isInteger(ep.parentIndex) || ep.parentIndex < 1) continue;
          if (!Number.isInteger(ep.index) || ep.index < 1) continue;
          for (const tmdbId of tmdbIds) {
            episodes.push({ tmdbId, seasonNumber: ep.parentIndex, episodeNumber: ep.index });
          }
        }
      },
    );

    return episodes;
  }));

  const episodeMap = new Map<string, PlexTVEpisodeData>();
  for (const ep of sectionResults.flat()) {
    const key = `${ep.tmdbId}-${ep.seasonNumber}-${ep.episodeNumber}`;
    if (!episodeMap.has(key)) episodeMap.set(key, ep);
  }
  return Array.from(episodeMap.values());
}

export async function getPlexEpisodesForShow(
  serverUrl: string,
  token: string,
  ratingKey: string,
  tmdbId: number,
): Promise<PlexTVEpisodeData[]> {
  const episodes: PlexTVEpisodeData[] = [];
  await plexFetchAllPages<PlexEpisodeMeta>(
    `${serverUrl}/library/metadata/${ratingKey}/allLeaves`,
    token,
    (batch) => {
      for (const ep of batch) {
        if (!Number.isInteger(ep.parentIndex) || ep.parentIndex < 1) continue;
        if (!Number.isInteger(ep.index) || ep.index < 1) continue;
        episodes.push({ tmdbId, seasonNumber: ep.parentIndex, episodeNumber: ep.index });
      }
    },
  );
  return episodes;
}

export interface PlexSessionData {
  sessionKey: string;
  // Session.id — the long GUID Plex assigns per playback. Distinct from the
  // short sessionKey; the /status/sessions/terminate endpoint addresses
  // sessions by this GUID, not the sessionKey.
  sessionId?: string;
  state: "playing" | "paused" | "buffering";
  accountId: string;
  accountName: string;
  accountThumb: string;
  ratingKey: string;
  grandparentRatingKey?: string;
  title: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  type: string;
  year?: string;
  duration: number;
  viewOffset: number;
  Guid?: PlexGuid[];
  platform?: string;
  player?: string;
  device?: string;
  address?: string;
  // Server-observed public address of the client's connection — Player.address
  // is the client's SELF-reported address, which for WAN sessions is routinely
  // a private/loopback value. Relayed sessions report 127.0.0.1 here (the
  // local relay endpoint), so consumers must treat loopback as "no value".
  remotePublicAddress?: string;
  playMethod?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  bitrate?: number;
  videoDecision?: string;
  audioDecision?: string;
  container?: string;
  transcodeReason?: string;
  // Network metadata. Session sub-object provides bandwidth (kbps) and
  // location ("lan" | "wan" | "relay"); Player sub-object exposes secure
  // ("0"/"1") and relayed ("0"/"1") to describe the client's connection.
  location?: "lan" | "wan" | "relay";
  bandwidth?: number;
  secure?: boolean;
  relayed?: boolean;
}

interface PlexSessionRaw {
  sessionKey?: string;
  Player?: {
    state?: string;
    title?: string;
    device?: string;
    product?: string;
    platform?: string;
    machineIdentifier?: string;
    address?: string;
    secure?: string | boolean;
    relayed?: string | boolean;
    remotePublicAddress?: string;
  };
  User?: { id?: string; title?: string; thumb?: string };
  ratingKey?: string;
  grandparentRatingKey?: string;
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  type?: string;
  year?: number;
  duration?: number;
  viewOffset?: number;
  Guid?: PlexGuid[];
  // `selected` marks which Media version / Part / Stream is ACTUALLY playing —
  // /status/sessions lists every version of a multi-version item and every
  // stream of the playing part. "0"/"1" strings on most clients, booleans on
  // some newer builds (same duality as Player.secure/relayed).
  Media?: Array<{
    container?: string;
    bitrate?: number;
    videoResolution?: string;
    selected?: string | boolean;
    Part?: Array<{
      file?: string;
      selected?: string | boolean;
      Stream?: Array<{ streamType?: number; codec?: string; decision?: string; selected?: string | boolean }>;
    }>;
  }>;
  Session?: { id?: string; bandwidth?: number; location?: string };
  TranscodeSession?: {
    videoDecision?: string;
    audioDecision?: string;
    transcodeHwRequested?: boolean;
  };
}

// Plex encodes several Player/Media flags as "0"/"1" strings on most clients
// but some newer Plex builds emit booleans. Normalize both forms.
function toBool(v: string | boolean | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

// Derive a recognizable client/device name for the activity "Device" label and
// top-devices stats. Player.product is the canonical Plex client name ("Plex for
// Apple TV", "Plex for Roku", "Plex Web"); stripping the "Plex for "/"Plex "
// prefix yields the friendly form the user expects ("Apple TV", "Roku", "Web").
// Fall back to the device attribute, then the client title — never the
// machineIdentifier GUID.
function friendlyPlexDevice(
  player?: { product?: string; device?: string; title?: string },
): string | undefined {
  const product = player?.product?.trim();
  if (product) {
    const stripped = product.replace(/^Plex for /i, "").replace(/^Plex /i, "").trim();
    return stripped.length > 0 ? stripped : product;
  }
  return player?.device ?? player?.title ?? undefined;
}

export async function getPlexSessions(serverUrl: string, token: string): Promise<PlexSessionData[]> {
  const res = await plexFetch(`${serverUrl}/status/sessions?includeGuids=1`, token);
  if (!res.ok) throw new Error(`Plex sessions: ${res.status}`);
  const data = await res.json() as { MediaContainer: { Metadata?: PlexSessionRaw[] } };
  const raw = data.MediaContainer.Metadata ?? [];

  return raw.map((s): PlexSessionData => {
    // Prefer the `selected` Media/Part/Stream — a multi-version item (1080p +
    // 4K files, multiple audio tracks) lists ALL of them and [0]/first-of-type
    // is routinely the wrong one; PMS marks what is actually playing. Fixtures
    // without the attribute fall back to the old first-entry behavior.
    const media = s.Media?.find((m) => toBool(m.selected)) ?? s.Media?.[0];
    const part = media?.Part?.find((p) => toBool(p.selected)) ?? media?.Part?.[0];
    const streamOfType = (streamType: number) =>
      part?.Stream?.find((st) => st.streamType === streamType && toBool(st.selected)) ??
      part?.Stream?.find((st) => st.streamType === streamType);
    const videoStream = streamOfType(1);
    const audioStream = streamOfType(2);
    const subtitleStream = streamOfType(3);
    const ts = s.TranscodeSession;

    let playMethod = "DirectPlay";
    if (ts?.videoDecision === "transcode" || ts?.audioDecision === "transcode") {
      playMethod = "Transcode";
    } else if (ts?.videoDecision === "copy" || ts?.audioDecision === "copy") {
      playMethod = "DirectStream";
    }

    // Plex's /status/sessions has no single "reason" field — derive it from the
    // per-stream decisions. Worded to match the humanized Jellyfin
    // TranscodeReasons vocabulary so both servers share one chart.
    let transcodeReason: string | undefined;
    if (playMethod === "Transcode") {
      const reasons: string[] = [];
      if (ts?.videoDecision === "transcode") reasons.push("Video codec not supported");
      if (ts?.audioDecision === "transcode") reasons.push("Audio codec not supported");
      if (subtitleStream?.decision === "burn") reasons.push("Subtitle burn-in");
      if (reasons.length === 0) reasons.push("Container not supported");
      transcodeReason = reasons.join(", ");
    }

    const rawLocation = s.Session?.location;
    const location: "lan" | "wan" | "relay" | undefined =
      rawLocation === "lan" || rawLocation === "wan" || rawLocation === "relay"
        ? rawLocation
        : undefined;

    return {
      sessionKey: s.sessionKey ?? s.Session?.id ?? "",
      sessionId: s.Session?.id,
      state: (s.Player?.state === "paused" ? "paused" : s.Player?.state === "buffering" ? "buffering" : "playing"),
      accountId: String(s.User?.id ?? ""),
      accountName: s.User?.title ?? "",
      accountThumb: s.User?.thumb ?? "",
      ratingKey: s.ratingKey ?? "",
      grandparentRatingKey: s.grandparentRatingKey,
      title: s.type === "episode"
        ? `${s.grandparentTitle ?? ""} — ${s.title ?? ""}`
        : s.title ?? "",
      grandparentTitle: s.grandparentTitle,
      parentIndex: s.parentIndex,
      index: s.index,
      type: s.type ?? "movie",
      year: s.year != null ? String(s.year) : undefined,
      // Coerced to safe non-negative integers at the source: BigInt() throws a
      // RangeError on a fractional value, and the poller converts both fields
      // inside a per-instance Promise.all — one malformed session would reject
      // the whole batch and starve that instance's absence sweep every tick.
      // (The SSE writer floors the same fields in applyLiveStateUpdate.)
      duration: Number.isFinite(s.duration) && (s.duration as number) > 0 ? Math.floor(s.duration as number) : 0,
      viewOffset: Number.isFinite(s.viewOffset) && (s.viewOffset as number) > 0 ? Math.floor(s.viewOffset as number) : 0,
      Guid: s.Guid,
      platform: s.Player?.platform,
      player: s.Player?.title,
      device: friendlyPlexDevice(s.Player),
      address: s.Player?.address,
      remotePublicAddress: s.Player?.remotePublicAddress,
      playMethod,
      videoCodec: videoStream?.codec ?? undefined,
      audioCodec: audioStream?.codec ?? undefined,
      resolution: media?.videoResolution ?? undefined,
      bitrate: media?.bitrate ?? undefined,
      videoDecision: ts?.videoDecision ?? videoStream?.decision ?? undefined,
      audioDecision: ts?.audioDecision ?? audioStream?.decision ?? undefined,
      container: media?.container ?? undefined,
      transcodeReason,
      location,
      bandwidth: typeof s.Session?.bandwidth === "number" ? s.Session.bandwidth : undefined,
      secure: toBool(s.Player?.secure),
      relayed: toBool(s.Player?.relayed),
    };
  });
}

// Plex /library/metadata/{ratingKey}?includeMarkers=1 returns intro and credits
// markers as Marker[] entries on the metadata item. Used at session start to
// stamp marker offsets onto ActiveSession so finalize can credit watched at the
// credits boundary without a second metadata fetch at stop time.
export interface PlexMarkers {
  introStartMs?: number;
  introEndMs?: number;
  creditsStartMs?: number;
  creditsEndMs?: number;
}

interface PlexMarkerRaw {
  type?: string; // "intro" | "credits"
  final?: boolean; // credits markers can be split into mid/final — only `final: true` is the actual end-credits roll
  startTimeOffset?: number;
  endTimeOffset?: number;
}

interface PlexMetadataWithMarkersRaw extends PlexMetadataItem {
  Marker?: PlexMarkerRaw[];
}

export async function getPlexMarkers(
  serverUrl: string,
  token: string,
  ratingKey: string,
): Promise<PlexMarkers> {
  try {
    const res = await plexFetch(
      `${serverUrl}/library/metadata/${encodeURIComponent(ratingKey)}?includeMarkers=1`,
      token,
    );
    if (!res.ok) return {};
    const data = await res.json() as { MediaContainer?: { Metadata?: PlexMetadataWithMarkersRaw[] } };
    const markers = data.MediaContainer?.Metadata?.[0]?.Marker ?? [];
    const result: PlexMarkers = {};
    for (const m of markers) {
      if (m.type === "intro") {
        if (typeof m.startTimeOffset === "number") result.introStartMs = m.startTimeOffset;
        if (typeof m.endTimeOffset === "number") result.introEndMs = m.endTimeOffset;
      } else if (m.type === "credits") {
        // Plex emits two credit markers on shows with mid-credit scenes:
        // a non-final block for the credits scroll and a `final: true` block
        // for the absolute end. Prefer the earliest startTimeOffset (the
        // start of the credits roll) and the latest endTimeOffset.
        if (typeof m.startTimeOffset === "number") {
          result.creditsStartMs = result.creditsStartMs == null
            ? m.startTimeOffset
            : Math.min(result.creditsStartMs, m.startTimeOffset);
        }
        if (typeof m.endTimeOffset === "number") {
          result.creditsEndMs = result.creditsEndMs == null
            ? m.endTimeOffset
            : Math.max(result.creditsEndMs, m.endTimeOffset);
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Plex admin endpoint to terminate an in-progress playback. `reason` is shown
// to the user in their player as the stop dialog text. Returns true when Plex
// accepted the request (200 or 204); the actual session teardown is async and
// will surface as a state="stopped" SSE event within a second or two.
export async function terminatePlexSession(
  serverUrl: string,
  token: string,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; status: number }> {
  // `sessionId` MUST be the Session.id GUID, not the short sessionKey — Plex
  // matches /status/sessions/terminate against Session.id and 404s on the
  // short key. Same identifier Tautulli's pmsconnect uses (pmsconnect.py:108).
  const url = `${serverUrl}/status/sessions/terminate?sessionId=${encodeURIComponent(sessionId)}&reason=${encodeURIComponent(reason)}`;
  const res = await plexFetch(url, token);
  return { ok: res.ok, status: res.status };
}

export async function hasPlexItemByTmdbId(
  serverUrl: string,
  token: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
  sections?: PlexSection[],
): Promise<boolean> {
  const plexType = mediaType === "movie" ? 1 : 2;
  const sectionType = mediaType === "movie" ? "movie" : "show";
  const base = serverUrl.replace(/\/$/, "");
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token).catch(() => [] as PlexSection[]);
  const matching = allSections.filter((s) => s.type === sectionType);
  for (const section of matching) {
    try {
      const res = await plexFetch(
        `${base}/library/sections/${section.key}/all?type=${plexType}&includeGuids=1&guid=tmdb://${tmdbId}&X-Plex-Container-Start=0&X-Plex-Container-Size=1`,
        token,
      );
      if (!res.ok) continue;
      const data = await res.json() as { MediaContainer: { totalSize?: number; size?: number } };
      if ((data.MediaContainer.totalSize ?? data.MediaContainer.size ?? 0) > 0) return true;
    } catch { }
  }
  return false;
}

export function extractTmdbIdFromGuids(guids?: PlexGuid[]): number | null {
  if (!guids) return null;
  for (const g of guids) {
    if (g.id.startsWith("tmdb://")) {
      const n = parseInt(g.id.slice(7), 10);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

export interface PlexAccountInfo {
  id: string;
  name: string;
  email: string;
  thumb: string;
  isAdmin: boolean;
}

export interface PlexAccountsResult {
  accounts: PlexAccountInfo[];
  /** The owner hop (/api/v2/user) succeeded. */
  ownerOk: boolean;
  /** The friends hop (/api/users) succeeded — false on a throw OR a non-2xx. */
  friendsOk: boolean;
}

/**
 * Account list plus per-hop status.
 *
 * Both hops are swallowed independently below, so a bare array cannot express
 * "the owner came back but the friends list failed" — that is indistinguishable
 * from "this admin genuinely has no shared users". The one-shot Plex user
 * backfill needs the difference: it stamps a never-retry marker, and stamping it
 * on a half-fetched list strands every user who only appears in the missing half.
 */
export async function getPlexAccountsDetailed(
  serverUrl: string,
  adminToken: string,
): Promise<PlexAccountsResult> {
  const accounts: PlexAccountInfo[] = [];
  let ownerOk = false;
  let friendsOk = false;

  try {
    // The server owner doesn't appear in the shared-users list — fetch separately and use the real
    // Plex account id as the provider-subject. A synthetic id would later get bound to User.plexUserId
    // by the backfill and break (provider, sub)-keyed sign-in for the owner.
    const owner = await getPlexUser(adminToken);
    accounts.push({ id: owner.id, name: owner.username, email: owner.email, thumb: owner.thumb, isAdmin: true });
    ownerOk = true;
  } catch (err) {
    console.warn("[plex] Failed to fetch server owner info:", err instanceof Error ? err.message : String(err));
  }

  try {
    // plex.tv/api/users returns XML (not JSON) — the v2 JSON endpoint doesn't expose the full friend list
    const res = await safeFetchTrusted("https://plex.tv/api/users", {
      allowedHosts: PLEX_TV_HOSTS,
      headers: { "X-Plex-Client-Identifier": PLEX_CLIENT_ID, "X-Plex-Token": adminToken },
      timeoutMs: 15_000,
    });
    if (res.ok) {
      friendsOk = true;
      const xml = await res.text();
      const userBlocks = xml.split(/<User\b/).slice(1);
      for (const block of userBlocks) {
        const idMatch = block.match(/\bid="(\d+)"/);
        const nameMatch = block.match(/\btitle="([^"]+)"/);
        const emailMatch = block.match(/\bemail="([^"]+)"/);
        const thumbMatch = block.match(/\bthumb="([^"]+)"/);
        if (idMatch && nameMatch) {
          accounts.push({
            id: idMatch[1],
            name: nameMatch[1],
            email: emailMatch?.[1]?.toLowerCase() ?? "",
            thumb: thumbMatch?.[1] ?? "",
            isAdmin: false,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[plex] Failed to fetch shared users:", err instanceof Error ? err.message : String(err));
  }

  return { accounts, ownerOk, friendsOk };
}

// Back-compat array form. Callers that only need the list (the settings-page
// share count) keep using this; only the backfill needs the per-hop status.
export async function getPlexAccounts(
  serverUrl: string,
  adminToken: string,
): Promise<PlexAccountInfo[]> {
  return (await getPlexAccountsDetailed(serverUrl, adminToken)).accounts;
}

// Reads the server's machineIdentifier. Swallows every error and returns null —
// callers treat null as "could not reach / could not identify this server".
// timeoutMs defaults to the library-walk timeout for back-compat; pass
// PLEX_IDENTITY_TIMEOUT_MS from any path that iterates instances sequentially.
export async function getPlexMachineId(
  serverUrl: string,
  adminToken: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await plexFetch(`${serverUrl}/identity`, adminToken, timeoutMs);
    if (!res.ok) return null;
    const data = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    return data.MediaContainer?.machineIdentifier ?? null;
  } catch {
    return null;
  }
}

// Members of THIS server: the plex.tv account ids (immutable, the same
// namespace sign-in binds to User.plexUserId) plus the emails (mutable — a
// user changing their plex.tv email used to fall out of the allowlist and get
// every device revoked mid-session). Consumers match id-first, email-fallback.
export interface PlexServerMembers {
  ids: Set<string>;
  emails: Set<string>;
}

// Connection-test probe: does THIS token actually have ACCESS to THIS server?
// /identity answers without authorization on PMS, so a token valid at plex.tv
// but never shared this server still read "Connected". /library/sections
// requires authorization — 401/403 is the discriminated no-access answer.
export async function checkPlexServerAccess(
  serverUrl: string,
  token: string,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  try {
    const res = await plexFetch(`${serverUrl.replace(/\/$/, "")}/library/sections`, token, PLEX_IDENTITY_TIMEOUT_MS);
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function getPlexFriendEmails(adminToken: string, serverUrl?: string): Promise<PlexServerMembers> {
  // Defense-in-depth: this set decides who is allowed to sign in via Plex, so it
  // MUST be scoped to friends of *this* server (matched by machineIdentifier
  // below). The caller (auth.ts) already gates on serverUrl, but if a future
  // refactor ever let a missing serverUrl through, the function would otherwise
  // fall back to enumerating every account the admin has friended on ANY Plex
  // server — granting sign-in to people who share no library with this instance,
  // an account-takeover / unauthorized-access hole. Refuse loudly instead of
  // returning an over-broad allowlist.
  if (!serverUrl) {
    console.warn("[plex] getPlexFriendEmails called without serverUrl; refusing to enumerate friends.");
    return { ids: new Set<string>(), emails: new Set<string>() };
  }
  // Short timeout: this runs once per configured instance inside a SEQUENTIAL
  // loop on the Plex sign-in path, and is followed by a 15s plex.tv fetch — at
  // the 60s default a single dead server stalls sign-in for ~75s.
  const machineId = await getPlexMachineId(serverUrl, adminToken, PLEX_IDENTITY_TIMEOUT_MS);
  if (!machineId) {
    console.warn("[plex] getPlexFriendEmails: unable to resolve machineId for server; refusing.");
    return { ids: new Set<string>(), emails: new Set<string>() };
  }

  const res = await safeFetchTrusted("https://plex.tv/api/users", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: { "X-Plex-Client-Identifier": PLEX_CLIENT_ID, "X-Plex-Token": adminToken },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch Plex users: ${res.status}`);
  const xml = await res.text();

  const ids = new Set<string>();
  const emails = new Set<string>();
  const userBlocks = xml.split(/<User\b/).slice(1);
  for (const block of userBlocks) {
    const hasServer = block.includes(`machineIdentifier="${machineId}"`);
    if (!hasServer) continue;

    // The id attribute is the plex.tv account id — the same value getPlexUser
    // returns and sign-in pins to User.plexUserId (Tautulli parses the same
    // attribute as user_id). Capture it even when the email is absent/invalid.
    const idMatch = block.match(/\bid="(\d+)"/);
    if (idMatch) ids.add(idMatch[1]);

    const emailMatch = block.match(/\bemail="([^"]+)"/);
    if (!emailMatch) continue;
    const email = emailMatch[1].toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emails.add(email);
    }
  }
  return { ids, emails };
}
