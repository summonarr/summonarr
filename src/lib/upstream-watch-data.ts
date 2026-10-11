// The media servers' OWN watch records — the snapshot job (guardrail 14d's
// evidence 5). Reads Plex's all-account watch history and every Jellyfin user's
// played/resumable items, folds them into per-title rows, and replaces this
// server's UpstreamWatchEvidence snapshot. The never-watched report and the
// cleanup rules read those rows as READ-ONLY evidence that a title WAS watched —
// catching plays from before Summonarr was installed, while it was down, or
// while tracking was off. The pure half (parsers, aggregation, agreement) and
// the UNVERIFIED upstream shapes are in upstream-watch.ts.
//
// Rules:
// - NEVER writes PlayHistory or ActiveSession (guardrail 19 — the live poller is
//   the sole history writer). The only writes are this server's evidence rows
//   and its status Setting.
// - Every server is isolated: one failing never stops or affects another.
// - A snapshot is written ONLY after a complete, successful fetch: a scoped
//   deleteMany + batchCreateMany inside ONE transaction (guardrails 4/13/35). A
//   failed or aborted server keeps its previous rows — a partial snapshot would
//   silently DROP evidence, and dropped evidence is how a watched title ends up
//   offered for deletion.
// - A self-check makes a broken parser loud instead of silent: `matched` (how
//   many rows land on a library title) and the AGREEMENT between the server's
//   records and the plays Summonarr itself recorded as completed. Both feed
//   upstreamHealth(), which the report shows beside every server.
// - Observes the AbortSignal between servers, between Jellyfin users and while
//   paging, and RETURNS on abort (guardrail 41).
import { prisma } from "./prisma";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "./cron-auth";
import { mapLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { getMediaInstances, getSyncableMediaInstances } from "./media-instance-registry";
import { mediaInstanceLabel } from "./media-instances";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { getPlexWatchHistory } from "./plex";
import { getJellyfinAllUsers, getJellyfinUserPlayedItems } from "./jellyfin";
import { parseUpstreamStatus, upstreamStatusKey } from "./never-watched-data";
import { upstreamHealth, type NwSource, type NwUpstreamHealth, type NwUpstreamStatus } from "./never-watched";
import {
  aggregateUpstream,
  agreementSince,
  computeAgreement,
  earliestViewed,
  safeUpstreamError,
  type JellyfinPlayedItem,
  type UpstreamEvidenceRow,
} from "./upstream-watch";

// Jellyfin users read at once (guardrail 31): each is two sequential page walks.
const JELLYFIN_USER_CONCURRENCY = 3;

export interface UpstreamServerResult {
  source: NwSource;
  instance: string;
  // This run's fetch succeeded and its snapshot was written.
  ok: boolean;
  // The stored status after this run (on a failure: the PREVIOUS snapshot's).
  entries: number;
  matched: number;
  samples: number;
  agreed: number;
  error: string | null;
  health: NwUpstreamHealth;
}

export interface UpstreamRefreshResult {
  servers: UpstreamServerResult[];
  // The run stopped on its AbortSignal; the server in progress was not written.
  aborted: boolean;
}

// Servers that failed, or whose snapshot the self-check marks failed/unreliable
// — the count the cron route degrades the run on.
export function upstreamRefreshProblems(result: UpstreamRefreshResult): number {
  return result.servers.filter((s) => !s.ok || s.health === "failed" || s.health === "unreliable").length;
}

interface Snapshot {
  // Watch records the server returned (status `entries`).
  records: number;
  rows: UpstreamEvidenceRow[];
  // The items' OWN keys (movie / episode), for the agreement check.
  rawItemKeys: Set<string>;
  // How far back the fetched records reach (Plex); null = no floor.
  floor: Date | null;
}

type FetchOutcome = Snapshot | "unconfigured";

async function plexSnapshot(slug: string, signal: AbortSignal | undefined): Promise<FetchOutcome> {
  const cfg = await getPlexConfig(slug);
  const url = cfg.url?.trim();
  const token = cfg.token?.trim();
  if (!url || !token) return "unconfigured";
  const history = await getPlexWatchHistory(url, token, { signal });
  if (history.truncated) {
    warnOnChange(
      `upstream-watch-truncated:${mediaInstanceLabel("plex", slug)}`,
      "truncated",
      `[upstream-watch] ${mediaInstanceLabel("plex", slug)}: watch history is longer than the read cap; only the most recent records were read`,
    );
  }
  return {
    records: history.records,
    rows: aggregateUpstream(history.entries),
    rawItemKeys: new Set(history.entries.map((e) => e.itemKey)),
    floor: earliestViewed(history.entries),
  };
}

// The same item in both lists (played, and now being re-watched) is ONE item for
// that user: the larger play count and the later date.
function mergeUserItem(prev: JellyfinPlayedItem, next: JellyfinPlayedItem): JellyfinPlayedItem {
  const later = next.lastPlayedAt && (!prev.lastPlayedAt || next.lastPlayedAt > prev.lastPlayedAt) ? next.lastPlayedAt : prev.lastPlayedAt;
  return { ...prev, playCount: Math.max(prev.playCount, next.playCount), lastPlayedAt: later };
}

async function jellyfinSnapshot(slug: string, signal: AbortSignal | undefined): Promise<FetchOutcome> {
  const cfg = await getJellyfinConfig(slug);
  const url = cfg.url?.trim();
  const apiKey = cfg.apiKey?.trim();
  if (!url || !apiKey) return "unconfigured";

  const users = await getJellyfinAllUsers(url, apiKey);
  // A server always has at least its admin. An empty 200 is a degraded read (a
  // de-elevated key, a truncating proxy) — writing it would wipe every user's
  // evidence (the guardrail-28 trap), so it is a failure.
  if (users.length === 0) throw new Error("Jellyfin returned no users");

  // One user failing fails the server (a snapshot missing a user drops their
  // evidence), and stops the others promptly instead of letting them run on.
  const stop = new AbortController();
  const forward = () => stop.abort();
  if (signal?.aborted) stop.abort();
  signal?.addEventListener("abort", forward, { once: true });
  let failed = false;
  let failure: unknown = null;
  let records = 0;
  const items: JellyfinPlayedItem[] = [];
  try {
    await mapLimit(users, JELLYFIN_USER_CONCURRENCY, async (user) => {
      if (stop.signal.aborted) return;
      try {
        const byItem = new Map<string, JellyfinPlayedItem>();
        for (const filter of ["IsPlayed", "IsResumable"] as const) {
          if (stop.signal.aborted) return;
          const res = await getJellyfinUserPlayedItems(url, apiKey, user.id, filter, { signal: stop.signal });
          records += res.records;
          for (const it of res.items) {
            const prev = byItem.get(it.itemKey);
            byItem.set(it.itemKey, prev ? mergeUserItem(prev, it) : it);
          }
        }
        if (!stop.signal.aborted) items.push(...byItem.values());
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
        stop.abort();
      }
    });
  } finally {
    signal?.removeEventListener("abort", forward);
  }
  if (failed) throw failure;
  return {
    records,
    rows: aggregateUpstream(items),
    rawItemKeys: new Set(items.map((i) => i.itemKey)),
    // Played flags are current state, not a dated log: no floor.
    floor: null,
  };
}

// Rows whose key lands on a library title of THIS server — both key columns
// (guardrails 37/37c: the singular canonical key OR any duplicate copy's key).
async function countMatched(source: NwSource, slug: string, rows: UpstreamEvidenceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const library: Array<{ mediaType: string; keys: Array<string | null> }> =
    source === "plex"
      ? (
          await prisma.plexLibraryItem.findMany({
            where: { serverInstance: slug },
            select: { mediaType: true, plexRatingKey: true, plexRatingKeys: true },
          })
        ).map((r) => ({ mediaType: r.mediaType, keys: [r.plexRatingKey, ...(r.plexRatingKeys ?? [])] }))
      : (
          await prisma.jellyfinLibraryItem.findMany({
            where: { serverInstance: slug },
            select: { mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
          })
        ).map((r) => ({ mediaType: r.mediaType, keys: [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])] }));
  const movies = new Set<string>();
  const shows = new Set<string>();
  for (const r of library) {
    const target = r.mediaType === "MOVIE" ? movies : r.mediaType === "TV" ? shows : null;
    if (!target) continue;
    for (const k of r.keys) if (k) target.add(k);
  }
  return rows.filter((r) => (r.mediaType === "MOVIE" ? movies : shows).has(r.itemKey)).length;
}

// Items Summonarr itself recorded as fully watched on this server since `since`.
async function recordedItemKeys(source: NwSource, slug: string, since: Date): Promise<Set<string>> {
  const rows = await prisma.playHistory.findMany({
    where: { source, serverInstance: slug, completed: true, startedAt: { gte: since }, sourceItemId: { not: null } },
    select: { sourceItemId: true },
    distinct: ["sourceItemId"],
  });
  const keys = new Set<string>();
  for (const r of rows) if (r.sourceItemId) keys.add(r.sourceItemId);
  return keys;
}

async function readStatus(source: NwSource, slug: string): Promise<NwUpstreamStatus | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: upstreamStatusKey(source, slug) } });
    return parseUpstreamStatus(row?.value);
  } catch {
    return null;
  }
}

// Never throws: the status is observability, and a failed write must not turn a
// refreshed snapshot into a failed run (or abort the servers after it).
async function writeStatus(source: NwSource, slug: string, status: NwUpstreamStatus): Promise<void> {
  const key = upstreamStatusKey(source, slug);
  const value = JSON.stringify(status);
  try {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch (err) {
    console.warn(
      `[upstream-watch] ${mediaInstanceLabel(source, slug)}: could not record the refresh status:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function resultOf(source: NwSource, slug: string, status: NwUpstreamStatus, now: Date): UpstreamServerResult {
  return {
    source,
    instance: slug,
    ok: status.ok,
    entries: status.entries,
    matched: status.matched,
    samples: status.samples,
    agreed: status.agreed,
    error: status.error,
    health: upstreamHealth(status, now),
  };
}

// An unhealthy server is a CONDITION recomputed every run — repeat-suppressed
// (guardrail 7b), and forgotten once it clears so a recurrence logs again.
function logHealth(source: NwSource, slug: string, result: UpstreamServerResult): void {
  const label = mediaInstanceLabel(source, slug);
  const key = `upstream-watch:${label}`;
  if (!result.ok) {
    warnOnChange(
      key,
      `failed|${result.error ?? ""}`,
      `[upstream-watch] ${label}: could not read the server's own watch records (${result.error ?? "unknown error"}); keeping the previous snapshot`,
    );
  } else if (result.health === "failed") {
    warnOnChange(
      key,
      "unmatched",
      `[upstream-watch] ${label}: the server returned watch records but none matched a library title — its response shape may have changed`,
    );
  } else if (result.health === "unreliable") {
    warnOnChange(
      key,
      "unreliable",
      `[upstream-watch] ${label}: fewer than half of the items Summonarr recorded as watched appear in the server's own watch records — they may be misread or incomplete`,
    );
  } else {
    forgetWarnOnChange(key);
  }
}

type ServerOutcome = UpstreamServerResult | "skipped" | "aborted";

async function refreshServer(
  source: NwSource,
  slug: string,
  signal: AbortSignal | undefined,
  fetchSnapshot: () => Promise<FetchOutcome>,
): Promise<ServerOutcome> {
  const now = new Date();
  let status: NwUpstreamStatus;
  try {
    const snapshot = await fetchSnapshot();
    if (snapshot === "unconfigured") return "skipped";
    if (signal?.aborted) return "aborted";
    const matched = await countMatched(source, slug, snapshot.rows);
    const recorded = await recordedItemKeys(source, slug, agreementSince(now, snapshot.floor));
    const { samples, agreed } = computeAgreement(recorded, snapshot.rawItemKeys);
    // Last check before the write: an aborted run writes nothing for the
    // server in progress (guardrail 41).
    if (signal?.aborted) return "aborted";
    await prisma.$transaction(
      async (tx) => {
        await tx.upstreamWatchEvidence.deleteMany({ where: { source, serverInstance: slug } });
        await batchCreateMany(
          tx.upstreamWatchEvidence,
          snapshot.rows.map((r) => ({
            source,
            serverInstance: slug,
            itemKey: r.itemKey,
            seasonNumber: r.seasonNumber,
            mediaType: r.mediaType,
            playCount: r.playCount,
            lastPlayedAt: r.lastPlayedAt,
            fetchedAt: now,
          })),
        );
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
    status = {
      fetchedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      ok: true,
      entries: snapshot.records,
      matched,
      samples,
      agreed,
      error: null,
    };
  } catch (err) {
    if (signal?.aborted) return "aborted";
    const prev = await readStatus(source, slug);
    status = {
      fetchedAt: prev?.fetchedAt ?? null,
      attemptedAt: now.toISOString(),
      ok: false,
      entries: prev?.entries ?? 0,
      matched: prev?.matched ?? 0,
      samples: prev?.samples ?? 0,
      agreed: prev?.agreed ?? 0,
      error: safeUpstreamError(err),
    };
  }
  await writeStatus(source, slug, status);
  const result = resultOf(source, slug, status, now);
  logHealth(source, slug, result);
  return result;
}

export async function refreshUpstreamWatch({ signal }: { signal?: AbortSignal } = {}): Promise<UpstreamRefreshResult> {
  const servers: UpstreamServerResult[] = [];
  const run = async (source: NwSource, slug: string, fetchSnapshot: () => Promise<FetchOutcome>): Promise<boolean> => {
    if (signal?.aborted) return false;
    const outcome = await refreshServer(source, slug, signal, fetchSnapshot);
    if (outcome === "aborted") return false;
    if (outcome !== "skipped") servers.push(outcome);
    return true;
  };

  // Plex: the registry + getPlexConfig's findUnique reads and a skip-if-
  // unconfigured, never getSyncableMediaInstances (guardrail 35's Plex note).
  for (const instance of await getMediaInstances("plex")) {
    if (!(await run("plex", instance.slug, () => plexSnapshot(instance.slug, signal)))) return { servers, aborted: true };
  }
  if (signal?.aborted) return { servers, aborted: true };
  for (const instance of await getSyncableMediaInstances("jellyfin")) {
    if (!(await run("jellyfin", instance.slug, () => jellyfinSnapshot(instance.slug, signal)))) return { servers, aborted: true };
  }
  return { servers, aborted: false };
}
