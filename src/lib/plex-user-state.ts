// ── Watch sync, Jellyfin → Plex (watch-sync.ts, guardrail 19e) ──────────────
//
// Plex has no admin "mark watched for user X": /:/scrobble marks an item watched
// for whoever's token makes the call. So each paired Plex account is written
// with ITS OWN server token, obtained with the owner's token:
//   - a shared user (friend): plex.tv /api/servers/{machineId}/shared_servers
//     lists every user this server is shared with, each with `userID` and a
//     server-scoped `accessToken` (the field Tautulli and python-plexapi read);
//   - a managed home user: POST plex.tv /api/home/users/{id}/switch answers that
//     user's token (`authenticationToken`, older `authToken`). A user with a
//     home PIN is refused there — reported, never guessed.
// These tokens are held IN MEMORY for one run only: never stored, logged,
// audited or sent to the browser. NEVER fall back to the admin token: it would
// mark the OWNER's account, not the paired one.
// UNVERIFIED against a live plex.tv (checked against client code only) — the
// parsers are defensive and an unparseable answer reads as "no token".
import { safeFetchTrusted } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { asRecord, STOP_PAGING } from "./media-server-payload";
import {
  noRetry,
  plexFetchAllPages,
  PLEX_TV_HOSTS,
  plexFetch,
  plexTvXmlHeaders,
  plexUrl,
  readPlexContainer,
  tagNoRetryOn4xx,
  withPlexRetry,
} from "./plex-http";
import { numericRatingKey } from "./plex-metadata";

const PLEX_TOKEN_RE = /^[A-Za-z0-9_\-]{8,200}$/;

function xmlAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** userID → server access token, from a shared_servers XML answer. */
export function parsePlexSharedServerTokens(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of xml.split(/<SharedServer\b/).slice(1)) {
    const tag = block.slice(0, block.indexOf(">") >= 0 ? block.indexOf(">") : block.length);
    const userId = xmlAttr(tag, "userID");
    const token = xmlAttr(tag, "accessToken");
    if (userId && /^\d{1,20}$/.test(userId) && token && PLEX_TOKEN_RE.test(token)) out.set(userId, token);
  }
  return out;
}

/** The token from a home-user switch answer (XML or JSON); null when absent. */
export function parsePlexHomeSwitchToken(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const j = asRecord(parsed);
    const t = typeof j?.authToken === "string" ? j.authToken : typeof j?.authenticationToken === "string" ? j.authenticationToken : null;
    return t && PLEX_TOKEN_RE.test(t) ? t : null;
  }
  const m = /<user\b[^>]*>/i.exec(trimmed);
  if (!m) return null;
  const t = xmlAttr(m[0], "authenticationToken") ?? xmlAttr(m[0], "authToken");
  return t && PLEX_TOKEN_RE.test(t) ? t : null;
}

export async function getPlexSharedServerTokens(adminToken: string, machineId: string): Promise<Map<string, string>> {
  if (!/^[A-Za-z0-9]{1,128}$/.test(machineId)) throw new Error("Invalid Plex machine identifier");
  const res = await safeFetchTrusted(`https://plex.tv/api/servers/${machineId}/shared_servers`, {
    allowedHosts: PLEX_TV_HOSTS,
    headers: plexTvXmlHeaders(adminToken),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Plex shared servers lookup failed: ${res.status}`);
  return parsePlexSharedServerTokens(await res.text());
}

/**
 * A managed home user's own token for the owner's servers. null = no token we
 * can obtain (not a home user, or a PIN-protected one). Throws when the answer
 * says nothing about the user: a rate limit, a refused ADMIN token (401 —
 * every per-user feature would otherwise go quiet as if no user could be
 * switched to), or a server error.
 */
export async function getPlexHomeUserToken(adminToken: string, plexUserId: string): Promise<string | null> {
  if (!/^\d{1,20}$/.test(plexUserId)) return null;
  const res = await safeFetchTrusted(`https://plex.tv/api/home/users/${plexUserId}/switch`, {
    allowedHosts: PLEX_TV_HOSTS,
    method: "POST",
    headers: plexTvXmlHeaders(adminToken),
    timeoutMs: 15_000,
  });
  if (res.status === 429) {
    await res.body?.cancel().catch(() => {});
    throw new Error("Plex home user switch rate-limited (429)");
  }
  // 401 is plex.tv refusing the ADMIN token (the same reading checkPlexToken
  // gives it) — a configuration problem, not a fact about this user.
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    throw new Error("Plex refused the server's admin token (401) at the home user switch");
  }
  // Other 4xx: not a home user, or a PIN-protected one — no token, not an error.
  if (res.status >= 400 && res.status < 500) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) throw new Error(`Plex home user switch failed: ${res.status}`);
  return parsePlexHomeSwitchToken(await res.text());
}

const PLEX_VIEW_COUNT_CHUNK = 50;

/** One item AS SEEN BY one user's token. */
export interface PlexUserItemState {
  viewCount: number;
  // Resume position (ms); 0 = none.
  viewOffset: number;
  durationMs: number | null;
  lastViewedAt: Date | null;
}

function plexNum(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function plexUserState(m: Record<string, unknown>): PlexUserItemState {
  const lv = plexNum(m.lastViewedAt);
  const d = plexNum(m.duration);
  return { viewCount: plexNum(m.viewCount), viewOffset: plexNum(m.viewOffset), durationMs: d > 0 ? d : null, lastViewedAt: lv > 0 ? new Date(lv * 1000) : null };
}

/**
 * ratingKey → that item's state AS SEEN BY `token`'s user. A key the server
 * didn't return is absent: the item is gone. Each chunk is retried like a
 * library page, so one transient 5xx doesn't throw away every state already
 * read; an answer without a MediaContainer is a failed read (never "all gone").
 */
export async function getPlexUserStates(serverUrl: string, token: string, keys: readonly string[]): Promise<Map<string, PlexUserItemState>> {
  const base = trimServerBase(serverUrl);
  const valid = [...new Set(keys.filter((k) => /^\d{1,20}$/.test(k)))];
  const out = new Map<string, PlexUserItemState>();
  const queue: string[][] = [];
  for (let i = 0; i < valid.length; i += PLEX_VIEW_COUNT_CHUNK) queue.push(valid.slice(i, i + PLEX_VIEW_COUNT_CHUNK));
  while (queue.length > 0) {
    const chunk = queue.shift()!;
    const items = await withPlexRetry(`metadata read of ${chunk.length} item(s)`, async () => {
      const res = await plexFetch(`${base}/library/metadata/${chunk.join(",")}`, token);
      if (res.status === 404) {
        await res.text().catch(() => "");
        return null;
      }
      if (!res.ok) throw tagNoRetryOn4xx(new Error(`Plex metadata read failed: ${res.status}`), res.status);
      const container = readPlexContainer(await res.json());
      if (!container) throw noRetry(new Error("Plex metadata read failed: no MediaContainer"));
      return container.items;
    });
    if (items === null) {
      // One gone key can 404 the whole list: bisect it, so only the truly
      // absent ones read as gone and a lone gone key costs ~log2(n) reads.
      if (chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        queue.push(chunk.slice(0, mid), chunk.slice(mid));
      }
      continue;
    }
    const wanted = new Set(chunk);
    for (const raw of items) {
      const m = asRecord(raw);
      const k = m ? numericRatingKey(m.ratingKey) : null;
      if (!m || !k || !wanted.has(k)) continue;
      out.set(k, plexUserState(m));
    }
  }
  return out;
}

/** ratingKey → viewCount AS SEEN BY `token`'s user (0 = unwatched); absent = gone. */
export async function getPlexViewCounts(serverUrl: string, token: string, keys: readonly string[]): Promise<Map<string, number>> {
  const states = await getPlexUserStates(serverUrl, token, keys);
  return new Map([...states].map(([k, s]) => [k, s.viewCount]));
}

export interface PlexInProgressItem {
  kind: "movie" | "episode";
  ratingKey: string;
  // The show's ratingKey for an episode.
  showKey: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  state: PlexUserItemState;
}

const PLEX_IN_PROGRESS_MAX = 500;

function nonNegativeIndex(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
}

export function parsePlexInProgress(items: ReadonlyArray<unknown>, max: number = PLEX_IN_PROGRESS_MAX): PlexInProgressItem[] {
  const out: PlexInProgressItem[] = [];
  for (const raw of items) {
    if (out.length >= max) break;
    const m = asRecord(raw);
    if (!m) continue;
    const kind = m.type === "movie" ? "movie" : m.type === "episode" ? "episode" : null;
    const ratingKey = numericRatingKey(m.ratingKey);
    if (!kind || !ratingKey) continue;
    const state = plexUserState(m);
    if (state.viewOffset <= 0) continue; // an "up next" episode, not in progress
    out.push({
      kind,
      ratingKey,
      showKey: kind === "episode" ? numericRatingKey(m.grandparentRatingKey) : null,
      seasonNumber: kind === "episode" ? nonNegativeIndex(m.parentIndex) : null,
      episodeNumber: kind === "episode" ? nonNegativeIndex(m.index) : null,
      state,
    });
  }
  return out;
}

/**
 * The user's in-progress items (resume points), read with THEIR token:
 * /library/onDeck, falling back to the Continue Watching hub on servers that
 * dropped it. UNVERIFIED against a live server — both answer MediaContainer
 * Metadata[] in client code. An answer without a MediaContainer is a failed
 * read, never "nothing in progress".
 */
export async function getPlexInProgress(serverUrl: string, token: string): Promise<PlexInProgressItem[]> {
  const base = trimServerBase(serverUrl);
  for (const path of ["/library/onDeck", "/hubs/continueWatching/items"]) {
    const container = await withPlexRetry(`in-progress read (${path})`, async () => {
      const res = await plexFetch(`${base}${path}?X-Plex-Container-Start=0&X-Plex-Container-Size=${PLEX_IN_PROGRESS_MAX}`, token);
      if (res.status === 404) { await res.text().catch(() => ""); return null; }
      if (!res.ok) throw tagNoRetryOn4xx(new Error(`Plex in-progress read failed: ${res.status}`), res.status);
      const c = readPlexContainer(await res.json());
      if (!c) throw noRetry(new Error("Plex in-progress read failed: no MediaContainer"));
      return c;
    });
    if (!container) continue;
    return parsePlexInProgress(container.items);
  }
  return [];
}

/** Ceiling on a full (migration) read of one account's partial watches. */
export const PLEX_FULL_IN_PROGRESS_MAX = 5_000;

/**
 * EVERY partially watched movie and episode the account can see, not just what
 * On Deck / Continue Watching surface (On Deck is one episode per show and a
 * short window; a user being moved between platforms has partial watches far
 * older than that). Walks each section with Plex's `inProgress=1` filter
 * (episodes as type=4) AS THE USER. UNVERIFIED against a live server — the
 * filter is the one python-plexapi sends. A section that answers an error
 * throws: a partial listing is never "nothing in progress".
 */
export async function getPlexAllInProgress(
  serverUrl: string,
  token: string,
  sections: ReadonlyArray<{ key: string; type: "movie" | "show" }>,
  signal?: AbortSignal,
): Promise<PlexInProgressItem[]> {
  const base = trimServerBase(serverUrl);
  const out: PlexInProgressItem[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (!/^\d{1,20}$/.test(section.key)) continue;
    const type = section.type === "movie" ? 1 : 4;
    await plexFetchAllPages(
      `${base}/library/sections/${section.key}/all?type=${type}&inProgress=1`,
      token,
      (items) => {
        for (const item of parsePlexInProgress(items, PLEX_FULL_IN_PROGRESS_MAX)) {
          if (seen.has(item.ratingKey)) continue;
          seen.add(item.ratingKey);
          out.push(item);
          if (out.length >= PLEX_FULL_IN_PROGRESS_MAX) return STOP_PAGING;
        }
        return undefined;
      },
      signal,
    );
    if (out.length >= PLEX_FULL_IN_PROGRESS_MAX) break;
  }
  return out;
}

/**
 * Set one item's resume position for `token`'s user (/:/progress, state=stopped
 * — python-plexapi's updateProgress). 404 = the item is gone. UNVERIFIED against
 * a live server, including whether it ever surfaces as a playback session —
 * which is why resume-point sync is a per-pair switch, off by default.
 */
export async function setPlexProgress(serverUrl: string, token: string, ratingKey: string, timeMs: number): Promise<"marked" | "missing"> {
  if (!/^\d{1,20}$/.test(ratingKey) || !Number.isFinite(timeMs) || timeMs <= 0) return "missing";
  const res = await plexFetch(
    plexUrl(serverUrl, `/:/progress?key=${ratingKey}&identifier=com.plexapp.plugins.library&time=${Math.round(timeMs)}&state=stopped`),
    token,
  );
  await res.text().catch(() => "");
  if (res.ok) return "marked";
  if (res.status === 404) return "missing";
  throw new Error(`Plex set progress failed: ${res.status}`);
}

/** Mark one item watched for `token`'s user. 404 = the item is gone. */
export async function scrobblePlexItem(serverUrl: string, token: string, ratingKey: string): Promise<"marked" | "missing"> {
  if (!/^\d{1,20}$/.test(ratingKey)) return "missing";
  const res = await plexFetch(
    plexUrl(serverUrl, `/:/scrobble?identifier=com.plexapp.plugins.library&key=${ratingKey}`),
    token,
  );
  await res.text().catch(() => "");
  if (res.ok) return "marked";
  if (res.status === 404) return "missing";
  throw new Error(`Plex mark watched failed: ${res.status}`);
}
