import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { mediaInstanceLabel, type MediaInstanceKey } from "@/lib/media-instances";
import type { FixMatchReport } from "@/lib/fix-match-jobs";
import { plexAdminHeaders, tmdbDetailsCacheKey } from "@/lib/fix-match-shared";
import {
  FixMatchDiagnosticError,
  isRecord,
  pause,
  readJsonOrNull,
  refreshBestEffort,
  remoteProgress,
  stringOr,
  type RemoteProgress,
} from "@/lib/fix-match-remote";

// The Plex half of a fix-match remap: unmatch the item, re-match it to the
// correct TMDB id, and poll until Plex confirms. The route's modes
// (fix-match-apply.ts) call fixPlexMatch once per copy of a title.

const TMDB_HOSTS = ["api.themoviedb.org"];

// Fallback candidates applied live after the first match did not confirm. Each
// costs an apply, a refresh and a 30 s poll on the item, and holds a job slot
// while it does; the legacy-agent apply still runs after these.
export const MAX_FALLBACK_ATTEMPTS = 3;

// Thrown by fixPlexMatch when the unmatch PUT succeeded but no re-match was ever
// confirmed: the item now sits in Plex with NO match at all, which is a worse
// state than "nothing changed" and needs its own message (the DB row still
// carries the old id, so the next sync — keyed on a tmdb guid — drops the row
// and the title vanishes from availability until someone re-matches it in Plex).
export class PlexUnmatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlexUnmatchedError";
  }
}

// ── Reading Plex's answers (pure) ────────────────────────────────────────────

/** One /matches search result, as far as fix-match reads it. */
export type PlexSearchResult = { guid: string; name?: string; year?: number; guidIds: string[] };

/** The `Guid[].id` strings of a Plex metadata item or search result. */
export function plexGuidIds(item: unknown): string[] {
  if (!isRecord(item) || !Array.isArray(item.Guid)) return [];
  const ids: string[] = [];
  for (const g of item.Guid) if (isRecord(g) && typeof g.id === "string") ids.push(g.id);
  return ids;
}

function plexYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d{4}$/.test(value)) return Number(value);
  return undefined;
}

/** A /matches `SearchResult` entry, or null when it names no guid. */
export function asPlexSearchResult(raw: unknown): PlexSearchResult | null {
  if (!isRecord(raw) || typeof raw.guid !== "string" || !raw.guid) return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : undefined;
  return { guid: raw.guid, name, year: plexYear(raw.year), guidIds: plexGuidIds(raw) };
}

/** The first `Metadata` entry of a /library/metadata answer, or null. */
export function firstPlexMetadata(json: unknown): Record<string, unknown> | null {
  if (!isRecord(json) || !isRecord(json.MediaContainer)) return null;
  const list = json.MediaContainer.Metadata;
  return Array.isArray(list) && isRecord(list[0]) ? list[0] : null;
}

// Whether a /matches result names the title being fixed — by its TMDB or IMDb
// id, in the modern Guid list or a legacy agent guid.
export function candidateCarriesTarget(c: PlexSearchResult, correctTmdbId: number, imdbId: string): boolean {
  const tmdb = String(correctTmdbId);
  if (c.guidIds.includes(`tmdb://${tmdb}`) || (!!imdbId && c.guidIds.includes(`imdb://${imdbId}`))) return true;
  if (new RegExp(`themoviedb://${tmdb}(?![0-9])`).test(c.guid)) return true;
  return /^tt\d+$/.test(imdbId) && new RegExp(`imdb://${imdbId}(?![0-9])`).test(c.guid);
}

/** Whether a Plex item names `tmdbId`, in its Guid list or its legacy agent guid. */
export function guidCarriesTmdb(item: unknown, tmdbId: number): boolean {
  const id = String(tmdbId);
  const guid = isRecord(item) ? stringOr(item.guid) : "";
  return plexGuidIds(item).includes(`tmdb://${id}`) || new RegExp(`themoviedb://${id}(?![0-9])`).test(guid);
}

// Which title a Plex item currently claims. A row's `plexRatingKeys` also holds
// keys that merely ride along (a conflated item, guardrail 37c).
//   "old"     — still the id being replaced; safe to remap
//   "correct" — already the destination id; join that row, don't remap again
//   "other"   — a different title; leave that item alone
export function classifyPlexCopy(item: unknown, oldTmdbId: number, correctTmdbId: number): "old" | "correct" | "other" {
  if (guidCarriesTmdb(item, oldTmdbId)) return "old";
  if (guidCarriesTmdb(item, correctTmdbId)) return "correct";
  return "other";
}

export type PlexConfirmation = {
  // "tmdb": Plex reports the target's TMDB id. "imdb": it reports the target's
  // IMDb id and no other TMDB id beside it (two TMDB entries for one film).
  // "conflated": the target's TMDB id rides beside a different primary one.
  // null: none of these (yet).
  verdict: "tmdb" | "imdb" | "conflated" | null;
  plexTmdbId?: string;
  plexImdbId?: string;
};

/** What one confirmation read of the item says about the match. */
export function judgePlexConfirmation(item: unknown, correctTmdbId: number, imdbId: string): PlexConfirmation {
  const target = String(correctTmdbId);
  const legacyTmdb = /themoviedb:\/\/(\d+)/.exec(isRecord(item) ? stringOr(item.guid) : "")?.[1];
  const guidIds = plexGuidIds(item);
  const plexTmdbId = guidIds.find((id) => id.startsWith("tmdb://"))?.replace("tmdb://", "") ?? legacyTmdb;
  const plexImdbId = guidIds.find((id) => id.startsWith("imdb://"))?.replace("imdb://", "");
  const ids = { plexTmdbId, plexImdbId };
  if (plexTmdbId === target || legacyTmdb === target) return { verdict: "tmdb", ...ids };
  const hasOtherTmdb = guidIds.some((id) => id.startsWith("tmdb://") && id !== `tmdb://${target}`);
  if (!!imdbId && plexImdbId === imdbId && !hasOtherTmdb) return { verdict: "imdb", ...ids };
  // The target's id is in the list but not primary (the primary differs, or
  // the "tmdb" verdict above would have returned).
  if (guidIds.includes(`tmdb://${target}`)) return { verdict: "conflated", ...ids };
  return { verdict: null, ...ids };
}

const IMDB_ID = /^tt\d+$/;
const imdbIdOr = (value: unknown): string => (typeof value === "string" && IMDB_ID.test(value) ? value : "");

/** The correct title as the search and apply name it. Blank fields are unknown. */
export type PlexTarget = { title: string; year: string; imdbId: string };

/** Title, year and IMDb id from the shared TMDB details cache row's JSON; blanks for anything it doesn't hold. */
export function cachedPlexTarget(data: string | null | undefined): PlexTarget {
  const blank = { title: "", year: "", imdbId: "" };
  if (!data) return blank;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return blank;
  }
  if (!isRecord(parsed)) return blank;
  return {
    title: typeof parsed.title === "string" ? parsed.title : stringOr(parsed.name),
    year: stringOr(parsed.releaseYear).slice(0, 4),
    imdbId: imdbIdOr(parsed.imdbId),
  };
}

// ── Talking to the server ────────────────────────────────────────────────────

type PlexSession = { serverUrl: string; token: string; headers: Record<string, string>; safeKey: string; tag: string };

// `instance` selects WHICH configured Plex server gets rewritten and MUST be the
// same slug the caller used to read the library row: a Plex ratingKey is a small
// server-local integer, so replaying one server's key against another server's
// API remaps an unrelated item. It is threaded, never defaulted, for that reason.
async function openPlexSession(ratingKey: string, correctTmdbId: number, instance: MediaInstanceKey): Promise<PlexSession> {
  // Plex rating keys are always integers; coerce to break taint from a DB-read
  // string before it's interpolated into any admin-token URL.
  const safeKey = String(parseInt(ratingKey, 10) || 0);
  const tag = `[fix-match/${mediaInstanceLabel("plex", instance)} ratingKey=${safeKey} target=tmdb://${correctTmdbId}]`;
  const cfg = await getPlexConfig(instance);
  if (!cfg.url || !cfg.token) throw new Error("Plex server not configured");
  return { serverUrl: cfg.url.replace(/\/$/, ""), token: cfg.token, headers: plexAdminHeaders(cfg.token), safeKey, tag };
}

const itemUrl = (s: PlexSession, suffix = "") => `${s.serverUrl}/library/metadata/${s.safeKey}${suffix}`;
const legacyTmdbGuid = (tmdbId: number) => `com.plexapp.agents.themoviedb://${tmdbId}?lang=en`;
const refreshItem = (s: PlexSession) => refreshBestEffort(itemUrl(s, "/refresh?force=1"), { method: "PUT", headers: s.headers }, s.tag);

// The item's own title and year, when the TMDB cache had none. Null leaves the
// cached values alone (the read failed).
async function plexItemTitle(s: PlexSession): Promise<{ title: string; year: string } | null> {
  const res = await safeFetchAdminConfigured(itemUrl(s), { headers: s.headers, timeoutMs: 15_000 });
  if (!res.ok) {
    console.warn("[fix-match]", `${s.tag} Plex metadata fetch failed: ${res.status}`);
    return null;
  }
  const json = await readJsonOrNull(res);
  if (json === null) console.warn("[fix-match]", `${s.tag} Plex metadata answer was not JSON`);
  const meta = firstPlexMetadata(json);
  const year = meta ? plexYear(meta.year) : undefined;
  return { title: meta ? stringOr(meta.title) : "", year: year ? String(year) : "" };
}

async function tmdbImdbId(mediaType: "MOVIE" | "TV", correctTmdbId: number, tag: string): Promise<string> {
  const tAuth = tmdbAuth();
  if (!tAuth) {
    console.warn("[fix-match]", `${tag} No TMDB credentials set (TMDB_READ_TOKEN) — cannot fetch IMDB ID`);
    return "";
  }
  const extUrl = new URL(`https://api.themoviedb.org/3/${mediaType === "MOVIE" ? "movie" : "tv"}/${correctTmdbId}/external_ids`);
  const res = await safeFetchTrusted(extUrl.toString(), {
    allowedHosts: TMDB_HOSTS,
    headers: tAuth.headers,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!res?.ok) {
    console.warn("[fix-match]", `${tag} TMDB external_ids fetch failed: ${res?.status ?? "network error"}`);
    return "";
  }
  const ext = await readJsonOrNull(res);
  return isRecord(ext) ? imdbIdOr(ext.imdb_id) : "";
}

async function resolvePlexTarget(s: PlexSession, mediaType: "MOVIE" | "TV", correctTmdbId: number): Promise<PlexTarget> {
  const row = await prisma.tmdbCache.findUnique({ where: { key: tmdbDetailsCacheKey(mediaType, correctTmdbId) }, select: { data: true } });
  const target = cachedPlexTarget(row?.data);
  if (!target.title) Object.assign(target, await plexItemTitle(s));
  if (!target.imdbId) target.imdbId = await tmdbImdbId(mediaType, correctTmdbId, s.tag);
  return target;
}

// The raw `SearchResult` list of one /matches search — [] when the search
// failed or its answer was unreadable. Both the first pick and the fallbacks
// read it here.
async function plexMatchSearch(s: PlexSession, params: Record<string, string>): Promise<unknown[]> {
  const res = await safeFetchAdminConfigured(itemUrl(s, "/matches?") + new URLSearchParams(params), {
    headers: s.headers,
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!res?.ok) return [];
  const json = await readJsonOrNull(res);
  const list = isRecord(json) && isRecord(json.MediaContainer) ? json.MediaContainer.SearchResult : undefined;
  return Array.isArray(list) ? list : [];
}

const imdbAgentSearch = (imdbId: string) =>
  ({ manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" });
const tmdbAgentSearch = (tmdbId: number) =>
  ({ manual: "1", includeGuids: "1", q: String(tmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" });

type ChosenMatch = { guid: string; name: string; year: string };

// A GUID search across the imdb and tmdb agents, then by title. The first
// search to answer wins: its top result, and the name/year it reports. Null
// leaves the apply to the raw tmdb:// guid.
async function findCanonicalMatch(s: PlexSession, target: PlexTarget, correctTmdbId: number): Promise<ChosenMatch | null> {
  const searches: Array<Record<string, string>> = [];
  if (target.imdbId) {
    searches.push({ manual: "1", includeGuids: "1", guid: `imdb://${target.imdbId}` }, imdbAgentSearch(target.imdbId));
  }
  searches.push(tmdbAgentSearch(correctTmdbId));
  const byText: Record<string, string> = { manual: "1", includeGuids: "1" };
  if (target.title) byText.title = target.title;
  if (target.year) byText.year = target.year;
  searches.push(byText);
  for (const params of searches) {
    const hit = asPlexSearchResult((await plexMatchSearch(s, params))[0]);
    if (hit) return { guid: hit.guid, name: hit.name ?? target.title, year: hit.year ? String(hit.year) : target.year };
  }
  console.warn("[fix-match]", `${s.tag} all search strategies found no candidates — will use raw tmdb:// fallback`);
  return null;
}

function applyPlexMatch(s: PlexSession, guid: string, name: string, year: string): Promise<Response> {
  const params: Record<string, string> = { guid };
  if (name) params.name = name;
  if (year) params.year = year;
  return safeFetchAdminConfigured(itemUrl(s, "/match?") + new URLSearchParams(params), { method: "PUT", headers: s.headers, timeoutMs: 30_000 });
}

// Unmatches the item (and, on a title's first copy, runs Plex's library-wide
// bundle clean to clear stale metadata bundles before the re-match). True when
// the unmatch landed: from then on a failed re-match leaves the item UNMATCHED
// in Plex, not merely unchanged.
async function unmatchItem(s: PlexSession, cleanBundles: boolean): Promise<boolean> {
  const res = await safeFetchAdminConfigured(itemUrl(s, "/unmatch"), { method: "PUT", headers: s.headers, timeoutMs: 30_000 }).catch(() => null);
  if (cleanBundles) {
    await safeFetchAdminConfigured(`${s.serverUrl}/library/clean/bundles`, { method: "PUT", headers: s.headers, timeoutMs: 60_000 }).catch(() => null);
  }
  await pause(3_000);
  return res?.ok === true;
}

async function applyFirstMatch(
  s: PlexSession, chosen: ChosenMatch | null, target: PlexTarget, correctTmdbId: number, unmatched: boolean,
): Promise<void> {
  try {
    if (chosen) {
      const res = await applyPlexMatch(s, chosen.guid, chosen.name, chosen.year);
      if (!res.ok) throw new Error(`Plex fix-match failed with canonical guid: ${res.status}`);
      return;
    }
    const modern = await applyPlexMatch(s, `tmdb://${correctTmdbId}`, target.title, target.year);
    if (modern.ok) return;
    const legacy = await applyPlexMatch(s, legacyTmdbGuid(correctTmdbId), target.title, target.year);
    if (!legacy.ok) {
      throw new Error(`Plex fix-match failed: ${modern.status} (tmdb://), ${legacy.status} (legacy) — and match search returned no result for TMDB #${correctTmdbId}`);
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
}

type PlexPoll = { confirmed: boolean; conflated: boolean; plexTmdbId?: string; plexImdbId?: string };
type PlexRun = { s: PlexSession; progress: RemoteProgress; push: () => void; correctTmdbId: number; target: PlexTarget };

// Reads the item every `intervalMs` until Plex confirms the target, reports it
// conflated, or the attempts run out. The ids it last read are kept for the
// final verdict.
async function pollPlexConfirmation(run: PlexRun, maxAttempts: number, intervalMs: number): Promise<PlexPoll> {
  const { s, progress, push, correctTmdbId } = run;
  const imdbId = run.target.imdbId;
  progress.attempts = maxAttempts;
  progress.attempt = 0;
  push();
  let seen: Pick<PlexPoll, "plexTmdbId" | "plexImdbId"> = {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await pause(intervalMs);
    progress.attempt = attempt + 1;
    push();
    const res = await safeFetchAdminConfigured(itemUrl(s, "?includeGuids=1"), { headers: s.headers, timeoutMs: 10_000 }).catch(() => null);
    // A body that isn't JSON counts as a failed read, like a non-2xx: the
    // match is already applied, so it must not escape as a failure.
    const json = res?.ok ? await readJsonOrNull(res) : null;
    if (!isRecord(json)) {
      progress.readFailures++;
      push();
      continue;
    }
    const judged = judgePlexConfirmation(firstPlexMetadata(json), correctTmdbId, imdbId);
    seen = { plexTmdbId: judged.plexTmdbId, plexImdbId: judged.plexImdbId };
    if (judged.verdict === "tmdb") return { confirmed: true, conflated: false, ...seen };
    if (judged.verdict === "imdb") {
      console.warn("[fix-match]",
        `${s.tag} IMDB confirmed (imdb://${imdbId}) but Plex primary tmdb is ${seen.plexTmdbId} ` +
        `instead of ${correctTmdbId} — likely duplicate TMDB entries for same film. Treating as matched.`,
      );
      return { confirmed: true, conflated: false, ...seen };
    }
    if (judged.verdict === "conflated") {
      console.warn("[fix-match]",
        `${s.tag} Plex has both tmdb://${seen.plexTmdbId} (primary) and tmdb://${correctTmdbId} on the same hash — ` +
        `conflated IDs. Primary is wrong; breaking immediately to try legacy agent.`,
      );
      return { confirmed: false, conflated: true, ...seen };
    }
  }
  return { confirmed: false, conflated: false, ...seen };
}

// One fallback guid: applied, refreshed and polled. Null when Plex refused the
// apply (or it threw): the item's state is then whatever the last poll saw.
async function applyAndPoll(run: PlexRun, guid: string, name: string, year: string): Promise<PlexPoll | null> {
  const res = await applyPlexMatch(run.s, guid, name, year).catch(() => null);
  if (!res?.ok) return null;
  await refreshItem(run.s);
  return pollPlexConfirmation(run, 6, 5_000);
}

// The first match did not confirm and was not conflated: try the agent searches'
// results that NAME the target (at most MAX_FALLBACK_ATTEMPTS of them — each is
// applied live to the item and polled), then the legacy agent guid. Stops at the
// first poll that confirms or reports a conflation.
async function retryWithFallbacks(run: PlexRun, firstGuid: string | null, first: PlexPoll): Promise<PlexPoll> {
  const { correctTmdbId, target } = run;
  const searches = [
    ...(target.imdbId ? [imdbAgentSearch(target.imdbId)] : []),
    tmdbAgentSearch(correctTmdbId),
  ];
  const tried = new Set<string>(firstGuid ? [firstGuid] : []);
  let last = first;
  let attempts = 0;
  for (const params of searches) {
    if (attempts >= MAX_FALLBACK_ATTEMPTS) break;
    for (const raw of await plexMatchSearch(run.s, params)) {
      const c = asPlexSearchResult(raw);
      if (!c || tried.has(c.guid) || !candidateCarriesTarget(c, correctTmdbId, target.imdbId)) continue;
      if (attempts >= MAX_FALLBACK_ATTEMPTS) break;
      tried.add(c.guid);
      attempts++;
      const poll = await applyAndPoll(run, c.guid, c.name ?? target.title, c.year ? String(c.year) : target.year);
      if (!poll) continue;
      last = poll;
      if (poll.confirmed || poll.conflated) return last;
    }
  }
  return (await applyAndPoll(run, legacyTmdbGuid(correctTmdbId), target.title, target.year)) ?? last;
}

async function afterUnconfirmedFirstMatch(run: PlexRun, firstGuid: string | null, first: PlexPoll): Promise<PlexPoll> {
  const { s, correctTmdbId, target } = run;
  console.warn("[fix-match]",
    `${s.tag} modern match resolved to tmdb://${first.plexTmdbId ?? "?"} imdb://${first.plexImdbId ?? "?"} — ` +
    `our target is tmdb://${correctTmdbId} imdb://${target.imdbId || "unknown"}.`,
  );
  if (!first.conflated) return retryWithFallbacks(run, firstGuid, first);
  console.warn("[fix-match]",
    `${s.tag} conflated IDs detected on first poll — skipping fallback attempts. ` +
    `Plex has multiple metadata bundles on disk that conflict. ` +
    `The DB will be updated if IMDB confirms the correct film.`,
  );
  return first;
}

export type PlexRemapResult = { conflated: boolean; serverUrl: string; token: string };

function settlePlexOutcome(run: PlexRun, final: PlexPoll, unmatched: boolean): PlexRemapResult {
  const { s, correctTmdbId, target } = run;
  if (final.confirmed) return { conflated: false, serverUrl: s.serverUrl, token: s.token };
  if (final.conflated && target.imdbId && final.plexImdbId === target.imdbId) {
    console.warn("[fix-match]",
      `${s.tag} Plex has permanently merged tmdb://${final.plexTmdbId} and tmdb://${correctTmdbId} into one hash — ` +
      `IMDB ID ${target.imdbId} confirms this is the correct film. ` +
      `Accepting conflated match; DB will be updated to ${correctTmdbId}.`,
    );
    return { conflated: true, serverUrl: s.serverUrl, token: s.token };
  }
  const plexState = final.plexTmdbId
    ? `Plex resolved to tmdb://${final.plexTmdbId}${final.plexImdbId ? ` (imdb://${final.plexImdbId})` : ""}`
    : "Plex state unknown";
  if (unmatched) {
    throw new PlexUnmatchedError(
      `Plex did not confirm the match to tmdb://${correctTmdbId} — ${plexState}. ` +
      `Plex's metadata database may not have an entry for TMDB #${correctTmdbId}. ` +
      `Try a different candidate from the picker, or fix the match manually in Plex. The item is now UNMATCHED in Plex.`,
    );
  }
  throw new FixMatchDiagnosticError("apiAdmin.fixMatch.plexNotConfirmed", { tmdbId: correctTmdbId }, plexState);
}

export type FixPlexMatchOptions = {
  ratingKey: string;
  correctTmdbId: number;
  mediaType: "MOVIE" | "TV";
  instance: MediaInstanceKey;
  // A candidate the admin picked from the picker; without one the searches pick.
  preselectedGuid: string | undefined;
  report: FixMatchReport | undefined;
  // Run Plex's library-wide bundle clean between the unmatch and the first
  // match. Server-wide maintenance, so a multi-copy title asks for it on its
  // first copy only.
  cleanBundles: boolean;
};

/**
 * Remaps a Plex library item to the correct TMDB id: unmatch, re-match (via a
 * GUID search across imdb/tmdb agents, else a raw tmdb:// fallback), then poll
 * until Plex confirms — throws if it never confirms (PlexUnmatchedError once
 * the unmatch landed, else a diagnostic). Returns conflated=true when Plex has
 * permanently merged two TMDB ids into one hash but IMDB confirms the film.
 * Progress goes to `report` from the first step (phase "searching").
 */
export async function fixPlexMatch(opts: FixPlexMatchOptions): Promise<PlexRemapResult> {
  const { correctTmdbId } = opts;
  const { progress, push } = remoteProgress(opts.report);
  push();
  const s = await openPlexSession(opts.ratingKey, correctTmdbId, opts.instance);
  const target = await resolvePlexTarget(s, opts.mediaType, correctTmdbId);
  const chosen = opts.preselectedGuid
    ? { guid: opts.preselectedGuid, name: target.title, year: target.year }
    : await findCanonicalMatch(s, target, correctTmdbId);

  progress.phase = "applying";
  push();
  const unmatched = await unmatchItem(s, opts.cleanBundles);
  await applyFirstMatch(s, chosen, target, correctTmdbId, unmatched);
  // Best-effort, like the Jellyfin path's refresh: the match was already
  // APPLIED, and the confirmation poll is the sole success arbiter.
  await refreshItem(s);

  // The match was APPLIED; from here Summonarr only waits for Plex to confirm it.
  progress.remoteApplied = true;
  progress.phase = "confirming";
  push();
  const run: PlexRun = { s, progress, push, correctTmdbId, target };
  const first = await pollPlexConfirmation(run, 10, 3_000);
  const final = first.confirmed ? first : await afterUnconfirmedFirstMatch(run, chosen?.guid ?? null, first);
  return settlePlexOutcome(run, final, unmatched);
}

/** Which title a Plex rating key currently claims (classifyPlexCopy), or null when it could not be read. */
export async function plexCopyClaim(
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
  const item = firstPlexMetadata(await readJsonOrNull(res));
  return item ? classifyPlexCopy(item, oldTmdbId, correctTmdbId) : null;
}
