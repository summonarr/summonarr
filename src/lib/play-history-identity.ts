// Who and what a play belongs to: the media-server identity (MediaServerUser,
// linked to a Summonarr account — guardrail 34) and the show a source-native
// episode key names.
import { prisma } from "./prisma";
import { sanitizeForLog } from "./sanitize";
import { normalizeEmail } from "./email-normalize";
import { pickPlexRowForKey } from "./plex-dedupe";

// Map a source-native show key (Plex ratingKey / Jellyfin itemId) to its tmdbId
// via the cached library tables. Returns null when unmapped or the key is empty.
// serverInstance-scoped (multi-server support): Plex ratingKeys are small
// server-local integers, so two instances legitimately reuse the same key for
// different shows — an unscoped lookup could attribute one server's watch to
// another server's title. Jellyfin item ids are UUIDs (near-zero collision
// risk) but are scoped identically for consistency.
// Rows holding one ratingKey are 1 (normal) or a few (a conflated item's key
// also rides the array of every title it claims — kept there on purpose, the
// never-watched join credits each of them; `plex-dedupe.ts` header).
const SHOW_KEY_HOLDERS_MAX = 25;

export async function resolveShowTmdbId(
  source: "plex" | "jellyfin",
  showKey: string | null | undefined,
  serverInstance: string,
): Promise<number | null> {
  if (!showKey) return null;
  if (source === "plex") {
    // ORed across both ratingKey columns (guardrail 37c): a show in two
    // sections has two ratingKeys and only one can be the stored plexRatingKey,
    // so episodes of the other copy used to be recorded with tmdbId null.
    //
    // findMany + pickPlexRowForKey, never findFirst: the OR can match TWO rows
    // (a conflated item's key is one row's canonical key and rides another's
    // array), and an unordered findFirst then follows physical row order — a
    // different show after any full-sync rewrite, PERSISTED onto every episode
    // play. Canonical holder first, else lowest tmdbId (the 37b order). The
    // bound only caps a pathological key; ordered, so it can't cut the owner
    // out from under a pick among array holders (a canonical holder is cut
    // only past SHOW_KEY_HOLDERS_MAX lower-id titles claiming the same item).
    const rows = await prisma.plexLibraryItem.findMany({
      where: {
        mediaType: "TV",
        serverInstance,
        OR: [{ plexRatingKey: showKey }, { plexRatingKeys: { has: showKey } }],
      },
      select: { tmdbId: true, plexRatingKey: true },
      orderBy: { tmdbId: "asc" },
      take: SHOW_KEY_HOLDERS_MAX,
    });
    return pickPlexRowForKey(rows, showKey)?.tmdbId ?? null;
  }
  // ORed across both id columns (guardrail 37): a show in two libraries has two
  // item ids and only one can be the stored `jellyfinItemId`, so a watch filed
  // under the other copy resolved to nobody. `jellyfinItemIds` carries every id,
  // but rows written before that column existed are `[]` — hence the OR rather
  // than a straight swap to `has`.
  //
  // findMany + a pick, never findFirst, for the Plex branch's reason: the OR can
  // match two rows. A recentOnly sync is insert-only and keyed by tmdbId, so a
  // show re-identified on the server gets a second row carrying the same item id
  // until the next full sync, and an unordered findFirst followed physical row
  // order — persisted onto every episode play.
  const rows = await prisma.jellyfinLibraryItem.findMany({
    where: {
      mediaType: "TV",
      serverInstance,
      OR: [{ jellyfinItemId: showKey }, { jellyfinItemIds: { has: showKey } }],
    },
    select: { tmdbId: true, jellyfinItemId: true },
    orderBy: { tmdbId: "asc" },
    take: SHOW_KEY_HOLDERS_MAX,
  });
  return pickJellyfinRowForKey(rows, showKey)?.tmdbId ?? null;
}

// The Jellyfin twin of pickPlexRowForKey (plex-dedupe.ts): the row whose
// canonical `jellyfinItemId` is the key, else the lowest tmdbId — a total order,
// so the answer never depends on the order the rows arrive in.
function pickJellyfinRowForKey<T extends { tmdbId: number; jellyfinItemId: string | null }>(
  rows: readonly T[],
  key: string,
): T | null {
  let best: T | null = null;
  let bestIsCanonical = false;
  for (const r of rows) {
    const canonical = r.jellyfinItemId === key;
    if (
      best === null ||
      (canonical && !bestIsCanonical) ||
      (canonical === bestIsCanonical && r.tmdbId < best.tmdbId)
    ) {
      best = r;
      bestIsCanonical = canonical;
    }
  }
  return best;
}

// Thrown by resolveMediaServerUser when a caller passes a serverMachineId that doesn't match the
// machineId previously bound to a (source, sourceUserId) row — defense-in-depth against a payload
// from a different server impersonating an already-pinned (source, sourceUserId). Currently DORMANT:
// the sole caller (the play-history poller) is trusted and does not pass serverMachineId, and the
// Plex/Jellyfin webhook routes that once fed an untrusted machineId here were removed. Retained as
// scaffolding — reactivate by passing serverMachineId from a future untrusted ingestion path (NOT
// the poller, which would false-trip on a legitimate server migration).
export class MediaServerMismatchError extends Error {
  // Explicit fields (not constructor parameter properties) so the module loads
  // under Node's strip-only TS mode — the unit suite imports it.
  public readonly source: string;
  public readonly sourceUserId: string;
  constructor(source: string, sourceUserId: string) {
    super(`MediaServerUser ${source}:${sourceUserId} bound to a different server`);
    this.name = "MediaServerMismatchError";
    this.source = source;
    this.sourceUserId = sourceUserId;
  }
}

// FNV-1a 32-bit hash. Stable across runs; used to derive a Postgres advisory
// lock id from a string key.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Upsert the MediaServerUser for a (source, sourceUserId) and link it to a local
// User by normalized email, serialized under an advisory lock. Returns the row id.
export async function resolveMediaServerUser(params: {
  source: string;
  serverInstance: string;
  sourceUserId: string;
  username: string;
  email?: string | null;
  thumbUrl?: string | null;
  serverMachineId?: string | null;
  isServerAdmin?: boolean;
}): Promise<string> {
  const { source, serverInstance, sourceUserId, username, thumbUrl, serverMachineId, isServerAdmin } = params;
  // Normalize once and use the same value for both lookup AND the upserted column,
  // so existing User rows (lowercase-stored) match Plex/Jellyfin server-reported
  // emails that vary in case, and so we don't write mixed-case copies into
  // MediaServerUser.email that won't round-trip the User lookup later.
  const email = params.email ? normalizeEmail(params.email) : null;

  // Serialize concurrent calls for the same MediaServerUser via an advisory
  // lock keyed on (source, serverInstance, sourceUserId). Two overlapping calls
  // for the same identity otherwise hit a find→upsert race (TOCTOU: the row
  // changes between the check and the write) where a freshly-created User row
  // falls into the gap and the MediaServerUser is bound to no User. The User lookup is re-done INSIDE the lock so a
  // concurrent User.create is picked up.
  //
  // Mask to 31 bits (signed int32 positive range) so Postgres reads the value
  // as `int` and matches the pg_advisory_xact_lock(int, int) overload — there
  // is no (int, bigint) overload, so an unmasked uint32 > 2^31 fails with
  // "function pg_advisory_xact_lock(integer, bigint) does not exist". The
  // 1-bit entropy loss is acceptable: collisions across distinct
  // (source, sourceUserId) pairs serialize unrelated upserts on the same
  // lock — a tiny throughput cost, not a correctness issue.
  const lockKey = fnv1a32(`mediaServerUser:${source}:${serverInstance}:${sourceUserId}`) & 0x7fffffff;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(2020, ${lockKey})`);

    // Resolve which Summonarr account this media-server identity belongs to.
    // Neither branch filters on `deactivatedAt`: a DISABLED account still owns
    // its watch history, and the person behind it usually keeps watching on the
    // server, so their plays must keep landing on their row — otherwise the admin
    // per-user views and getMyWatchHistory go blank from the moment they were
    // removed and STAY blank after an admin re-enables the account. A PURGED
    // account is excluded by construction on both branches instead: the purge
    // nulls plexUserId/jellyfinUserId and rewrites the email to
    // deleted-<id>@deleted.invalid, neither of which a media server can report.
    let userId: string | null = null;
    // 1. Provider subject id — the AUTHORITATIVE binding. `sourceUserId` is the
    // Plex accountID / Jellyfin userId, which is exactly what sign-in pins to
    // User.plexUserId / User.jellyfinUserId, so a match here is the same identity
    // by construction. Email is a weak key by comparison: a Jellyfin account
    // needs no email at all (so both sides are null and nothing ever links), a
    // Jellyfin-provisioned Summonarr row often carries the synthetic
    // jellyfin-<id>@jellyfin.local login address that no media server will ever
    // report, and either side can be changed by the user at any time. Without
    // this path those users' watches are never attributed to anyone.
    //
    // No mediaServer guard is needed on this branch: the subject columns are
    // unique and written only by the matching provider's sign-in, so unlike an
    // email match there is no cross-provider collision to defend against.
    const bySub =
      source.toLowerCase() === "plex"
        ? await tx.user.findUnique({ where: { plexUserId: sourceUserId }, select: { id: true } })
        : source.toLowerCase() === "jellyfin"
          ? await tx.user.findUnique({ where: { jellyfinUserId: sourceUserId }, select: { id: true } })
          : null;
    if (bySub) userId = bySub.id;

    // 2. Email fallback — covers accounts provisioned before the subject id was
    // bound (e.g. a local/OIDC user who watches on the server under the same
    // address, or a Plex row awaiting the plexUserId backfill).
    if (!userId && email) {
      const user = await tx.user.findUnique({ where: { email }, select: { id: true, mediaServer: true } });
      if (user && (!user.mediaServer || user.mediaServer.toLowerCase() === source.toLowerCase())) {
        userId = user.id;
      }
    }

    // Defense-in-depth server-binding check: once a (source, sourceUserId) row has
    // been pinned to a specific server (serverMachineId recorded), refuse any later
    // upsert that arrives carrying a DIFFERENT machineId. This guards a future
    // untrusted ingestion path (see MediaServerMismatchError — dormant today): a
    // payload stamped with another server's machineId must not hijack an identity
    // that already belongs to the operator's server. Pinning the first-seen
    // machineId keeps each media-server user bound to the server that created it.
    // Read unconditionally (not just when a machineId is offered): `manualUserLink`
    // is needed on every upsert so an admin's hand-set binding survives this poll.
    const existing = await tx.mediaServerUser.findUnique({
      where: { source_serverInstance_sourceUserId: { source, serverInstance, sourceUserId } },
      select: { id: true, serverMachineId: true, manualUserLink: true },
    });
    if (serverMachineId && existing?.serverMachineId && existing.serverMachineId !== serverMachineId) {
      console.warn(
        `[play-history] refusing MediaServerUser upsert: source=${sanitizeForLog(source)} sourceUserId=${sanitizeForLog(sourceUserId)} bound to a different server`,
      );
      throw new MediaServerMismatchError(source, sourceUserId);
    }
    // An admin corrected (or deliberately cleared) this row's account binding.
    // Automatic resolution must not overwrite it — this poll runs every 5s, so
    // without the guard a manual fix would survive for seconds at most.
    if (existing?.manualUserLink) userId = null;

    const record = await tx.mediaServerUser.upsert({
      where: { source_serverInstance_sourceUserId: { source, serverInstance, sourceUserId } },
      create: {
        source,
        serverInstance,
        sourceUserId,
        username,
        email: email ?? null,
        thumbUrl: thumbUrl ?? null,
        userId,
        serverMachineId: serverMachineId ?? null,
        ...(isServerAdmin !== undefined ? { isServerAdmin } : {}),
      },
      update: {
        username,
        ...(email ? { email } : {}),
        ...(thumbUrl ? { thumbUrl } : {}),
        ...(userId ? { userId } : {}),
        ...(serverMachineId ? { serverMachineId } : {}),
        // Set-only on existing rows: a transient mismatch between the admin
        // token's plex user id and the row we're upserting (e.g. token
        // rotation, OIDC-linked admin re-key, multi-user server with the
        // admin signed in from a fresh client) must NEVER demote
        // isServerAdmin true→false. Only ever upgrade false→true here.
        ...(isServerAdmin === true ? { isServerAdmin: true } : {}),
      },
      select: { id: true },
    });

    return record.id;
    // maxWait is explicit because the default (2s) is short against a pool of 5:
    // while a library-sized write held a connection, this resolve failed outright
    // with "Unable to start a transaction in the given time" and the 5s poller
    // dropped that tick — and the poller is the sole writer of Jellyfin play
    // history (guardrail 19), so a session that ENDS inside such a window is lost
    // for good. Waiting is safe here: the poll loop is serial (docker-entrypoint's
    // _play_history_loop sleeps between runs), so a slow tick delays the next one
    // instead of stacking concurrent ones.
  }, { timeout: 15_000, maxWait: 10_000 });
}
