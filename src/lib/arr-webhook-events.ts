// The event handling the Radarr and Sonarr webhooks share past authentication
// (arr-webhook.ts holds that half): the ManualInteractionRequired one-shot
// alert, its marker, and the "now available" poll after an import. Each route
// keeps only what differs between the two services. Route files may export only
// HTTP handlers, so the shared code lives here.
import { after } from "next/server";
import { prisma } from "./prisma";
import { emitNotificationEvent } from "./notify-agents";
import { notifyAdminsManualInteractionRequiredPush } from "./push";
import type { ArrInstanceConfig, ArrService } from "./arr-instances";
import { pollAndNotifyAvailable } from "./request-notifications";
import { getMediaInstances } from "./media-instance-registry";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { hasPlexItemByTmdbId } from "./plex";
import { hasJellyfinItemByTmdbId } from "./jellyfin";
import type { MediaServerService } from "./media-instances";

const SERVICE_NAME: Record<ArrService, "Radarr" | "Sonarr"> = { radarr: "Radarr", sonarr: "Sonarr" };

// The one-shot markers' shared prefix: what the 30-day prune matches, for both
// services, whichever fires it.
const MANUAL_MARKER_PREFIX = "manualInteractionNotified:";
const MANUAL_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The longest title a ManualInteractionRequired alert carries. */
export const MAX_MANUAL_INTERACTION_TITLE = 200;

/**
 * The alert's title as it is sent on. The text is the payload's (remote,
 * vouched for only by the webhook secret) and goes to every admin's devices and
 * the outbound agents: control characters out, whitespace collapsed, bounded —
 * the same treatment a Health message gets (arr-health-notify.ts).
 */
export function manualInteractionTitle(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_MANUAL_INTERACTION_TITLE ? `${cleaned.slice(0, MAX_MANUAL_INTERACTION_TITLE - 1)}…` : cleaned;
}

/**
 * The ManualInteractionRequired marker of one stuck item, keyed on its STABLE
 * id on the firing instance — never the volatile queue id or progress. Radarr
 * keys on the tmdbId; Sonarr on `tvdb:<id>` (or `tmdb:<id>`) with the id TYPE in
 * the key, because the two id spaces overlap.
 */
export function manualInteractionMarkerKey(service: ArrService, arrInstance: string, stableId: string | number): string {
  return `${MANUAL_MARKER_PREFIX}${service}:${arrInstance}:${stableId}`;
}

/**
 * Alert the admins that an import is parked waiting for them — once per stuck
 * item. The arr re-emits ManualInteractionRequired for the same parked release
 * on every queue tick, and the replay digest hashes the whole payload (whose
 * queue id/progress change each time), so the marker row is the one-shot gate:
 * createMany(skipDuplicates) claims it for exactly one delivery. With no stable
 * id (`markerKey` null) nothing is claimed and nothing is sent — a fallback that
 * notified would re-fire on every tick.
 *
 * The push and outbound event run after the response, chained with the prune
 * that bounds the marker table: one deferred unit of work per fresh claim.
 * The title is remote-controlled text: it reaches the admins through the
 * structured push, never a log line, and only as manualInteractionTitle leaves it.
 */
export async function notifyManualInteractionOnce(opts: {
  service: ArrService;
  arrInstance: string;
  instances: readonly ArrInstanceConfig[];
  markerKey: string | null;
  title: string;
}): Promise<void> {
  const scope = `[webhook/${opts.service}]`;
  console.warn(`${scope} manual interaction required — resolve it in ${SERVICE_NAME[opts.service]}'s queue`);
  if (opts.markerKey === null) return;
  const claim = await prisma.setting.createMany({
    data: [{ key: opts.markerKey, value: new Date().toISOString() }],
    skipDuplicates: true,
  });
  if (claim.count !== 1) return;
  const instanceName = opts.instances.find((i) => i.slug === opts.arrInstance)?.name;
  const title = manualInteractionTitle(opts.title) || "An import";
  after(async () => {
    emitNotificationEvent({ event: "arr.manual_interaction", text: `${SERVICE_NAME[opts.service]}: ${title}`, request: { instance: opts.arrInstance } });
    await notifyAdminsManualInteractionRequiredPush({ service: SERVICE_NAME[opts.service], title, instanceName })
      .catch((err) => console.warn(`${scope} manual-interaction alert failed:`, err));
    // A marker row is inserted per distinct stuck item and never removed, so
    // prune those older than 30 days — ISO-8601 values sort lexically =
    // chronologically. An item still stuck past the window simply re-notifies.
    // Prefix-scoped, so whichever service is deployed cleans both.
    await prisma.setting
      .deleteMany({
        where: {
          key: { startsWith: MANUAL_MARKER_PREFIX },
          value: { lt: new Date(Date.now() - MANUAL_MARKER_TTL_MS).toISOString() },
        },
      })
      .catch((err) => console.warn(`${scope} manual-interaction marker prune failed:`, err));
  });
}

/**
 * A completed import ends the "stuck" episode a marker one-shots: clear it so
 * a FUTURE re-park of the same item can alert again (the marker otherwise only
 * ages out through the prune). Post-commit fire-and-forget, idempotent.
 */
export function clearManualInteractionMarkers(keys: readonly string[]): void {
  if (keys.length === 0) return;
  void prisma.setting.deleteMany({ where: { key: { in: [...keys] } } }).catch(() => {});
}

type AvailabilityCheck = (() => Promise<boolean>) | null;

/**
 * "Is the title in a Plex / Jellyfin library yet?" for the post-import poll —
 * across every configured server of each type that EVERY user can see.
 * pollAndNotifyAvailable folds presence into one boolean per type, which is
 * sound only while a `true` means "on a server this requester can see" for
 * every requester (request-notifications.ts). A RESTRICTED server's library
 * counts only for users granted it (guardrail 35), so it is never probed here;
 * the sync's own sweep, which applies the grants, notifies from it. null for a
 * type with no such server.
 */
export async function visibleAvailabilityChecks(
  tmdbId: number,
  kind: "movie" | "tv",
): Promise<{ checkPlex: AvailabilityCheck; checkJellyfin: AvailabilityCheck }> {
  const [plex, jellyfin] = await Promise.all([
    probeTargets("plex", async (slug) => {
      const { url, token } = await getPlexConfig(slug);
      return url && token ? { url, secret: token } : null;
    }),
    probeTargets("jellyfin", async (slug) => {
      const { url, apiKey } = await getJellyfinConfig(slug);
      return url && apiKey ? { url, secret: apiKey } : null;
    }),
  ]);
  return {
    checkPlex: anyHolds(plex, (t) => hasPlexItemByTmdbId(t.url, t.secret, tmdbId, kind)),
    checkJellyfin: anyHolds(jellyfin, (t) => hasJellyfinItemByTmdbId(t.url, t.secret, tmdbId, kind)),
  };
}

type ProbeTarget = { url: string; secret: string };

// The configured, unrestricted servers of one type, in registry order (the
// default first). Single-key config reads, like every webhook read before.
async function probeTargets(
  service: MediaServerService,
  load: (slug: string) => Promise<ProbeTarget | null>,
): Promise<ProbeTarget[]> {
  const out: ProbeTarget[] = [];
  for (const instance of await getMediaInstances(service)) {
    if (instance.restricted) continue;
    const target = await load(instance.slug);
    if (target) out.push(target);
  }
  return out;
}

// True as soon as one server holds the title. A server that fails is skipped
// while the others are asked; only when none holds it and one failed does the
// failure surface (the poll counts it as one missed attempt).
function anyHolds(targets: readonly ProbeTarget[], holds: (t: ProbeTarget) => Promise<boolean>): AvailabilityCheck {
  if (targets.length === 0) return null;
  return async () => {
    let failure: unknown = null;
    for (const target of targets) {
      try {
        if (await holds(target)) return true;
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== null) throw failure;
    return false;
  };
}

/**
 * After an import flipped requests AVAILABLE: poll the media servers until the
 * title shows up, then tell each requester (pollAndNotifyAvailable — the CAS on
 * notifiedAvailable makes it once, guardrail 14). `where` must scope to the
 * firing instance (guardrail 32): one instance's Download must not notify a
 * sibling instance's request off the wrong grab. `arrInstance` is selected so
 * the outbound `request.available` event names it off each winner row.
 * `tmdbIdForCheck` null → the pending rows' own tmdbId.
 */
export async function notifyAvailableAfterImport(opts: {
  where: { mediaType: "MOVIE" | "TV"; arrInstance: string } & ({ tmdbId: number } | { tvdbId: number });
  kind: "movie" | "tv";
  tmdbIdForCheck: number | null;
  logScope: string;
}): Promise<void> {
  const pending = await prisma.mediaRequest.findMany({
    where: { ...opts.where, status: "AVAILABLE", notifiedAvailable: false },
    select: { id: true, tmdbId: true, requestedBy: true, title: true, mediaType: true, posterPath: true, arrInstance: true, user: { select: { mediaServer: true } } },
  });
  if (pending.length === 0) return;
  // Rows matched by tvdbId can disagree on tmdbId (a bad match, a legacy row):
  // each group is probed for its own title, never for the first row's.
  const groups = new Map<number, typeof pending>();
  for (const row of pending) {
    const tmdbId = opts.tmdbIdForCheck ?? row.tmdbId;
    if (!tmdbId) continue;
    const group = groups.get(tmdbId);
    if (group) group.push(row);
    else groups.set(tmdbId, [row]);
  }
  for (const [tmdbId, rows] of groups) {
    const { checkPlex, checkJellyfin } = await visibleAvailabilityChecks(tmdbId, opts.kind);
    await pollAndNotifyAvailable(rows, checkPlex, checkJellyfin, opts.logScope)
      .catch((err) => { console.warn(`[${opts.logScope}] notification failed after marking AVAILABLE:`, err); });
  }
}
