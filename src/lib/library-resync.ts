// Shared pieces of the per-source library Resync routes (/api/sync/plex and
// /api/sync/jellyfin) and the library sync's selection parsing, which the
// orchestrator and /api/sync/tv-episodes read the same way.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, type MediaInstanceKey } from "@/lib/media-instances";
import { warnOnChange, forgetWarnOnChange } from "@/lib/log-dedup";
import { logAudit } from "@/lib/audit";
import type { CronActor } from "@/lib/cron-auth";
import type { Translator } from "@/lib/i18n/translate";

// A recent-only Resync reads the last 2 hours: wider than the 1h sync interval,
// so one missed run is survivable (guardrail 13's recentOnly window).
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * A server's saved library selection (comma-separated section keys / library
 * ids). Unset or empty ⇒ undefined ⇒ every library on that server; every
 * reader treats an empty set the same way. A selection is per server: a Plex
 * section key means nothing on another server. Pure.
 */
export function parseLibrarySelection(value: string | null | undefined): Set<string> | undefined {
  if (!value) return undefined;
  const parsed = new Set(value.split(",").map((k) => k.trim()).filter(Boolean));
  return parsed.size > 0 ? parsed : undefined;
}

/**
 * What a Resync body asks for: `{ full: true }` is the ONLY full replace
 * (anything else is recent-only, guardrail 13), and `instance` names the
 * server (absent ⇒ the default, so existing callers are unchanged). A malformed
 * slug is null — rejected, never coerced to "", which would aim a destructive
 * scoped delete at the wrong server. Pure.
 */
export function resyncTarget(rawBody: Record<string, unknown>): { recentOnly: boolean; instance: MediaInstanceKey } | null {
  const instance: MediaInstanceKey = typeof rawBody.instance === "string" ? rawBody.instance : DEFAULT_MEDIA_INSTANCE;
  if (instance !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(instance)) return null;
  return { recentOnly: rawBody.full !== true, instance };
}

/** The background-job key of one Resync (library-sync-jobs.ts): same server + mode ⇒ same job. */
export function resyncJobKey(service: "plex" | "jellyfin", rawBody: Record<string, unknown>): string {
  return `${service}\u0000${JSON.stringify([rawBody.instance ?? null, rawBody.full === true])}`;
}

// A Resync that lost its lock stops at a phase boundary (guardrail 41). The
// answer is discarded on a timeout (the lock race already settled); a dropped
// lock connection returns it.
export function resyncWindDownResponse(t: Translator): Response {
  return NextResponse.json({ error: t("apiAdmin.sync.windDown") }, { status: 503 });
}

/**
 * TVEpisodeCache has no serverInstance column, so a Resync of one server owns
 * the shared cache only when it is the ONLY registered server of its type; with
 * more, it leaves the cache to the orchestrator, which rebuilds it from every
 * server. Counting REGISTERED servers is the safe error: a registered but
 * unconfigured one has nothing to contribute, so at worst a rewrite the
 * orchestrator does anyway is skipped. Pure.
 */
export function ownsEpisodeCache(registeredServers: number): boolean {
  return registeredServers <= 1;
}

/** That standing configuration, restated on every Resync: logged once per server count (guardrail 7b). */
export function noteEpisodeCacheOwner(service: "plex" | "jellyfin", registeredServers: number): void {
  const key = `sync/${service}:episode-cache-owner`;
  if (ownsEpisodeCache(registeredServers)) {
    forgetWarnOnChange(key);
    return;
  }
  const label = service === "plex" ? "Plex" : "Jellyfin";
  warnOnChange(
    key,
    String(registeredServers),
    `[sync/${service}] ${registeredServers} ${label} servers configured — leaving the shared TVEpisodeCache to the orchestrator, which rebuilds it from every server.`,
  );
}

/**
 * Stamps `last<Source>SyncSucceededAt`, which the orchestrator's 24h stale
 * fallback reads (its notify fallback for a source that keeps failing). Callers
 * stamp ONLY a complete picture of every server of the type. Best-effort.
 */
export async function stampLibrarySyncSuccess(source: "plex" | "jellyfin", logScope: string): Promise<void> {
  const key = source === "plex" ? "lastPlexSyncSucceededAt" : "lastJellyfinSyncSucceededAt";
  const value = String(Date.now());
  await prisma.setting
    .upsert({ where: { key }, update: { value }, create: { key, value } })
    .catch((err) => console.error(`[${logScope}] failed to stamp ${key}:`, err));
}

/**
 * Whether a finished Resync is the shape the orchestrator's own success stamp
 * means: a FULL replace of the DEFAULT instance when it is the ONLY registered
 * server of its type. A named instance's resync says nothing about the default
 * server the stale fallback waits on (an hourly named-instance call would keep
 * the stamp fresh while the default stayed down), the default's says nothing
 * about a named server that is down, and a recentOnly run is not a complete
 * picture of the library. Pure.
 */
export function stampsOrchestratorSuccess(run: {
  instance: MediaInstanceKey;
  recentOnly: boolean;
  registeredServers: number;
}): boolean {
  return run.instance === DEFAULT_MEDIA_INSTANCE && !run.recentOnly && run.registeredServers <= 1;
}

/** Stamps last-success when the run is the shape `stampsOrchestratorSuccess` accepts. */
export async function stampResyncSuccess(
  source: "plex" | "jellyfin",
  run: { instance: MediaInstanceKey; recentOnly: boolean; registeredServers: number },
): Promise<void> {
  if (stampsOrchestratorSuccess(run)) await stampLibrarySyncSuccess(source, `sync/${source}`);
}

/**
 * The tail both Resync routes share: the LIBRARY_SYNC audit row (admin-driven
 * runs only — attribution comes from the DB-checked read that authorized the
 * request, and a CRON_SECRET run has no session to attribute; `full` lets the
 * audit log tell a full replace from an incremental add) and the answer body.
 */
export function finishResync(
  source: "plex" | "jellyfin",
  actor: CronActor,
  result: { movies: number; tv: number; checked: number; marked: number; recentOnly: boolean },
): Response {
  const { movies, tv, checked, marked, recentOnly } = result;
  if (actor.trigger === "admin") {
    void logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "LIBRARY_SYNC",
      target: `sync:${source}`,
      details: { movies, tv, marked, full: !recentOnly },
    });
  }
  return NextResponse.json({ scanned: { movies, tv }, checked, marked, full: !recentOnly });
}

/**
 * The stored rows on this server an incoming batch re-identifies: every copy
 * they hold (`jellyfinItemId` plus `jellyfinItemIds`, guardrail 37) now arrives
 * under another title. A row that keeps even one copy the batch does not name
 * is still that title on this server and stays. Pure.
 */
export function reidentifiedJellyfinRows<R extends { jellyfinItemId: string | null; jellyfinItemIds: string[] }>(
  holders: readonly R[],
  incomingItemIds: ReadonlySet<string>,
): R[] {
  return holders.filter((h) => {
    const ids = h.jellyfinItemId ? [h.jellyfinItemId, ...h.jellyfinItemIds] : h.jellyfinItemIds;
    return ids.length > 0 && ids.every((id) => incomingItemIds.has(id));
  });
}

/** Registers background work the Resync's lock must outlive. */
export type HoldLock = (work: Promise<unknown>) => void;

/**
 * withAdvisoryLock for a Resync that answers before all of its work is done.
 * The caller gets `work`'s answer as soon as it has one, but the lock stays
 * held until every promise passed to `hold` has settled — the episode-cache
 * refresh, which crawls the whole TV library. Before, that crawl ran detached
 * after the lock was released, so back-to-back Resyncs stacked crawls and an
 * older one could land after a newer one. Now a second Resync during the crawl
 * skips (onBusy), and the crawl sees the lock's abort signal (guardrail 41).
 * Held work logs its own failures; holding the lock is all it is awaited for.
 */
export function runResyncHoldingLock(
  lockId: number,
  work: (signal: AbortSignal, hold: HoldLock) => Promise<Response>,
  onBusy: () => Response,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    withAdvisoryLock(
      lockId,
      async (signal: AbortSignal) => {
        const held: Promise<unknown>[] = [];
        try {
          const answer = await work(signal, (p) => { held.push(p.catch(() => {})); });
          resolve(answer);
          return answer;
        } catch (err) {
          reject(err);
          throw err;
        } finally {
          await Promise.all(held);
        }
      },
      onBusy,
    ).then(resolve, reject);
  });
}
