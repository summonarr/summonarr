import { safeFetchAdminConfigured } from "./safe-fetch";

export interface JellyfinUser {
  id: string;
  name: string;
}

const FETCH_TIMEOUT_MS = 30_000;

export async function authenticateWithJellyfin(
  baseUrl: string,
  username: string,
  password: string
): Promise<JellyfinUser> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await safeFetchAdminConfigured(`${url}/Users/AuthenticateByName`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: {
      "X-Emby-Authorization":
        'MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0"',
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });

  if (!res.ok) {
    console.error(`[jellyfin auth] ${res.status} from ${url}/Users/AuthenticateByName`);
    throw new Error(`Jellyfin auth failed: ${res.status}`);
  }

  const data = await res.json();
  const user = data?.User;
  if (!user || typeof user.Id !== "string" || typeof user.Name !== "string") {
    throw new Error("Jellyfin auth response missing User.Id or User.Name");
  }
  return { id: user.Id, name: user.Name };
}

export interface JellyfinQuickConnectResult {
  secret: string;
  code: string;
}

const QC_AUTH_HEADER = 'MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0"';

export async function initiateJellyfinQuickConnect(baseUrl: string): Promise<JellyfinQuickConnectResult> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await safeFetchAdminConfigured(`${url}/QuickConnect/Initiate`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "X-Emby-Authorization": QC_AUTH_HEADER, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Jellyfin QuickConnect initiate: ${res.status}`);
  const data = (await res.json()) as { Secret: string; Code: string };
  return { secret: data.Secret, code: data.Code };
}

export async function pollJellyfinQuickConnect(baseUrl: string, secret: string): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await safeFetchAdminConfigured(`${url}/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "X-Emby-Authorization": QC_AUTH_HEADER },
  });
  if (!res.ok) throw new Error(`Jellyfin QuickConnect poll: ${res.status}`);
  const data = (await res.json()) as { Authenticated: boolean };
  return data.Authenticated;
}

export async function authenticateWithJellyfinQuickConnect(baseUrl: string, secret: string): Promise<JellyfinUser> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await safeFetchAdminConfigured(`${url}/Users/AuthenticateWithQuickConnect`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "X-Emby-Authorization": QC_AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ Secret: secret }),
  });
  if (!res.ok) throw new Error(`Jellyfin QuickConnect auth: ${res.status}`);
  const data = await res.json();
  const user = data?.User;
  if (!user || typeof user.Id !== "string" || typeof user.Name !== "string") {
    throw new Error("Jellyfin QuickConnect auth response missing User.Id or User.Name");
  }
  return { id: user.Id, name: user.Name };
}

export async function getJellyfinUserEmail(
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/Users/${encodeURIComponent(userId)}`;
  try {
    const res = await safeFetchAdminConfigured(url, {
      headers: {
        "X-MediaBrowser-Token": apiKey,
        "Content-Type": "application/json",
        "User-Agent": "Summonarr/1.0 (Node.js)",
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const email = typeof data.Email === "string" && data.Email.includes("@") ? data.Email : null;
    return email;
  } catch {
    return null;
  }
}

function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

// GET /Users and POST /Users/{id}/Policy require RequiresElevation in Jellyfin.
// X-MediaBrowser-Token alone does not satisfy the elevation check in newer versions;
// the full Authorization: MediaBrowser ... header is required to establish admin context.
function jellyfinAdminHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0", Token="${apiKey}"`,
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

interface JellyfinItem {
  Id?:              string;
  ProviderIds?:     Record<string, string>;
  Path?:            string;
  Name?:            string;
  ProductionYear?:  number;
  Overview?:        string;
  OfficialRating?:  string;
  CommunityRating?: number;
  DateCreated?:     string;
}

interface JellyfinItemsResponse {
  Items?:            JellyfinItem[];
  TotalRecordCount?: number;
}

export interface JellyfinMediaFolder {
  id: string;
  name: string;
  collectionType: string;
}

export async function hasJellyfinItemByTmdbId(
  baseUrl: string,
  apiKey: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<boolean> {
  const itemType = mediaType === "movie" ? "Movie" : "Series";
  const url = `${baseUrl.replace(/\/$/, "")}/Items?AnyProviderIdEquals=Tmdb.${tmdbId}&IncludeItemTypes=${itemType}&Recursive=true&Limit=1`;
  try {
    const res = await safeFetchAdminConfigured(url, {
      headers: jellyfinHeaders(apiKey),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as JellyfinItemsResponse;
    return (data.TotalRecordCount ?? data.Items?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function getJellyfinMediaFolders(baseUrl: string, apiKey: string): Promise<JellyfinMediaFolder[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/Library/MediaFolders`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Jellyfin MediaFolders: ${res.status}`);
  const data = (await res.json()) as { Items?: { Id: string; Name: string; CollectionType?: string }[] };
  return (data.Items ?? [])
    .filter((f) => f.CollectionType === "movies" || f.CollectionType === "tvshows")
    .map((f) => ({ id: f.Id, name: f.Name, collectionType: f.CollectionType! }));
}

export async function refreshJellyfinLibrary(baseUrl: string, apiKey: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/Library/Refresh`;
  const res = await safeFetchAdminConfigured(url, {
    method: "POST",
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Jellyfin /Library/Refresh status=${res.status}${body ? ` body=${body.slice(0, 200)}` : ""}`,
    );
  }
}

export interface JellyfinLibraryItemData {
  filePath:       string | null;
  itemId:         string | null;
  title:          string | null;
  year:           string | null;
  overview:       string | null;
  contentRating:  string | null;
  communityRating: number | null;
  addedAt:        Date | null;
}

const LIBRARY_PAGE_SIZE   = 5_000;
// 60 s per page — Jellyfin can be slow on large libraries over slow connections
const PAGE_TIMEOUT_MS     = 60_000;
// Parallel pages are capped to avoid hammering small Jellyfin instances
const MAX_PARALLEL_PAGES  = 3;
const EPISODE_PAGE_SIZE   = 1_000;
const PAGE_RETRY_ATTEMPTS = 3;
const PAGE_RETRY_DELAY_MS = 2_000;

async function fetchPage<T>(
  baseQuery: string,
  apiKey: string,
  startIndex: number,
  limit: number,
  retries = PAGE_RETRY_ATTEMPTS,
): Promise<{ items: T[]; total: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, PAGE_RETRY_DELAY_MS * attempt));
      console.warn(`[jellyfin] retry ${attempt}/${retries} for StartIndex=${startIndex}`);
    }
    try {
      const res = await safeFetchAdminConfigured(`${baseQuery}&StartIndex=${startIndex}&Limit=${limit}`, {
        headers: jellyfinHeaders(apiKey),
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`Jellyfin fetch failed: ${res.status} at StartIndex=${startIndex}`);
      const data = (await res.json()) as { Items?: T[]; TotalRecordCount?: number };
      return { items: data.Items ?? [], total: data.TotalRecordCount ?? 0 };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchJellyfinPages<T>(
  baseQuery: string,
  apiKey: string,
  processItems: (items: T[]) => void,
  pageSize = LIBRARY_PAGE_SIZE,
  maxConcurrent = MAX_PARALLEL_PAGES,
): Promise<void> {
  const first = await fetchPage<T>(baseQuery, apiKey, 0, pageSize);
  processItems(first.items);

  const total = first.total;
  const startIndexes: number[] = [];
  for (let s = pageSize; s < total; s += pageSize) startIndexes.push(s);
  if (startIndexes.length === 0) return;

  for (let i = 0; i < startIndexes.length; i += maxConcurrent) {
    const batch = startIndexes.slice(i, i + maxConcurrent);
    const pages = await Promise.all(
      batch.map((s) => fetchPage<T>(baseQuery, apiKey, s, pageSize)),
    );
    for (const p of pages) processItems(p.items);
  }
}

// Episodes are fetched sequentially because episode counts per series are unpredictable and concurrent
// large episode requests can stall slow Jellyfin servers.
async function fetchJellyfinPagesSequential<T>(
  baseQuery: string,
  apiKey: string,
  processItems: (items: T[]) => void,
  pageSize = EPISODE_PAGE_SIZE,
): Promise<void> {
  let startIndex = 0;
  let total = Infinity;
  let pageNum = 0;

  while (startIndex < total) {
    const page = await fetchPage<T>(baseQuery, apiKey, startIndex, pageSize);
    if (pageNum === 0) {
      total = page.total;
    }
    processItems(page.items);
    startIndex += page.items.length;
    pageNum++;

    if (page.items.length === 0) break;
    if (page.items.length < pageSize) break;
  }
}

async function getJellyfinItemsByType(
  baseUrl: string,
  apiKey: string,
  itemType: "Movie" | "Series",
  libraryIds?: Set<string>,
  minDateLastSaved?: Date,
): Promise<Map<number, JellyfinLibraryItemData>> {
  const base = baseUrl.replace(/\/$/, "");
  const items = new Map<number, JellyfinLibraryItemData>();
  const dateFilter = minDateLastSaved
    ? `&MinDateLastSaved=${encodeURIComponent(minDateLastSaved.toISOString())}`
    : "";

  const processItems = (batch: JellyfinItem[]) => {
    for (const item of batch) {
      const tmdb = item.ProviderIds?.Tmdb ?? item.ProviderIds?.tmdb;
      if (tmdb) {
        const n = parseInt(tmdb, 10);
        if (!isNaN(n)) items.set(n, {
          filePath:        item.Path ?? null,
          itemId:          item.Id ?? null,
          title:           item.Name ?? null,
          year:            item.ProductionYear != null ? String(item.ProductionYear) : null,
          overview:        item.Overview ?? null,
          contentRating:   item.OfficialRating ?? null,
          communityRating: item.CommunityRating ?? null,
          addedAt:         item.DateCreated ? new Date(item.DateCreated) : null,
        });
      } else if (itemType === "Series") {
        // Series without a TMDB provider ID are intentionally skipped; episode lookups rely on the
        // itemId→tmdbId mapping built from this loop, so un-mapped series simply produce no episodes.
      }
    }
  };

  if (libraryIds?.size) {
    // Scoping queries to specific parent IDs is faster and avoids returning BoxSet children twice
    const LIBRARY_CONCURRENCY = 3;
    const ids = Array.from(libraryIds);
    for (let i = 0; i < ids.length; i += LIBRARY_CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + LIBRARY_CONCURRENCY).map((parentId) =>
          fetchJellyfinPages(
            `${base}/Items?ParentId=${parentId}&IncludeItemTypes=${itemType}&ExcludeItemTypes=BoxSet&Recursive=true&Fields=ProviderIds,Path,Name,ProductionYear,Overview,OfficialRating,CommunityRating,DateCreated${dateFilter}`,
            apiKey,
            processItems,
          )
        )
      );
    }
  } else {
    await fetchJellyfinPages(
      `${base}/Items?IncludeItemTypes=${itemType}&ExcludeItemTypes=BoxSet&Recursive=true&Fields=ProviderIds,Path,Name,ProductionYear,Overview,OfficialRating,CommunityRating,DateCreated${dateFilter}`,
      apiKey,
      processItems,
    );
  }

  return items;
}

export interface JellyfinTVEpisodeData {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
}

interface JellyfinEpisodeItem {
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
}

export async function getJellyfinTVEpisodes(
  baseUrl: string,
  apiKey: string,
  libraryIds?: Set<string>,
  seriesItemIdToTmdbId?: Map<string, number>,
): Promise<JellyfinTVEpisodeData[]> {
  const base = baseUrl.replace(/\/$/, "");

  let seriesMap: Map<string, number>;
  if (seriesItemIdToTmdbId) {
    seriesMap = seriesItemIdToTmdbId;
  } else {
    seriesMap = new Map();
    const seriesItems = await getJellyfinItemsByType(base, apiKey, "Series", libraryIds);
    for (const [tmdbId, data] of seriesItems) {
      if (data.itemId) seriesMap.set(data.itemId, tmdbId);
    }
  }

  if (seriesMap.size === 0) return [];

  const episodeMap = new Map<string, JellyfinTVEpisodeData>();
  const fields = "SeriesId,ParentIndexNumber,IndexNumber";

  const processEpisodes = (batch: JellyfinEpisodeItem[]) => {
    for (const ep of batch) {
      if (!ep.SeriesId) continue;
      const tmdbId = seriesMap.get(ep.SeriesId);
      if (tmdbId == null) continue;
      // Season 0 (specials) and negative indices are skipped — they don't map to TMDB episode numbers
      if (!Number.isInteger(ep.ParentIndexNumber) || (ep.ParentIndexNumber as number) < 1) continue;
      if (!Number.isInteger(ep.IndexNumber) || (ep.IndexNumber as number) < 1) continue;
      const key = `${tmdbId}-${ep.ParentIndexNumber}-${ep.IndexNumber}`;
      if (!episodeMap.has(key)) {
        episodeMap.set(key, {
          tmdbId,
          seasonNumber: ep.ParentIndexNumber as number,
          episodeNumber: ep.IndexNumber as number,
        });
      }
    }
  };

  if (libraryIds?.size) {
    for (const parentId of Array.from(libraryIds)) {
      await fetchJellyfinPagesSequential(
        `${base}/Items?ParentId=${parentId}&IncludeItemTypes=Episode&Recursive=true&Fields=${fields}`,
        apiKey,
        processEpisodes,
      );
    }
  } else {
    await fetchJellyfinPagesSequential(
      `${base}/Items?IncludeItemTypes=Episode&Recursive=true&Fields=${fields}`,
      apiKey,
      processEpisodes,
    );
  }

  return Array.from(episodeMap.values());
}

export async function getJellyfinEpisodesForShow(
  baseUrl: string,
  apiKey: string,
  seriesId: string,
  tmdbId: number,
): Promise<JellyfinTVEpisodeData[]> {
  const base = baseUrl.replace(/\/$/, "");
  const episodes: JellyfinTVEpisodeData[] = [];
  const fields = "ParentIndexNumber,IndexNumber";
  await fetchJellyfinPagesSequential(
    `${base}/Items?ParentId=${seriesId}&IncludeItemTypes=Episode&Recursive=true&Fields=${fields}`,
    apiKey,
    (batch: Array<{ ParentIndexNumber?: number; IndexNumber?: number }>) => {
      for (const ep of batch) {
        if (!Number.isInteger(ep.ParentIndexNumber) || (ep.ParentIndexNumber as number) < 1) continue;
        if (!Number.isInteger(ep.IndexNumber) || (ep.IndexNumber as number) < 1) continue;
        episodes.push({ tmdbId, seasonNumber: ep.ParentIndexNumber as number, episodeNumber: ep.IndexNumber as number });
      }
    },
  );
  return episodes;
}

interface JellyfinEpisodeWithSeries {
  Id?: string;
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Name?: string;
  ProductionYear?: number;
}

export interface JellyfinEpisodeSeriesInfo {
  seriesId: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeName?: string;
  year?: number;
}

export async function getJellyfinEpisodeSeriesIds(
  baseUrl: string,
  apiKey: string,
  itemIds: string[],
): Promise<Map<string, JellyfinEpisodeSeriesInfo>> {
  const result = new Map<string, JellyfinEpisodeSeriesInfo>();
  if (itemIds.length === 0) return result;

  const base = baseUrl.replace(/\/$/, "");
  const CHUNK = 100;
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    const url = `${base}/Items?Ids=${chunk.map(encodeURIComponent).join(",")}&Fields=SeriesId,SeriesName,ParentIndexNumber,IndexNumber,Name,ProductionYear&IncludeItemTypes=Episode&Recursive=true`;
    try {
      const res = await safeFetchAdminConfigured(url, {
        headers: jellyfinHeaders(apiKey),
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Items?: JellyfinEpisodeWithSeries[] };
      for (const item of data.Items ?? []) {
        if (item.Id && item.SeriesId) {
          result.set(item.Id, {
            seriesId: item.SeriesId,
            seriesName: item.SeriesName,
            seasonNumber: item.ParentIndexNumber,
            episodeNumber: item.IndexNumber,
            episodeName: item.Name,
            year: item.ProductionYear,
          });
        }
      }
    } catch (err) {
      console.warn("[jellyfin] Failed to fetch episode series data page:", err);
    }
  }
  return result;
}

export interface JellyfinSessionData {
  sessionId: string;
  playSessionId: string;
  state: "playing" | "paused" | "buffering";
  userId: string;
  userName: string;
  itemId: string;
  title: string;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  itemType: string;
  year?: number;
  durationTicks: number;
  positionTicks: number;
  providerIds?: Record<string, string>;
  playMethod?: string;
  client?: string;
  deviceName?: string;
  deviceId?: string;
  remoteEndPoint?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  container?: string;
  bitrate?: number;
}

interface JellyfinSessionRaw {
  Id?: string;
  PlaySessionId?: string;
  UserId?: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  DeviceId?: string;
  RemoteEndPoint?: string;
  NowPlayingItem?: {
    Id?: string;
    Name?: string;
    SeriesId?: string;
    SeriesName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    Type?: string;
    ProductionYear?: number;
    RunTimeTicks?: number;
    ProviderIds?: Record<string, string>;
    Container?: string;
    MediaStreams?: Array<{ Type?: string; Codec?: string; BitRate?: number; Width?: number; Height?: number }>;
  };
  PlayState?: {
    PositionTicks?: number;
    IsPaused?: boolean;
    PlayMethod?: string;
  };
  TranscodingInfo?: {
    VideoCodec?: string;
    AudioCodec?: string;
    Bitrate?: number;
    Container?: string;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
  };
}

export async function getJellyfinSessions(baseUrl: string, apiKey: string): Promise<JellyfinSessionData[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/Sessions`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Jellyfin sessions: ${res.status}`);
  const raw = (await res.json()) as JellyfinSessionRaw[];

  return raw
    .filter((s) => s.NowPlayingItem)
    .map((s): JellyfinSessionData => {
      const np = s.NowPlayingItem!;
      const ps = s.PlayState;
      const ti = s.TranscodingInfo;
      const videoStream = np.MediaStreams?.find((ms) => ms.Type === "Video");
      const audioStream = np.MediaStreams?.find((ms) => ms.Type === "Audio");

      // Jellyfin's PlayState.PlayMethod can be stale; TranscodingInfo is the authoritative source
      let playMethod = ps?.PlayMethod ?? "DirectPlay";
      if (ti) {
        if (!ti.IsVideoDirect || !ti.IsAudioDirect) playMethod = "Transcode";
        else if (ti.IsVideoDirect && ti.IsAudioDirect && playMethod !== "DirectPlay") playMethod = "DirectStream";
      }

      const title = np.Type === "Episode" && np.SeriesName
        ? `${np.SeriesName} — ${np.Name ?? ""}`
        : np.Name ?? "";

      return {
        sessionId: s.Id ?? "",
        playSessionId: s.PlaySessionId ?? s.Id ?? "",
        state: ps?.IsPaused ? "paused" : "playing",
        userId: s.UserId ?? "",
        userName: s.UserName ?? "",
        itemId: np.Id ?? "",
        title,
        seriesId: np.SeriesId,
        seriesName: np.SeriesName,
        seasonNumber: np.ParentIndexNumber,
        episodeNumber: np.IndexNumber,
        itemType: np.Type ?? "Movie",
        year: np.ProductionYear,
        durationTicks: np.RunTimeTicks ?? 0,
        positionTicks: ps?.PositionTicks ?? 0,
        providerIds: np.ProviderIds,
        playMethod,
        client: s.Client,
        deviceName: s.DeviceName,
        deviceId: s.DeviceId,
        remoteEndPoint: s.RemoteEndPoint,
        videoCodec: ti?.VideoCodec ?? videoStream?.Codec,
        audioCodec: ti?.AudioCodec ?? audioStream?.Codec,
        resolution: videoStream?.Height
          ? (videoStream.Height >= 2160 ? "4K" : videoStream.Height >= 1080 ? "1080p" : videoStream.Height >= 720 ? "720p" : `${videoStream.Height}p`)
          : undefined,
        container: ti?.Container ?? np.Container,
        bitrate: ti?.Bitrate ?? videoStream?.BitRate,
      };
    });
}

export interface JellyfinUserInfo {
  id: string;
  name: string;
  email?: string;
  isAdmin: boolean;
  downloadsEnabled: boolean;
}

type JellyfinRawUser = {
  Id?: string;
  Name?: string;
  Email?: string;
  Policy?: { IsDisabled?: boolean; IsAdministrator?: boolean; EnableContentDownloading?: boolean };
};

export async function getJellyfinAllUsers(baseUrl: string, apiKey: string): Promise<JellyfinUserInfo[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/Users`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinAdminHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Jellyfin users: ${res.status}`);

  // Jellyfin 10.9+ may return a QueryResult wrapper { Items: [...] }
  // rather than a plain array. Handle both.
  const body = (await res.json()) as JellyfinRawUser[] | { Items?: JellyfinRawUser[] };
  const raw: JellyfinRawUser[] = Array.isArray(body) ? body : (body.Items ?? []);

  if (raw.length === 0) {
    console.warn("[jellyfin] getJellyfinAllUsers returned 0 users — check API key permissions");
  }

  const users: JellyfinUserInfo[] = [];
  for (const u of raw) {
    if (!u.Id || !u.Name) continue;
    const email = typeof u.Email === "string" && u.Email.includes("@") ? u.Email : undefined;
    users.push({
      id: u.Id,
      name: u.Name,
      email,
      isAdmin: u.Policy?.IsAdministrator === true,
      // Treat an absent Policy or absent EnableContentDownloading as enabled
      // (Jellyfin's default). Only false is explicitly disabled.
      downloadsEnabled: u.Policy?.EnableContentDownloading !== false,
    });
  }
  return users;
}

export async function setJellyfinDownloadPolicy(
  baseUrl: string,
  apiKey: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  const userRes = await safeFetchAdminConfigured(`${base}/Users/${userId}`, {
    headers: jellyfinAdminHeaders(apiKey),
    timeoutMs: 10_000,
  });
  if (!userRes.ok) throw new Error(`Jellyfin fetch user ${userId}: ${userRes.status}`);

  const userData = (await userRes.json()) as { Policy?: Record<string, unknown> };
  const policy = { ...(userData.Policy ?? {}), EnableContentDownloading: enabled };

  const patchRes = await safeFetchAdminConfigured(`${base}/Users/${userId}/Policy`, {
    method: "POST",
    headers: jellyfinAdminHeaders(apiKey),
    body: JSON.stringify(policy),
    timeoutMs: 10_000,
  });
  if (!patchRes.ok) throw new Error(`Jellyfin set policy ${userId}: ${patchRes.status}`);
}

export async function getJellyfinUserCount(baseUrl: string, apiKey: string): Promise<number> {
  const url = `${baseUrl.replace(/\/$/, "")}/Users`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinHeaders(apiKey),
    timeoutMs: 10_000,
  });
  if (!res.ok) throw new Error(`Jellyfin users: ${res.status}`);
  const raw = (await res.json()) as unknown[];
  return raw.length;
}

export interface JellyfinPlayedItem {
  itemId: string;
  title: string;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  itemType: string;
  year?: number;
  datePlayed?: string;
  durationTicks?: number;
  providerIds?: Record<string, string>;
}

interface JellyfinPlayedItemRaw {
  Id?: string;
  Name?: string;
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Type?: string;
  ProductionYear?: number;
  UserData?: { LastPlayedDate?: string };
  RunTimeTicks?: number;
  ProviderIds?: Record<string, string>;
}

export async function getJellyfinUserPlayHistory(
  baseUrl: string,
  apiKey: string,
  userId: string,
  processItems: (items: JellyfinPlayedItem[]) => void | Promise<void>,
): Promise<number> {
  const base = baseUrl.replace(/\/$/, "");
  const query = `${base}/Users/${encodeURIComponent(userId)}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Recursive=true&IncludeItemTypes=Movie,Episode&Fields=ProviderIds,RunTimeTicks,SeriesId`;
  let total = 0;

  let startIndex = 0;
  let totalRecords = Infinity;
  const pageSize = LIBRARY_PAGE_SIZE;

  while (startIndex < totalRecords) {
    const page = await fetchPage<JellyfinPlayedItemRaw>(query, apiKey, startIndex, pageSize);
    if (startIndex === 0) totalRecords = page.total;

    const items: JellyfinPlayedItem[] = page.items
      .filter((item) => item.Id && item.UserData?.LastPlayedDate)
      .map((item) => ({
        itemId: item.Id!,
        title: item.Type === "Episode" && item.SeriesName
          ? `${item.SeriesName} — ${item.Name ?? ""}`
          : item.Name ?? "",
        seriesId: item.SeriesId,
        seriesName: item.SeriesName,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        itemType: item.Type ?? "Movie",
        year: item.ProductionYear,
        datePlayed: item.UserData?.LastPlayedDate,
        durationTicks: item.RunTimeTicks,
        providerIds: item.ProviderIds,
      }));
    total += items.length;
    await processItems(items);

    startIndex += pageSize;
    if (page.items.length === 0) break;
  }

  return total;
}

export interface JellyfinPlaybackReportItem {
  date: string;
  userId: string;
  itemId: string;
  itemType: string;
  itemName: string;
  playbackMethod: string;
  clientName: string;
  deviceName: string;
  playDuration: number;
}

// Requires the Jellyfin PlaybackReporting plugin — returns null (not empty) when the plugin is absent (404)
export async function getJellyfinPlaybackReporting(
  baseUrl: string,
  apiKey: string,
  startDate?: string,
  endPage?: number,
): Promise<JellyfinPlaybackReportItem[] | null> {
  const base = baseUrl.replace(/\/$/, "");
  const dateFilter = startDate ? `&StartDate=${encodeURIComponent(startDate)}` : "";
  const maxPages = endPage ?? 100;
  const allItems: JellyfinPlaybackReportItem[] = [];

  for (let page = 0; page < maxPages; page++) {
    try {
      const res = await safeFetchAdminConfigured(
        `${base}/user_usage_stats/PlayActivity?Days=10000&EndDate=2099-01-01${dateFilter}&StartIndex=${page * 200}&Limit=200`,
        {
          headers: jellyfinHeaders(apiKey),
          timeoutMs: FETCH_TIMEOUT_MS,
        },
      );
      if (res.status === 404) return null;
      if (!res.ok) return null;

      interface ReportRow {
        Date?: string;
        UserId?: string;
        ItemId?: string;
        ItemType?: string;
        ItemName?: string;
        PlaybackMethod?: string;
        ClientName?: string;
        DeviceName?: string;
        PlayDuration?: number;
      }
      const raw = await res.json();
      const data: ReportRow[] = Array.isArray(raw) ? raw : (raw?.Items ?? raw?.data ?? []);
      if (!Array.isArray(data) || data.length === 0) break;

      for (const row of data) {
        if (!row.Date || !row.UserId || !row.ItemId) continue;
        allItems.push({
          date: row.Date,
          userId: row.UserId,
          itemId: row.ItemId,
          itemType: row.ItemType ?? "",
          itemName: row.ItemName ?? "",
          playbackMethod: row.PlaybackMethod ?? "",
          clientName: row.ClientName ?? "",
          deviceName: row.DeviceName ?? "",
          playDuration: row.PlayDuration ?? 0,
        });
      }

      if (data.length < 200) break;
    } catch {
      return allItems.length > 0 ? allItems : null;
    }
  }

  return allItems;
}

export async function getJellyfinTmdbIds(
  baseUrl: string,
  apiKey: string,
  mediaType: "MOVIE" | "TV",
  libraryIds?: Set<string>,
  minDateLastSaved?: Date,
): Promise<Map<number, JellyfinLibraryItemData>> {
  return getJellyfinItemsByType(baseUrl, apiKey, mediaType === "MOVIE" ? "Movie" : "Series", libraryIds, minDateLastSaved);
}
