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
  return {
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
const PLEX_PAGE_SIZE   = 1_000;

async function plexFetchAllPages<T>(
  baseUrl: string,
  token: string,
  processItems: (items: T[]) => void,
): Promise<void> {
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const res = await plexFetch(
      `${baseUrl}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PLEX_PAGE_SIZE}`,
      token,
    );
    if (!res.ok) throw new Error(`Plex paginated fetch failed: ${res.status} at start=${start}`);
    const data = await res.json() as { MediaContainer: { Metadata?: T[]; totalSize?: number; size?: number } };
    const items = data.MediaContainer.Metadata ?? [];
    if (start === 0) total = data.MediaContainer.totalSize ?? data.MediaContainer.size ?? items.length;
    processItems(items);
    start += items.length;
    if (items.length === 0) break;
  }
}

function plexFetch(url: string, token: string): Promise<Response> {
  return safeFetchAdminConfigured(url, {
    headers: plexServerHeaders(token),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

// Plex exposes two GUID shapes: modern items use the Guid[] array; older library agents use a single guid string
function extractTmdbId(item: PlexMetadataItem): number | null {
  if (item.Guid) {
    for (const g of item.Guid) {
      if (g.id.startsWith("tmdb://")) {
        const n = parseInt(g.id.slice(7), 10);
        if (!isNaN(n)) return n;
      }
    }
  }

  if (item.guid) {
    const m = item.guid.match(/themoviedb:\/\/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

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

export async function getPlexLibrarySections(
  serverUrl: string,
  token: string,
): Promise<PlexSection[]> {
  const res = await plexFetch(`${serverUrl}/library/sections`, token);
  if (!res.ok) throw new Error(`Plex sections: ${res.status}`);
  const data = await res.json() as {
    MediaContainer: { Directory?: Array<{ key: string; title: string; type: string }> };
  };
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
      for (const id of ids) items.set(id, entry);
    }
  });

  if (sectionType === "show") {
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
): Promise<Map<number, PlexLibraryItemData>> {
  const sectionType = mediaType === "MOVIE" ? "movie" : "show";
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token);
  const matching = allSections.filter((s) => s.type === sectionType && (!selectedKeys?.size || selectedKeys.has(s.key)));
  const results = await Promise.all(
    matching.map((s) => getPlexSectionTmdbIds(serverUrl, token, s.key, sectionType, recentOnly))
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
): Promise<PlexTVEpisodeData[]> {
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token);
  const showSections = allSections.filter(
    (s) => s.type === "show" && (!selectedKeys?.size || selectedKeys.has(s.key))
  );

  const sectionResults = await Promise.all(showSections.map(async (section) => {
    const ratingKeyToTmdb = new Map<string, number>();
    await plexFetchAllPages<PlexShowMeta>(
      `${serverUrl}/library/sections/${section.key}/all?type=2&includeGuids=1`,
      token,
      (batch) => {
        for (const show of batch) {
          const tmdbId = extractTmdbId(show);
          if (tmdbId !== null) ratingKeyToTmdb.set(show.ratingKey, tmdbId);
        }
      },
    );

    if (ratingKeyToTmdb.size === 0) return [] as PlexTVEpisodeData[];

    const episodes: PlexTVEpisodeData[] = [];
    await plexFetchAllPages<PlexEpisodeMeta>(
      `${serverUrl}/library/sections/${section.key}/all?type=4`,
      token,
      (batch) => {
        for (const ep of batch) {
          const tmdbId = ratingKeyToTmdb.get(ep.grandparentRatingKey);
          if (tmdbId == null) continue;
          if (!Number.isInteger(ep.parentIndex) || ep.parentIndex < 1) continue;
          if (!Number.isInteger(ep.index) || ep.index < 1) continue;
          episodes.push({ tmdbId, seasonNumber: ep.parentIndex, episodeNumber: ep.index });
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
  playMethod?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  bitrate?: number;
  videoDecision?: string;
  audioDecision?: string;
  container?: string;
}

interface PlexSessionRaw {
  sessionKey?: string;
  Player?: {
    state?: string;
    title?: string;
    platform?: string;
    machineIdentifier?: string;
    address?: string;
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
  Media?: Array<{
    container?: string;
    bitrate?: number;
    videoResolution?: string;
    Part?: Array<{
      file?: string;
      Stream?: Array<{ streamType?: number; codec?: string; decision?: string }>;
    }>;
  }>;
  Session?: { id?: string };
  TranscodeSession?: {
    videoDecision?: string;
    audioDecision?: string;
    transcodeHwRequested?: boolean;
  };
}

export async function getPlexSessions(serverUrl: string, token: string): Promise<PlexSessionData[]> {
  const res = await plexFetch(`${serverUrl}/status/sessions?includeGuids=1`, token);
  if (!res.ok) throw new Error(`Plex sessions: ${res.status}`);
  const data = await res.json() as { MediaContainer: { Metadata?: PlexSessionRaw[] } };
  const raw = data.MediaContainer.Metadata ?? [];

  return raw.map((s): PlexSessionData => {
    const videoStream = s.Media?.[0]?.Part?.[0]?.Stream?.find((st) => st.streamType === 1);
    const audioStream = s.Media?.[0]?.Part?.[0]?.Stream?.find((st) => st.streamType === 2);
    const ts = s.TranscodeSession;

    let playMethod = "DirectPlay";
    if (ts?.videoDecision === "transcode" || ts?.audioDecision === "transcode") {
      playMethod = "Transcode";
    } else if (ts?.videoDecision === "copy" || ts?.audioDecision === "copy") {
      playMethod = "DirectStream";
    }

    return {
      sessionKey: s.sessionKey ?? s.Session?.id ?? "",
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
      duration: s.duration ?? 0,
      viewOffset: s.viewOffset ?? 0,
      Guid: s.Guid,
      platform: s.Player?.platform,
      player: s.Player?.title,
      device: s.Player?.machineIdentifier,
      address: s.Player?.address,
      playMethod,
      videoCodec: videoStream?.codec ?? undefined,
      audioCodec: audioStream?.codec ?? undefined,
      resolution: s.Media?.[0]?.videoResolution ?? undefined,
      bitrate: s.Media?.[0]?.bitrate ?? undefined,
      videoDecision: ts?.videoDecision ?? videoStream?.decision ?? undefined,
      audioDecision: ts?.audioDecision ?? audioStream?.decision ?? undefined,
      container: s.Media?.[0]?.container ?? undefined,
    };
  });
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

export async function fetchPlexShowTmdbId(
  serverUrl: string,
  token: string,
  ratingKey: string,
): Promise<number | null> {
  try {
    const res = await plexFetch(
      `${serverUrl}/library/metadata/${encodeURIComponent(ratingKey)}?includeGuids=1`,
      token,
    );
    if (!res.ok) return null;
    const data = await res.json() as { MediaContainer?: { Metadata?: PlexMetadataItem[] } };
    const item = data.MediaContainer?.Metadata?.[0];
    return item ? extractTmdbId(item) : null;
  } catch {
    return null;
  }
}

export interface PlexHistoryItem {
  accountId: string;
  viewedAt: number;
  ratingKey: string;
  grandparentRatingKey?: string;
  title: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  type: string;
  year?: number;
  duration?: number;
  Guid?: PlexGuid[];
  device?: string;
  platform?: string;
  player?: string;
}

interface PlexHistoryRaw {
  accountID?: number;
  viewedAt?: number;
  ratingKey?: string;
  grandparentRatingKey?: string;
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  type?: string;
  year?: number;
  duration?: number;
  Guid?: PlexGuid[];
  Player?: { title?: string; platform?: string; machineIdentifier?: string };
}

export async function getPlexHistoryAll(
  serverUrl: string,
  token: string,
  processItems: (items: PlexHistoryItem[]) => void | Promise<void>,
  minDate?: Date,
): Promise<number> {
  let total = 0;
  const minEpoch = minDate ? Math.floor(minDate.getTime() / 1000) : undefined;
  const dateFilter = minEpoch ? `&viewedAt>=${minEpoch}` : "";
  const baseUrl = `${serverUrl}/status/sessions/history/all?sort=viewedAt:desc&includeGuids=1&includeMetadata=1${dateFilter}`;

  let start = 0;
  let totalSize = Infinity;
  while (start < totalSize) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const res = await plexFetch(
      `${baseUrl}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PLEX_PAGE_SIZE}`,
      token,
    );
    if (!res.ok) throw new Error(`Plex history fetch failed: ${res.status} at start=${start}`);
    const data = await res.json() as { MediaContainer: { Metadata?: PlexHistoryRaw[]; totalSize?: number; size?: number } };
    const batch = data.MediaContainer.Metadata ?? [];
    if (start === 0) totalSize = data.MediaContainer.totalSize ?? data.MediaContainer.size ?? batch.length;

    const items: PlexHistoryItem[] = batch.map((h) => ({
      accountId: String(h.accountID ?? ""),
      viewedAt: h.viewedAt ?? 0,
      ratingKey: h.ratingKey ?? "",
      grandparentRatingKey: h.grandparentRatingKey,
      title: h.type === "episode"
        ? `${h.grandparentTitle ?? ""} — ${h.title ?? ""}`
        : h.title ?? "",
      grandparentTitle: h.grandparentTitle,
      parentIndex: h.parentIndex,
      index: h.index,
      type: h.type ?? "movie",
      year: h.year,
      duration: h.duration,
      Guid: h.Guid,
      device: h.Player?.machineIdentifier,
      platform: h.Player?.platform,
      player: h.Player?.title,
    }));
    total += items.length;
    await processItems(items);

    start += batch.length;
    if (batch.length === 0) break;
  }

  return total;
}

export interface PlexAccountInfo {
  id: string;
  name: string;
  email: string;
  thumb: string;
}

export async function getPlexAccounts(serverUrl: string, adminToken: string): Promise<PlexAccountInfo[]> {
  const accounts: PlexAccountInfo[] = [];

  try {
    // The server owner doesn't appear in the shared-users list, so fetch separately and assign a synthetic id of "1"
    const owner = await getPlexUser(adminToken);
    accounts.push({ id: "1", name: owner.username, email: owner.email, thumb: owner.thumb });
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
          });
        }
      }
    }
  } catch (err) {
    console.warn("[plex] Failed to fetch shared users:", err instanceof Error ? err.message : String(err));
  }

  return accounts;
}

async function getPlexMachineId(serverUrl: string, adminToken: string): Promise<string | null> {
  try {
    const res = await plexFetch(`${serverUrl}/identity`, adminToken);
    if (!res.ok) return null;
    const data = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    return data.MediaContainer?.machineIdentifier ?? null;
  } catch {
    return null;
  }
}

export async function getPlexFriendEmails(adminToken: string, serverUrl?: string): Promise<Set<string>> {
  const machineId = serverUrl ? await getPlexMachineId(serverUrl, adminToken) : null;

  const res = await safeFetchTrusted("https://plex.tv/api/users", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: { "X-Plex-Client-Identifier": PLEX_CLIENT_ID, "X-Plex-Token": adminToken },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch Plex users: ${res.status}`);
  const xml = await res.text();

  const emails = new Set<string>();
  const userBlocks = xml.split(/<User\b/).slice(1);
  for (const block of userBlocks) {
    const emailMatch = block.match(/\bemail="([^"]+)"/);
    if (!emailMatch) continue;

    if (machineId) {
      const hasServer = block.includes(`machineIdentifier="${machineId}"`);
      if (!hasServer) continue;
    }

    const email = emailMatch[1].toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emails.add(email);
    }
  }
  return emails;
}
