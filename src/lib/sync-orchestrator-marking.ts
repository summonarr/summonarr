// Sync orchestrator (sync-orchestrator.ts): everything after the library
// writes — the de-registered sweep, coverage, per-requester visibility, the
// AVAILABLE revert, library marking and the pending-notify fallback.
import { prisma } from "./prisma";
import { getMediaInstances, type MediaInstanceConfig } from "./media-instance-registry";
import { DEFAULT_MEDIA_INSTANCE } from "./media-instances";
import { sonarrIncompleteKeys } from "./arr-availability";
import { claimAvailableNotifications, clearDeletionVotesForTmdbs } from "./notify-available";
import { fanOutAvailableWinners } from "./request-notifications";
import { PENDING_REQUEST_SELECT, createRequesterCache, fallbackShouldNotify, inLibrary, markAvailableFromLibrary, readPendingRequests, requesterPermissions, withoutSonarrHeld, type LibrarySource, type PendingRequest } from "./available-marking";
import { getArrInstances } from "./arr-instance-registry";
import { FOURK_ARR_INSTANCE } from "./arr-instances";
import { parseMediaServerGrants } from "./permissions";
import { visibleInstancesFor, type VisibleServerInstances } from "./media-visibility";
import { warnOnChange, forgetWarnOnChange } from "./log-dedup";
import { vkey, type SyncFlags, type AvailableRow } from "./sync-orchestrator-shared";
import { type ArrRefresh, arrInstanceRefreshed, type ArrPresence } from "./sync-orchestrator-arr";
import { type LibraryTargets, type LibraryArm } from "./sync-orchestrator-libraries";

// Returns the REGISTERED media servers, read once after the library writes and
// shared with the demote guard.
export async function sweepDeregistered(): Promise<{ registeredPlex: MediaInstanceConfig[]; registeredJellyfin: MediaInstanceConfig[] }> {
  // Sweep library rows belonging to servers that are no longer REGISTERED.
  //
  // Availability readers are an unscoped union across every row, and no sync
  // path ever targets a de-registered slug again — so an orphaned row makes
  // that server's whole catalogue read "in library" forever (guardrail 35).
  // /api/admin/media-instances deletes on removal, but two cases slip past it:
  // a removal that lands DURING this run (the arms above captured the instance
  // list before their multi-minute library walk, so the write can re-insert
  // rows for a slug removed in the meantime), and rows orphaned by a release
  // that predates that cleanup. Re-reading the registry here — after the
  // writes, in the same run — closes both.
  //
  // Scoped to REGISTERED (getMediaInstances), never merely syncable: an
  // instance that is registered but temporarily unconfigured (an admin
  // mid-edit, a blanked token) must keep its rows, exactly as the arms above
  // leave a failed instance's rows intact.
  //
  // Read ONCE here, after the library writes, and shared with the demote guard
  // below (which needs the same REGISTERED set, for the same reason).
  const [registeredPlex, registeredJellyfin] = await Promise.all([
    getMediaInstances("plex"),
    getMediaInstances("jellyfin"),
  ]);
  try {
    const [orphanedPlex, orphanedJellyfin] = await Promise.all([
      prisma.plexLibraryItem.deleteMany({ where: { serverInstance: { notIn: registeredPlex.map((i) => i.slug) } } }),
      prisma.jellyfinLibraryItem.deleteMany({ where: { serverInstance: { notIn: registeredJellyfin.map((i) => i.slug) } } }),
    ]);
    if (orphanedPlex.count > 0 || orphanedJellyfin.count > 0) {
      console.warn(
        `[sync] Swept library rows for de-registered servers — plex: ${orphanedPlex.count}, jellyfin: ${orphanedJellyfin.count}`,
      );
    }
  } catch (err) {
    console.error("[sync] De-registered-instance sweep failed:", err);
  }

  // The same sweep for *arr instances. /api/admin/arr-instances purges on
  // removal, but that cleanup is diff-driven — it can only recognise a slug as
  // "just removed" in the one request where the registry stops listing it, so a
  // failure partway through that request orphans the rows permanently, with no
  // later request able to see them. These tables feed the availability union
  // unscoped exactly like the library tables above, so an orphan makes its
  // titles read "in *arr" forever.
  //
  // getArrInstances is the REGISTERED reader (and synthesizes the default ""
  // slug), never getSyncableArrInstances — an instance that is registered but
  // temporarily unconfigured must keep its rows, same rationale as above.
  //
  // The legacy "4k" slug is the one exception to "registered ⇒ listed": it is
  // never registry-backed (normalizeEntry rejects a "4k" entry) and
  // getArrInstancesWithConfigured synthesizes it ONLY while url+apiKey are BOTH
  // present. So an admin blanking one field mid key-rotation would drop it from
  // this list and the sweep would delete every 4K row — a badge hole for every
  // title until the key is re-entered and the following sync rebuilds the cache.
  // It can never be DE-REGISTERED, only unconfigured, so it is always spared.
  try {
    const [registeredRadarr, registeredSonarr] = await Promise.all([
      getArrInstances("radarr"),
      getArrInstances("sonarr"),
    ]);
    const spared = (registered: { slug: string }[]): string[] => {
      const slugs = registered.map((i) => i.slug);
      return slugs.includes(FOURK_ARR_INSTANCE) ? slugs : [...slugs, FOURK_ARR_INSTANCE];
    };
    const radarrSlugs = spared(registeredRadarr);
    const sonarrSlugs = spared(registeredSonarr);
    const swept = await Promise.all([
      prisma.radarrWantedItem.deleteMany({ where: { arrInstance: { notIn: radarrSlugs } } }),
      prisma.radarrAvailableItem.deleteMany({ where: { arrInstance: { notIn: radarrSlugs } } }),
      prisma.sonarrWantedItem.deleteMany({ where: { arrInstance: { notIn: sonarrSlugs } } }),
      prisma.sonarrAvailableItem.deleteMany({ where: { arrInstance: { notIn: sonarrSlugs } } }),
    ]);
    const sweptTotal = swept.reduce((n, r) => n + r.count, 0);
    if (sweptTotal > 0) {
      console.warn(`[sync] Swept ${sweptTotal} wanted/available row(s) for de-registered *arr instances`);
    }
  } catch (err) {
    console.error("[sync] De-registered *arr sweep failed:", err);
  }
  return { registeredPlex, registeredJellyfin };
}

// Whether this run can prove ABSENCE from each media-server type: configured and
// enabled, and no registered-but-unconfigured server still holding rows the run
// never looked at.
export async function libraryCoverage(
  flags: SyncFlags,
  { plexInstances, jellyfinInstances }: LibraryTargets,
  { registeredPlex, registeredJellyfin }: { registeredPlex: MediaInstanceConfig[]; registeredJellyfin: MediaInstanceConfig[] },
): Promise<{ plexConfiguredEnabled: boolean; jellyfinConfiguredEnabled: boolean; plexUnionIncomplete: boolean; jellyfinUnionIncomplete: boolean }> {
  const { plexEnabled, jellyfinEnabled } = flags;
  // A configured+enabled source that failed to refresh has an empty map that is NOT
  // proof of absence — reading it as "not in library" would false-demote an item that's
  // actually present in the unreached library. Only trust a library map when its source
  // synced; skip the demote entirely while a configured source is down.
  const plexConfiguredEnabled = plexEnabled && plexInstances.length > 0;
  const jellyfinConfiguredEnabled = jellyfinEnabled && jellyfinInstances.length > 0;
  // REGISTERED, not syncable. plexInstances/jellyfinInstances above are
  // getSyncableMediaInstances — CONFIGURED servers only — so a registered server whose
  // url/token an admin cleared silently drops out of this run's union while its
  // PlexLibraryItem/JellyfinLibraryItem rows are deliberately preserved (guardrail 35).
  // It never enters `fetched`, so it cannot make plexSyncSucceeded false either. Without
  // this guard a title living only on that server would read as absent and its requests
  // would be demoted AVAILABLE -> APPROVED, from data that simply was not consulted. The
  // registeredPlex/registeredJellyfin lists were read once, post-write, above
  // the de-registered-instance sweep and are shared with it.
  // `plexInstances.length > 0` is load-bearing. getMediaInstances ALWAYS synthesizes the
  // default instance, so a service with nothing configured reads as 1 registered vs 0
  // syncable — "incomplete" — and without this term the guard below would disable demotes
  // on every deployment not running BOTH Plex and Jellyfin, which is most of them. A service
  // that is entirely unconfigured is already handled by the plexConfiguredEnabled /
  // jellyfinConfiguredEnabled guards; this one is only about a service in USE that has a
  // registered server missing its connection details.
  // A raw count comparison is not enough either: getMediaInstances synthesizes the
  // default, so a deployment using a service EXCLUSIVELY through a named instance —
  // legacy default fields never filled in — reads as 2 registered vs 1 syncable on every
  // run and would veto every demote forever. The guard's own rationale ("its preserved
  // library rows are not in this run's union") is vacuous for a server that was never
  // configured: it holds no rows, so absence IS provable. Veto only on a missing slug
  // that ACTUALLY still holds rows. The existence probe is gated behind both cheap
  // terms, so the common single-server path issues no extra query.
  // The synthesized default ("") is EXCLUDED from the missing set. It can never
  // be de-registered (guardrail 35), so the only way it is registered-but-not-
  // syncable is that its connection was blanked — after which its surviving
  // library rows are stale ORPHANS, not the deliberately-preserved data of a
  // de-registered NAMED instance. Left in, a deployment that moved entirely to a
  // named server and cleared the default would keep matching its old default
  // rows here and veto EVERY demote forever, with no admin action able to clear
  // the state (nothing re-syncs the blanked default). Absence from a blanked
  // default is provable; only a missing NAMED slug that still holds rows vetoes.
  const syncablePlexSlugs = new Set(plexInstances.map((i) => i.slug));
  const missingPlex = registeredPlex.filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE && !syncablePlexSlugs.has(i.slug)).map((i) => i.slug);
  const syncableJellyfinSlugs = new Set(jellyfinInstances.map((i) => i.slug));
  const missingJellyfin = registeredJellyfin.filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE && !syncableJellyfinSlugs.has(i.slug)).map((i) => i.slug);
  const plexUnionIncomplete =
    plexInstances.length > 0 && missingPlex.length > 0 &&
    !!(await prisma.plexLibraryItem.findFirst({ where: { serverInstance: { in: missingPlex } }, select: { tmdbId: true } }));
  const jellyfinUnionIncomplete =
    jellyfinInstances.length > 0 && missingJellyfin.length > 0 &&
    !!(await prisma.jellyfinLibraryItem.findFirst({ where: { serverInstance: { in: missingJellyfin } }, select: { tmdbId: true } }));
  // A registered-but-unconfigured server that still holds rows is a STANDING
  // state until the admin acts, re-derived identically on every run — hourly,
  // and once per SSE-triggered run during a Plex scan. Guardrail 7b: log the
  // condition once and again when it differs; cadence is read from the cron run
  // history. The signature is the slug LISTS the counts are derived from, so a
  // swap of which server is missing (same count) still re-logs.
  const demoteSkipKey = "sync:demote-skip";
  if (plexUnionIncomplete || jellyfinUnionIncomplete) {
    warnOnChange(
      demoteSkipKey,
      `${plexUnionIncomplete ? missingPlex.join(",") : ""}|${jellyfinUnionIncomplete ? missingJellyfin.join(",") : ""}`,
      `[sync] skipping AVAILABLE->APPROVED demotes: ${plexUnionIncomplete ? missingPlex.length : 0} Plex and ` +
      `${jellyfinUnionIncomplete ? missingJellyfin.length : 0} Jellyfin server(s) are registered but not configured, ` +
      "so their preserved library rows are not in this run's union and absence cannot be proven.",
    );
  } else {
    forgetWarnOnChange(demoteSkipKey);
  }
  return { plexConfiguredEnabled, jellyfinConfiguredEnabled, plexUnionIncomplete, jellyfinUnionIncomplete };
}
export type LibraryCoverage = Awaited<ReturnType<typeof libraryCoverage>>;

// The per-requester visibility answers the revert, the marking passes and the
// notify fallback share, over this run's library arms (read-only) and the
// configured instances. The requester rows and the memo are per run.
export function requesterVisibility(
  { plexInstances, jellyfinInstances }: LibraryTargets,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
) {
  // Built before the revert because the demote is a per-user decision too, and
  // needs the same helpers the marking pass uses.
  // visibilityEnforced is the byte-identical escape hatch (guardrail 35): with
  // no restricted instance configured — every single-server deployment, and
  // every multi-server one that hasn't opted in — every configured slug is
  // visible to everyone, the per-user answer collapses to the union, and every
  // decision below short-circuits to the pre-grants code path.
  const visibilityEnforced =
    plexInstances.some((i) => i.restricted) || jellyfinInstances.some((i) => i.restricted);

  // Every per-user decision reads the requester through this one run-wide
  // cache (REQUESTER_SELECT: the mediaServer preference plus the grants gate's
  // inputs — extra COLUMNS on the requester read, never an extra query), each
  // user at most once (guardrail 31).
  const requesters = createRequesterCache();

  // A requester's visible slugs, memoised for the run: a title present in
  // several libraries asks the same question about the same user repeatedly.
  // Memoised ONLY once their row has been read: a user not read yet (or whose
  // row was deleted between the snapshot and now) answers least-privileged — 0n
  // permissions, no grants, so an absent row can never WIDEN visibility,
  // mirroring getVisibleServerInstances' null-session branch — and must not
  // keep that answer once their row is loaded.
  const visibilityCache = new Map<string, VisibleServerInstances>();
  const visibilityOf = (userId: string): VisibleServerInstances => {
    const hit = visibilityCache.get(userId);
    if (hit) return hit;
    const u = requesters.get(userId);
    const vis = visibleInstancesFor(
      // effectivePermissions, never the raw column (requesterPermissions): a
      // legacy ADMIN row whose permissions were never seeded keeps the ADMIN
      // short-circuit every read path grants it.
      requesterPermissions(u),
      parseMediaServerGrants(u?.mediaServerGrants),
      plexInstances,
      jellyfinInstances,
    );
    if (u) visibilityCache.set(userId, vis);
    return vis;
  };

  // "Is this title on a <service> server THIS requester can see?" — the
  // per-viewer replacement for the union map's `.has()`. The union check runs
  // FIRST and unchanged: a title absent from every configured server is absent
  // for everyone and no grant can conjure it, so the overwhelmingly common
  // "not present" answer costs exactly what it did before. Callers load the
  // requesters first.
  const presentForRequester = (
    req: { tmdbId: number; mediaType: string; requestedBy: string },
    service: LibrarySource,
  ): boolean => {
    const isMovie = req.mediaType === "MOVIE";
    const arm = service === "plex" ? plex : jellyfin;
    if (!(isMovie ? arm.movieIds : arm.tvIds).has(req.tmdbId)) return false;
    if (!visibilityEnforced) return true; // nothing restricted ⇒ the union IS the per-user answer
    const holders = (isMovie ? arm.movieSlugs : arm.tvSlugs).get(req.tmdbId);
    // Unreachable — the union and presence maps are filled in the same loop — but
    // fail CLOSED rather than fall back to the union if they ever diverge.
    if (!holders) return false;
    const vis = visibilityOf(req.requestedBy);
    return (service === "plex" ? vis.plex : vis.jellyfin).some((slug) => holders.has(slug));
  };
  return { visibilityEnforced, requesters, visibilityOf, presentForRequester };
}
type RequesterVisibility = ReturnType<typeof requesterVisibility>;

export async function revertAvailable(
  available: AvailableRow[],
  { flags, arr, coverage, plex, jellyfin, arrPresence, vis }: {
    flags: SyncFlags;
    arr: ArrRefresh;
    coverage: LibraryCoverage;
    plex: LibraryArm<unknown>;
    jellyfin: LibraryArm<unknown>;
    arrPresence: ArrPresence;
    vis: RequesterVisibility;
  },
): Promise<{ reverted: number; revertedIds: Set<string> }> {
  // Demote AVAILABLE requests that have dropped out of *both* the *arr caches and the
  // Plex/Jellyfin library caches. Consulting the library caches here — not just *arr — is
  // what stops a request present in Plex but absent from Radarr from being reverted to
  // APPROVED and then immediately re-marked AVAILABLE by markLibraryRequests below: a
  // same-run flap that rewrote availableAt and inflated the reverted counter every tick.
  // Runs after the library sync so the maps are populated; library presence is only trusted
  // when that source synced successfully (an empty map from a failed/disabled source falls
  // back to the *arr-only decision).
  const none = { reverted: 0, revertedIds: new Set<string>() };
  const { plexConfiguredEnabled, jellyfinConfiguredEnabled, plexUnionIncomplete, jellyfinUnionIncomplete } = coverage;
  const { inRadarrSet, inSonarrSet } = arrPresence;
  // Don't demote while a configured library source is down — we can't prove absence
  // from a library we never reached this run. Same rule for a server that is registered
  // but no longer configured: its rows survive and this run never looked at them.
  if (plexConfiguredEnabled && !plex.succeeded) return none;
  if (jellyfinConfiguredEnabled && !jellyfin.succeeded) return none;
  if (plexUnionIncomplete || jellyfinUnionIncomplete) return none;

  // Only consult the ARR cache when the integration is enabled AND this run refreshed
  // THE REQUEST'S OWN instance. A disabled integration, a failed refresh, or an
  // enabled-but-UNCONFIGURED instance all leave that instance's cache meaningless —
  // skip the demote. (The global *SyncSucceeded flag is not enough: it reads true after
  // the no-op empty loop of an unconfigured integration, so its empty cache would look
  // like an authoritatively-empty library and mass-demote every arr-backed AVAILABLE
  // request the moment an admin cleared the arr connection.)
  const goneFromArr = available.filter((req) =>
    arrInstanceRefreshed(req, flags, arr) &&
    !(req.mediaType === "MOVIE" ? inRadarrSet : inSonarrSet).has(vkey(req.tmdbId, req.arrInstance)),
  );
  if (goneFromArr.length === 0) return none;

  // Library presence is asked PER REQUESTER — the same predicate the marking pass uses.
  // Reading the global union here would count a restricted server the requester holds no
  // grant for as "present", keeping their request AVAILABLE for a copy they cannot watch.
  // The requesters are read only when something is restricted, and only for the rows
  // that are already gone from the arr (guardrail 35's byte-identical rule otherwise).
  if (vis.visibilityEnforced) await vis.requesters.load(goneFromArr.map((r) => r.requestedBy));
  const toRevert = goneFromArr.filter((req) =>
    !(plex.succeeded && vis.presentForRequester(req, "plex")) &&
    !(jellyfin.succeeded && vis.presentForRequester(req, "jellyfin")),
  );
  if (toRevert.length === 0) return none;

  const result = await prisma.mediaRequest.updateMany({
    // CAS on status: only demote rows still AVAILABLE. toRevert is built from the
    // run-start `available` snapshot, so a row that a concurrent path moved out of
    // AVAILABLE must not be blind-written back to APPROVED.
    // `cleanedUpAt: null`: an admin deleted a stamped row's title on purpose
    // through Library cleanup, so its absence from every cache and library is
    // the INTENDED state, not a lost file. Demoting it would make the next
    // run's re-push send it straight back to Radarr/Sonarr and re-download what
    // was just removed. It stays AVAILABLE. Kept in the WHERE (not a JS filter
    // over the run-start snapshot) so a stamp landing mid-run still wins (guardrail 14b).
    where: { id: { in: toRevert.map((r) => r.id) }, status: "AVAILABLE", cleanedUpAt: null },
    // Clear pendingNotifyAt on demote: a stale overdue timestamp left from the
    // original approve would otherwise fire a false "download pending" notify
    // once the row is back to APPROVED.
    data: { status: "APPROVED", pendingNotifyAt: null },
  });
  return { reverted: result.count, revertedIds: new Set(toRevert.map((r) => r.id)) };
}

// The two library marking passes. Returns how many requests each source's pass
// MATCHED (its candidates past every gate) — per source, so a title on both
// servers is counted by each and the two are never summed (guardrail 36).
export async function markLibraryPasses(
  revertedIds: Set<string>,
  { sonarrConfiguredSlugs }: ArrRefresh,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
  vis: RequesterVisibility,
): Promise<{ plexMarked: number; jellyfinMarked: number }> {
  // Snapshot taken once after both library writes complete; both marking passes share this
  // exact set (guardrail 15). Changes made by the Plex pass are NOT visible to the Jellyfin
  // pass's candidate set — intentional by design; only the claim flag is re-read
  // (markAvailableFromLibrary), and a row the Plex pass flipped without notifying is
  // notified by the fallback below.
  //
  // Exclude rows we just reverted from AVAILABLE→APPROVED in this same run. Otherwise
  // the marking could re-flip them to AVAILABLE if they're present in Plex/Jellyfin but
  // absent from the ARR caches — the same-run flap the revert was added to prevent.
  // Those items get a fresh look on the next run when the caches and status are coherent.
  const stillPending = (await readPendingRequests()).filter((r) => !revertedIds.has(r.id));

  // Sonarr completeness gate for the library passes (guardrail 14a). A TV title is in
  // Plex/Jellyfin the moment its FIRST episode imports, but a TV request is "ready" only
  // once Sonarr reports the series COMPLETE — an incomplete series sits in SonarrWantedItem
  // for its instance. Read ONCE here, for the union of both passes' candidates, so it rides
  // the single stillPending snapshot rather than re-querying per source (guardrail 15
  // constrains the READ; filtering the snapshot afterwards is fine). Pre-CAS by
  // construction: a held id never reaches the claim, so its once-only claim is never burned
  // (guardrail 14). A title Sonarr does not track at all (no wanted row) is marked off
  // library presence alone — the only sensible answer for a deployment with no Sonarr.
  // sonarrConfiguredSlugs is undefined when the Sonarr refresh threw: the helper then reads
  // the registry itself, so an outage still HOLDS.
  const held = await sonarrIncompleteKeys(stillPending, { configuredSlugs: sonarrConfiguredSlugs });
  const inputs: MarkInputs = { stillPending: withoutSonarrHeld(stillPending, held), vis };

  // A source whose library WRITE failed has empty maps here: each arm clears
  // them in its catch, because they were filled BEFORE the transaction and a
  // rolled-back replace must not flip requests AVAILABLE against rows that
  // never landed. Do NOT gate this on the arm's `succeeded`: that is also false
  // when ONE of several servers failed its fetch, and the healthy servers' rows
  // did land — presence there is still proof (only ABSENCE needs a complete
  // union, which is what demotion checks).
  const plexMarked = await markLibraryRequests(inputs, plex, "plex");
  const jellyfinMarked = await markLibraryRequests(inputs, jellyfin, "jellyfin");
  return { plexMarked, jellyfinMarked };
}

interface MarkInputs {
  // The ONE stillPending snapshot both passes share (guardrail 15), Sonarr hold applied.
  stillPending: PendingRequest[];
  vis: RequesterVisibility;
}

async function markLibraryRequests(
  { stillPending, vis }: MarkInputs,
  arm: LibraryArm<unknown>,
  source: LibrarySource,
): Promise<number> {
  if (arm.movieIds.size === 0 && arm.tvIds.size === 0) return 0;
  const candidates = inLibrary(stillPending, arm);
  if (candidates.length === 0) return 0;

  // GRANTS GATE — PRE-CAS BY CONSTRUCTION (guardrail 35).
  //
  // A `restricted` instance contributes availability ONLY to users granted `view`
  // on it, so the SAME title on the SAME server is available to a granted
  // requester and not-yet-available to an ungranted one. This is a plain filter
  // over the candidate array, and its position is the whole argument:
  //   • guardrail 14 holds untouched: the claim is still the ONLY writer of
  //     notifiedAvailable; it simply never receives a gated id.
  //   • the claim is NOT burned for a gated requester (contrast notify-available's
  //     deactivatedAt filter, which sits AFTER the UPDATE … RETURNING on purpose).
  //     A gated row stays PENDING/APPROVED with notifiedAvailable=false and is
  //     flipped + notified as soon as the grant lands or a copy appears on a
  //     server they can see.
  //   • guardrail 15 holds: the snapshot is read once; this filters it.
  // Gating the candidates covers every branch at once — notify, flip-only and the
  // already-notified flip — so an invisible title can never move a requester's
  // row to AVAILABLE by any route. NOT applied to the ARR passes, deliberately:
  // Radarr/Sonarr availability is server-agnostic, and in every real topology the
  // *arr feeds the DEFAULT server, which is visible to everyone.
  let toMark = candidates;
  if (vis.visibilityEnforced) {
    // Loaded at the CANDIDATE scope because the gate runs before toMark is
    // settled; the marking's mediaServer split then reads the same cached rows,
    // so this is still ONE requester read per pass.
    await vis.requesters.load(candidates.map((r) => r.requestedBy));
    toMark = candidates.filter((req) => vis.presentForRequester(req, source));
  }
  await markAvailableFromLibrary(toMark, source, { requesters: vis.requesters, logScope: "sync" });
  return toMark.length;
}

// Fallback for notification starvation: if a per-source sync has been failing for more than
// this long, that source's data counts as "unusable" so the *other* source can satisfy the
// notify gate alone. Without it, a permanently broken Plex would block every Jellyfin-only
// user's "now available" notification forever (and vice versa). Within the window a recent
// failure still refuses to notify on stale data.
const STALE_SYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;

// Whether each media-server type has been failing past STALE_SYNC_FALLBACK_MS. A
// configured source that fails with NO recorded success gets a baseline seeded
// first: the marker is only ever stamped on a clean run, so a source that has
// never synced clean would otherwise have no origin, could never become stale,
// and would starve every user pinned to it forever. skipDuplicates keeps the
// seed idempotent and can never overwrite a real success stamp; a later clean
// run upserts over it. A failure-time origin (not "missing ⇒ instantly stale")
// keeps the 24h within-window guard.
async function staleLibrarySources(
  { plexConfiguredEnabled, jellyfinConfiguredEnabled }: LibraryCoverage,
  plexSyncSucceeded: boolean,
  jellyfinSyncSucceeded: boolean,
): Promise<{ plex: boolean; jellyfin: boolean }> {
  const [lastPlexSuccessRow, lastJellyfinSuccessRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "lastPlexSyncSucceededAt" } }),
    prisma.setting.findUnique({ where: { key: "lastJellyfinSyncSucceededAt" } }),
  ]);
  const parseTs = (v: string | null | undefined): number | null => {
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const lastPlexSuccessAt = parseTs(lastPlexSuccessRow?.value);
  const lastJellyfinSuccessAt = parseTs(lastJellyfinSuccessRow?.value);
  const nowMs = Date.now();
  const plexFailing = plexConfiguredEnabled && !plexSyncSucceeded;
  const jellyfinFailing = jellyfinConfiguredEnabled && !jellyfinSyncSucceeded;
  const staleBaselineSeeds: Array<{ key: string; value: string }> = [];
  if (plexFailing && lastPlexSuccessAt == null) staleBaselineSeeds.push({ key: "lastPlexSyncSucceededAt", value: String(nowMs) });
  if (jellyfinFailing && lastJellyfinSuccessAt == null) staleBaselineSeeds.push({ key: "lastJellyfinSyncSucceededAt", value: String(nowMs) });
  if (staleBaselineSeeds.length > 0) {
    await prisma.setting.createMany({ data: staleBaselineSeeds, skipDuplicates: true })
      .catch((err) => console.error("[sync] failed to seed the stale-sync baseline:", err));
  }
  return {
    plex: plexFailing && lastPlexSuccessAt != null && nowMs - lastPlexSuccessAt > STALE_SYNC_FALLBACK_MS,
    jellyfin: jellyfinFailing && lastJellyfinSuccessAt != null && nowMs - lastJellyfinSuccessAt > STALE_SYNC_FALLBACK_MS,
  };
}

export async function notifyPendingAvailable(
  coverage: LibraryCoverage,
  plex: LibraryArm<unknown>,
  jellyfin: LibraryArm<unknown>,
  vis: RequesterVisibility,
): Promise<void> {
  // Re-query LIVE rather than filter the run-start `available` snapshot: a
  // request the marking passes flipped AVAILABLE **this run** via the
  // non-notifying flip (user prefers the OTHER source; title present in both
  // libraries) is not in the snapshot — the source-pass notify claim then finds
  // status already AVAILABLE (its CAS only claims PENDING/APPROVED) and the
  // user's "now available" notification would slip a full sync cycle. A live
  // read includes those rows; the requireStatusAvailable CAS below still
  // guarantees exactly-once against the webhook poller and concurrent runs.
  const pending = await prisma.mediaRequest.findMany({
    where: { status: "AVAILABLE", notifiedAvailable: false },
    select: PENDING_REQUEST_SELECT,
  });
  if (pending.length === 0) return;

  const stale = await staleLibrarySources(coverage, plex.succeeded, jellyfin.succeeded);
  await vis.requesters.load(pending.map((r) => r.requestedBy));

  // Collect candidate ids, then ONE CAS + one notify per channel rather than a
  // round-trip and a notify call per request.
  const toNotify = pending.filter((req) => {
    // Grants extend "unusable" per requester: someone who can see NO configured
    // server of a type is in exactly the position of a deployment with that type
    // unconfigured — it can never prove presence for them either way, so it must
    // not block the OTHER source's notify. Reachable when the DEFAULT instance of
    // a type is unconfigured and only a restricted named one exists (the default
    // is visible to everyone by construction).
    const visible = vis.visibilityEnforced ? vis.visibilityOf(req.requestedBy) : null;
    return fallbackShouldNotify({
      preferred: vis.requesters.get(req.requestedBy)?.mediaServer ?? null,
      // Per-viewer presence (grants), the same gate as the AVAILABLE flip and
      // also pre-CAS: a gated row's claim is never burned, and the next run
      // re-offers it. A failed library write left that source's maps empty
      // (cleared in its arm), so presence is never read from a rolled-back write.
      inPlex: vis.presentForRequester(req, "plex"),
      inJellyfin: vis.presentForRequester(req, "jellyfin"),
      // Reuses the demote gate's enabled+configured predicate: a source whose
      // integration flag is OFF will never sync, so counting it as configured
      // would starve every user pinned to it — what the stale fallback exists to fix.
      plexUnusable: !coverage.plexConfiguredEnabled || stale.plex || visible?.plex.length === 0,
      jellyfinUnusable: !coverage.jellyfinConfiguredEnabled || stale.jellyfin || visible?.jellyfin.length === 0,
    });
  });
  if (toNotify.length === 0) return;

  // Atomic claim (UPDATE ... RETURNING) closes the snapshot→updateMany TOCTOU:
  // only rows this statement flipped (status AVAILABLE, notifiedAvailable
  // false→true) come back. requireStatusAvailable keeps the "only notify rows
  // already marked AVAILABLE" guard.
  const { claimed, deliverable } = await claimAvailableNotifications(toNotify, { requireStatusAvailable: true });
  if (claimed.length > 0) {
    // Backstop wipe: the original AVAILABLE transition (per-source mark pass,
    // webhooks) should have wiped already, but a regression there is silent
    // until threshold notifications fire on stale votes — wipe again here.
    void clearDeletionVotesForTmdbs(claimed);
  }
  if (deliverable.length > 0) void fanOutAvailableWinners(deliverable, "sync");
}
