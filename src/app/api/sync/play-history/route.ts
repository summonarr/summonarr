import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import {
  isPlayHistoryEnabled,
  isSourceEnabled,
  cleanupStaleSessions,
  purgeOldHistory,
  emitActiveSessionsSnapshot,
  reanchorActiveSessionsOnBoot,
} from "@/lib/play-history";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getPlexConfig } from "@/lib/plex-config";
import { type MediaInstanceKey, mediaInstanceLabel } from "@/lib/media-instances";
import { getMediaInstances, getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { emitSSE } from "@/lib/sse-emitter";
import { evaluateConcurrentStreams } from "@/lib/stream-limit-data";
import { isCronAuthorized } from "@/lib/cron-auth";
import { withCronRunRecording } from "@/lib/cron-history";
import { claimCooldownSlot } from "@/lib/warm-cooldown";
import { reconcilePlexEventStream, stopAllPlexEventStreams } from "@/lib/plex-events";
import { trimServerBase } from "@/lib/server-url";
import type { SyncResult } from "@/lib/session-poll-shared";
import { syncPlexSessions } from "@/lib/session-poll-plex";
import { syncJellyfinSessions } from "@/lib/session-poll-jellyfin";

// The 5s play-history poller. Each configured Plex and Jellyfin server's
// session snapshot is written by its pass (session-poll-plex.ts,
// session-poll-jellyfin.ts); this route authorizes, runs the passes side by
// side, then the run's housekeeping.

// One server's (or one housekeeping step's) entry in the answer: its counts,
// or the error that degraded it.
type SourceOutcome = SyncResult | { error: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Before the run ledger: a burst of overlapping ticks refused here is not a
  // failed run, and withCronRunRecording records any 4xx as one.
  if (!checkRateLimit(`sync-ph:${getClientIpKey(request.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  return withCronRunRecording("play-history-sync", () => syncPlayHistory());
}

async function syncPlayHistory() {
  if (!(await isPlayHistoryEnabled())) {
    // Tear the SSE streams down rather than just declining to poll. This early return is
    // BEFORE the reconcile below, so a stream opened while tracking was on would stay open
    // and keep writing PlayHistory + ActiveSession rows from Plex timeline events after the
    // admin turned tracking off. Idempotent; the next enabled tick re-creates the managers
    // via the normal reconcile.
    stopAllPlexEventStreams();
    return NextResponse.json({ message: "Play history tracking is disabled" });
  }

  // Fire-and-forget: idempotently keep the Plex SSE connection in sync with
  // current Settings. If the URL/token didn't change and the connection is up,
  // this is a near-no-op; if settings were edited via the admin UI we pick up
  // the change within one poll tick.
  reconcilePlexEventStream().catch((err) => {
    console.warn("[plex-events] reconcile failed:", err);
  });

  // Keyed by server label (plex, plex:<slug>, jellyfin, jellyfin:<slug>) and
  // post-sync:<step>; `purged` rides beside them when the retention purge ran.
  const results: Record<string, SourceOutcome> = {};
  let purged = 0;

  try {
    // Boot re-anchor (once per process, no-op afterwards): give every existing
    // ActiveSession a fresh absence-grace window measured from now, so a
    // restart's downtime doesn't make this run's stale sweep finalize a session
    // that's still playing. Covers Plex AND Jellyfin in one write; if the SSE
    // bootstrap already ran it, this is a no-op. Must run before the source
    // syncs read their ActiveSession rows below.
    // Reports rather than throws: a throw here would abort the whole tick before
    // either source loop. On failure the sweeps below are skipped instead, since
    // their grace would be measured off pre-restart anchors (guardrail 21).
    const reanchored = await reanchorActiveSessionsOnBoot();
    // Every row a server reports this tick is stamped at or after this, so the
    // stream-limit alert counts exactly the sessions seen this tick (not an ended
    // one lingering in its absence grace). Taken AFTER the re-anchor, whose boot
    // stamp must not make every leftover row look live.
    const tickStartedAt = new Date();

    const [plexEnabled, jellyfinEnabled] = await Promise.all([
      isSourceEnabled("plex"),
      isSourceEnabled("jellyfin"),
    ]);
    // The servers' passes run concurrently; each config is read one after another.
    const passes: Promise<void>[] = [];
    if (plexEnabled) await queuePlexPasses(reanchored, results, passes);
    if (jellyfinEnabled) await queueJellyfinPasses(reanchored, results, passes);
    await Promise.all(passes);

    // Single batched activity:history-updated after every source loop completes
    // (one entry per configured Plex and Jellyfin instance). recordCompletedSession
    // is called with skipSSE inside each pass to avoid N+1 events. Emit only when
    // at least one session actually ended.
    const totalEnded = Object.values(results).reduce((sum, r) => sum + ("ended" in r ? r.ended : 0), 0);
    if (totalEnded > 0) {
      emitSSE({ type: "activity:history-updated" });
    }

    // The sessions are written by now. A failing housekeeping step below degrades
    // the run (its `post-sync:<step>` key reaches X-Cron-Degraded) instead of
    // 500ing it and dropping every source's result; the next tick runs it again.
    const postSync = async (step: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        const msg = errorText(err);
        console.warn(`[play-history] post-sync ${step} failed:`, msg);
        results[`post-sync:${step}`] = { error: msg };
      }
    };

    await postSync("snapshot", () => emitActiveSessionsSnapshot());
    // Never throws: an alert failure must not fail the poll.
    await evaluateConcurrentStreams(tickStartedAt);

    // Guardrail 21: cleanupStaleSessions measures off lastSeenAt exactly like
    // the two per-source absence sweeps, which skip when the boot re-anchor
    // failed — hold this third finalize path to the same gate, or a failed
    // re-anchor after a >30min outage finalizes still-playing sessions.
    if (reanchored) await postSync("cleanup", () => cleanupStaleSessions(30));

    await postSync("retention", async () => {
      const now = Date.now();

      // Atomic CAS: only the first caller within a 1-hour window performs the
      // retention purge. A non-numeric or over-long stored value (a manual edit)
      // reads as expired instead of crashing the route (claimCooldownSlot).
      // A failed purge keeps the claim: releasing it would retry a failing delete
      // every 5s instead of once an hour.
      if (await claimCooldownSlot("lastRetentionCheckAt", 3600_000, now)) {
        purged = await purgeOldHistory();
      }
    });
  } catch (err) {
    console.error("[sync-play-history]", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  // Surface degraded runs to withCronRunRecording via the X-Cron-Degraded header,
  // so a failed source shows up on the admin System tab. Status stays 200 — this route runs every 5s from the
  // entrypoint poller, and a non-2xx during a media-server outage would spam the
  // docker logs with a failure line per tick.
  const degraded = Object.entries(results).filter(([, r]) => "error" in r).map(([key]) => key);
  return NextResponse.json(
    { ...results, ...(purged > 0 ? { purged } : {}) },
    degraded.length > 0 ? { headers: { "X-Cron-Degraded": degraded.join(",") } } : undefined,
  );
}

// Queue one pass per configured Plex server. ONE deliberate difference from the
// Jellyfin loop (guardrail 35): the instance list comes from getMediaInstances (a
// single registry findUnique on `plexInstances`) + a per-instance getPlexConfig
// read (two findUniques) + the skip-if-unconfigured `continue` below — NOT
// getSyncableMediaInstances, whose isMediaInstanceConfigured check issues a
// connection-keys findMany byte-identical in shape to plex-events' own
// per-manager doReconcile read. The route's test harness starves plex-events'
// reads BY SHAPE (any findMany over plex connection keys) so reconcile never
// opens a real SSE stream under test; the route's own config reads must
// therefore stay findUnique-shaped. The `continue` reproduces
// getSyncableMediaInstances' filter semantics exactly.
async function queuePlexPasses(reanchored: boolean, results: Record<string, SourceOutcome>, passes: Promise<void>[]): Promise<void> {
  for (const instance of await getMediaInstances("plex")) {
    const cfg = await readConfig("Plex", instance.slug, results, async () => {
      const { url, token } = await getPlexConfig(instance.slug);
      return url && token ? { url, secret: token } : null;
    });
    if (!cfg) continue; // unconfigured instance — the getSyncableMediaInstances-equivalent filter (see above)
    passes.push(recordPass("Plex", instance.slug, results, () => syncPlexSessions(instance.slug, cfg.url, cfg.secret, reanchored)));
  }
}

async function queueJellyfinPasses(reanchored: boolean, results: Record<string, SourceOutcome>, passes: Promise<void>[]): Promise<void> {
  for (const instance of await getSyncableMediaInstances("jellyfin")) {
    const cfg = await readConfig("Jellyfin", instance.slug, results, async () => {
      const { url, apiKey } = await getJellyfinConfig(instance.slug);
      return url && apiKey ? { url, secret: apiKey } : null;
    });
    if (!cfg) continue; // defensive; getSyncableMediaInstances already filters to configured ones
    passes.push(recordPass("Jellyfin", instance.slug, results, () => syncJellyfinSessions(instance.slug, cfg.url, cfg.secret, reanchored)));
  }
}

// One instance's connection, its URL trimmed. A config-read failure is isolated
// to just this instance: an uncaught throw would abort the loop and 500 the
// whole poll tick, discarding every other instance's already-queued result over
// a transient blip on one Settings read.
async function readConfig(
  service: "Plex" | "Jellyfin",
  slug: MediaInstanceKey,
  results: Record<string, SourceOutcome>,
  load: () => Promise<{ url: string; secret: string } | null>,
): Promise<{ url: string; secret: string } | null> {
  try {
    const cfg = await load();
    return cfg && { url: trimServerBase(cfg.url), secret: cfg.secret };
  } catch (err) {
    const msg = errorText(err);
    console.warn(`[play-history] ${service} config read failed for instance "${slug}":`, msg);
    results[mediaInstanceLabel(service === "Plex" ? "plex" : "jellyfin", slug)] = { error: msg };
    return null;
  }
}

// One server's pass, its counts or its failure recorded under its label.
function recordPass(
  service: "Plex" | "Jellyfin",
  slug: MediaInstanceKey,
  results: Record<string, SourceOutcome>,
  run: () => Promise<SyncResult>,
): Promise<void> {
  const label = mediaInstanceLabel(service === "Plex" ? "plex" : "jellyfin", slug);
  return run()
    .then((r) => { results[label] = r; })
    .catch((err) => {
      const msg = errorText(err);
      console.warn(`[play-history] ${service} session sync failed for instance "${slug}":`, msg);
      results[label] = { error: msg };
    });
}
