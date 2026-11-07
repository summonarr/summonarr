import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, arrErrorMessage, arrWriteOutcomeUnknown, type AddProgress } from "@/lib/arr";
import { notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { scheduleDownloadCheck } from "@/lib/download-check";
import { canAutoApproveInstance, canRequest, canRequestInstance, defaultPermissionsForRole, effectivePermissions, hasPermission, parseInstanceGrants, parseMediaServerGrants, Permission } from "@/lib/permissions";
import { getMediaInstanceAccessLists, visibleInstancesFor } from "@/lib/media-visibility";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { routeMediaToSlug, type RoutableMedia } from "@/lib/arr-instances";
import { isBlacklisted } from "@/lib/blacklist";
import { exceedsCap } from "@/lib/content-rating";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { resolveUserQuota, parseQuotaLimit, quotaUsageWhere, type ResolvedQuota } from "@/lib/quota";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { greenlitPeerStatuses } from "@/lib/request-mirror";
import { dropStaleDeclined, restoreThread } from "@/lib/request-comment-carry";
import { TMDB_POSTER_BASE, editOriginal, quotaWindowLabel, releaseYearOf } from "../reply";
import type { ComponentContext, PendingSearch } from "../types";

type PickMedia = { tmdbId: number; mediaType: "MOVIE" | "TV"; arrInstance: string; title: string; posterPath: string | null; releaseYear: string | null };

// Admin fan-out for a request that ends up PENDING, shared by the plain pending
// branch of a pick and the auto-approve rollback (a failed *arr push leaves a
// PENDING row that otherwise reaches admins through no channel at all — the web
// path, request-create.ts, announces it the same way). The plain pending branch
// decides inside its create tx whether it is the first PENDING request for the
// title (below); the rollback, which turns a committed row PENDING after the
// fact, checks for an EARLIER pending request, ordered by (createdAt, id).
async function announceRolledBackToAdmins(
  request: { id: string; createdAt: Date },
  media: PickMedia,
  requestedBy: string,
  requesterId: string,
): Promise<void> {
  const earlierPending = await prisma.mediaRequest.findFirst({
    where: {
      tmdbId: media.tmdbId,
      mediaType: media.mediaType,
      arrInstance: media.arrInstance,
      status: "PENDING",
      id: { not: request.id },
      OR: [
        { createdAt: { lt: request.createdAt } },
        { createdAt: request.createdAt, id: { lt: request.id } },
      ],
    },
    select: { id: true },
  });
  if (earlierPending) return;
  alertAdmins(request, media, requestedBy, requesterId);
}

function alertAdmins(
  request: { id: string },
  media: PickMedia,
  requestedBy: string,
  requesterId: string,
): void {
  emitNotificationEvent({
    event: "request.created",
    media: { type: media.mediaType, tmdbId: media.tmdbId, title: media.title, year: media.releaseYear, posterPath: media.posterPath },
    request: { id: request.id, instance: media.arrInstance },
    actor: { name: requestedBy },
  });
  void notifyAdminsNewRequest({ title: media.title, mediaType: media.mediaType, requestedBy, note: null, posterPath: media.posterPath, tmdbId: media.tmdbId, releaseYear: media.releaseYear, excludeUserId: requesterId });
  void notifyAdminsNewRequestPush({ title: media.title, mediaType: media.mediaType, tmdbId: media.tmdbId, requestedBy, requestId: request.id, excludeUserId: requesterId });
  void notifyAdminsNewRequestDiscord({ requestId: request.id, title: media.title, mediaType: media.mediaType, tmdbId: media.tmdbId, requestedBy, note: null, posterPath: media.posterPath });
}

// `pick:<interactionId>:<discordUserId>:<index>` — a /request result button.
export async function handlePick(ctx: ComponentContext): Promise<void> {
  const { interaction, t, appId, token, customId, discordUser, discordUserId } = ctx;
  const [, interactionId, userId, idxStr] = customId.split(":");

  if (discordUserId !== userId) return;

  const key = `p:${interactionId}:${discordUserId}`;
  const cachedRow = await prisma.discordSearchCache.findUnique({ where: { queryKey: key } }).catch(() => null);
  let pending: PendingSearch | null = null;
  if (cachedRow && new Date() < cachedRow.expiresAt) {
    try { pending = JSON.parse(cachedRow.data) as PendingSearch; } catch { }
  }

  if (!pending) {
    prisma.discordSearchCache.delete({ where: { queryKey: key } }).catch(() => {});
    await editOriginal(appId, token, {
      content: t("notify.bot.pick.expired"),
      embeds: [],
      components: [],
    });
    return;
  }

  const idx = parseInt(idxStr, 10);
  const selected = pending.results[idx];
  if (!selected) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.invalid"), embeds: [], components: [] });
    return;
  }

  // The pending search row is NOT consumed here. Every gate below (maintenance,
  // permission, blacklist, rating, quota, already-requested, permanently denied)
  // answers without creating anything; consuming the row first made the user's
  // next pick from the same results answer "search expired". It is deleted
  // just before the create transactions, once a pick is actually being filed.

  // Every setting this click reads, in one query.
  const settingRows = await prisma.setting.findMany({
    where: { key: { in: ["maintenanceEnabled", "discordRequireLinkedAccount", "discordAutoApproveRoles", "request4kAll", "quotaLimit", "quotaPeriod"] } },
  });
  const setting = new Map(settingRows.map((r) => [r.key, r.value]));

  // Maintenance gate: a user who ran /request BEFORE maintenance was enabled could
  // still click a result button afterward and create a request (incl. auto-approve
  // → ARR push). Block unless the clicker is a linked Discord admin (admins bypass).
  if (setting.get("maintenanceEnabled") === "true") {
    const discordAdmin = await prisma.user.findFirst({ where: { discordId: discordUserId, role: "ADMIN" }, select: { id: true } });
    if (!discordAdmin) {
      await editOriginal(appId, token, { content: t("notify.bot.maintenance"), embeds: [], components: [] });
      return;
    }
  }

  const mediaType = selected.mediaType === "movie" ? "MOVIE" : "TV";

  // A Discord auto-approve role both exempts the clicker from the linked-account
  // requirement and auto-approves the request (mayAutoApprove below).
  const memberRoles: string[] = interaction.member?.roles ?? [];
  const requireLinkedComponent = setting.get("discordRequireLinkedAccount") === "true";
  const autoApproveRoles = (setting.get("discordAutoApproveRoles") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const hasAutoApproveRole = autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));

  let dbUser;
  if (requireLinkedComponent && !hasAutoApproveRole) {
    const linked = await prisma.user.findFirst({
      where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
    });
    if (!linked) {
      await editOriginal(appId, token, {
        content: t("notify.bot.linkRequiredToRequest"),
        embeds: [],
        components: [],
      });
      return;
    }
    dbUser = linked;
  } else {
    // Create a shadow user with a synthetic email; they can merge into a real account via /link.
    // Use the LIVE username from the component interaction rather than the cached
    // `pending.discordUsername` (which was captured at /request time and may be stale).
    const liveUsername = (discordUser.username as string | undefined) ?? pending.discordUsername;
    dbUser = await prisma.user.upsert({
      where: { discordId: discordUserId },
      // `permissions` is seeded on create only — deliberately NOT re-set on update, so an
      // admin's per-user permission edits aren't clobbered on every Discord interaction.
      // Legacy rows with permissions=0 stay correct via the effectivePermissions(role, …)
      // fallback below; don't "fix" this by adding permissions to `update`.
      update: {},
      create: {
        discordId: discordUserId,
        name: liveUsername,
        email: `discord_${discordUserId}@discord.local`,
        permissions: defaultPermissionsForRole("USER"),
      },
    });
    // Refresh the display name for SHADOW rows only. `/link` puts the same discordId on
    // the user's REAL row (mergeDiscordIntoWebAccount), so an unconditional
    // `update: { name }` rewrote a provider-provisioned name (Plex/OIDC/registration)
    // with the Discord handle on every result click — and nothing in the UI sets it back.
    if (dbUser.email.endsWith("@discord.local") && dbUser.name !== liveUsername) {
      dbUser = await prisma.user.update({ where: { id: dbUser.id }, data: { name: liveUsername } });
    }
  }

  const confirmEmbed: Record<string, unknown> = { title: selected.title };
  if (selected.posterPath) {
    confirmEmbed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
  }

  // Deactivation gate. A deactivated (banned) account keeps its role, permissions and
  // discordId fully intact — only `deactivatedAt` is set — so every permission check
  // below still passes for it. Session-backed transports hard-fail these users in
  // verifyAndRefreshSession; Discord is not session-backed, so without this the banned
  // user keeps creating (and, with an auto-approve role, auto-approving) requests.
  if (dbUser.deactivatedAt) {
    confirmEmbed.color = 0xed4245;
    confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.deactivated")}`;
    await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
    return;
  }

  // Effective permissions (ADMIN superbit / unseeded → role preset). Drives
  // both the quota bypass and the auto-approve decision below.
  const effPerms = effectivePermissions(dbUser.role, dbUser.permissions);

  // TMDB details, fetched at most once per click: the rating cap and the
  // instance routing below both read them. Null when TMDB can't answer.
  let detailsRead: Promise<TmdbMedia | null> | null = null;
  const details = () =>
    (detailsRead ??= (mediaType === "MOVIE" ? getMovieDetails(selected.id) : getTVDetails(selected.id)).catch(() => null));

  // Enforce request permission (parity with the web route, which 403s on this).
  // Without it, a user whose admin set a permission mask omitting the REQUEST
  // bits could still create a request through Discord.
  if (!canRequest(effPerms, mediaType, false)) {
    confirmEmbed.color = 0xed4245;
    confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.noPermission")}`;
    await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
    return;
  }

  // Blacklist gate (parity with the web chokepoints, which 403 on this):
  // an admin-blocked title must be rejected before any request row is
  // created, or Discord becomes a bypass around the blacklist.
  if (await isBlacklisted(selected.id, mediaType)) {
    confirmEmbed.color = 0xed4245;
    confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.blacklisted")}`;
    await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
    return;
  }

  // Parental control (parity with the web chokepoints): block a request whose
  // US certification exceeds the user's cap. Only capped, non-admin users pay
  // the (cached) certification fetch; unknown/unrated titles and TMDB failures
  // are allowed — fail-open, same as requests/route.ts.
  if (dbUser.maxContentRating && !hasPermission(effPerms, Permission.ADMIN)) {
    const cert = (await details())?.certification;
    if (exceedsCap(cert, dbUser.maxContentRating)) {
      confirmEmbed.color = 0xed4245;
      confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.rating")}`;
      await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
      return;
    }
  }

  // Auto-route to a named instance (e.g. anime) — parity with the web POST.
  // Discord has no instance picker, so routing is fully server-side: only pay
  // the TMDB details fetch when a configured non-default instance carries an
  // autoRoute rule. If the user lacks access to the routed instance, fall back
  // to the default — a reviewable default-instance request beats a hard error
  // in a chat flow.
  const arrService = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const configuredInstances = await getSyncableArrInstances(arrService);
  const grants = parseInstanceGrants(dbUser.instanceGrants);
  let routedSlug = "";
  if (configuredInstances.some((i) => i.slug !== "" && i.autoRoute)) {
    let routable: RoutableMedia = { genreIds: [], originalLanguage: null, originCountries: [] };
    // TMDB details unavailable ⇒ fall back to the default instance.
    const detail = await details();
    if (detail) {
      routable = {
        genreIds: detail.genreList?.map((g) => g.id) ?? [],
        originalLanguage: detail.originalLanguage ?? null,
        // ISO codes from the normalized details (populated since the
        // originCountryCodes field landed; older cached rows lack it and
        // degrade to [] — exactly the previous behavior — until TTL refresh).
        originCountries: detail.originCountryCodes ?? [],
      };
    }
    routedSlug = routeMediaToSlug(configuredInstances, routable);
  }
  let routedInstance = configuredInstances.find((i) => i.slug === routedSlug);
  if (routedSlug !== "" && routedInstance) {
    if (!canRequestInstance(effPerms, routedInstance, grants, mediaType, setting.get("request4kAll") === "true")) {
      routedSlug = "";
      routedInstance = undefined;
    }
  }
  const routedAccess = routedInstance ?? { slug: routedSlug, restricted: false, serverAll: false };
  const skipLibraryCheck = routedInstance?.skipLibraryCheck === true;

  // Quota gate runs BEFORE the stale-request delete below (parity with
  // requests/route.ts): a re-request the quota then rejects must NOT have already
  // erased the user's DECLINED-history row. The authoritative enforcement is the
  // serializable-tx recheck at create time; this is the early user-facing reject.
  let rq: ResolvedQuota | null = null;
  let quotaApplies = false;
  if (!hasPermission(effPerms, Permission.QUOTA_UNLIMITED)) {
    quotaApplies = true;
    rq = resolveUserQuota(
      mediaType,
      {
        movieQuotaLimit: dbUser.movieQuotaLimit ?? null,
        movieQuotaDays: dbUser.movieQuotaDays ?? null,
        tvQuotaLimit: dbUser.tvQuotaLimit ?? null,
        tvQuotaDays: dbUser.tvQuotaDays ?? null,
      },
      parseQuotaLimit(setting.get("quotaLimit")),
      setting.get("quotaPeriod") ?? "week",
    );
    if (rq && rq.limit > 0) {
      const count = await prisma.mediaRequest.count({
        where: quotaUsageWhere(dbUser.id, mediaType, rq.since),
      });
      if (count >= rq.limit) {
        confirmEmbed.color = 0xed4245;
        confirmEmbed.description = t("notify.bot.pick.quota", { limit: rq.limit, window: quotaWindowLabel(t, rq.windowLabel) });
        await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
        return;
      }
    }
  }

  // Stale-request handling runs AFTER the permission/blacklist/rating/quota
  // gates (parity with requests/route.ts): a re-request that those gates then
  // reject must NOT have already erased the user's DECLINED-history row.
  const existing = await prisma.mediaRequest.findFirst({
    // Instance-scoped to the ROUTED target: a request for the same title on a
    // different instance must not block this one.
    where: { tmdbId: selected.id, mediaType, requestedBy: dbUser.id, arrInstance: routedSlug },
  });
  // Set when a stale, non-permanent DECLINED row must be cleared to make room
  // for the re-request. Deleted inside whichever create transaction runs, so an
  // abort rolls it back with everything else.
  let staleDeclinedId: string | null = null;
  if (existing) {
    if (existing.permanentlyDeclined) {
      confirmEmbed.color = 0xed4245;
      confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.permanentlyDenied")}`;
      await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
      return;
    }
    // An ordinary (non-permanent) decline is not terminal — parity with the web
    // route: drop the stale DECLINED row and fall through to a fresh request.
    // APPROVED/AVAILABLE/PENDING still block.
    if (existing.status === "DECLINED") {
      // Deferred to the create transactions below, never committed here.
      // Deleting up front destroyed the admin's decline (and its adminNote) on
      // every path that then aborts without creating a replacement: the
      // alreadyAvailable branch returns without creating anything, and either
      // transaction can throw QUOTA_EXCEEDED or exhaust runWithSerializableRetry's
      // P2034 attempts. The title then read as never-requested. Matches
      // requests/route.ts and requests/bulk/route.ts, which were both fixed for
      // exactly this.
      staleDeclinedId = existing.id;
    } else {
      confirmEmbed.color = 0xfee75c;
      confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.alreadyRequested")}`;
      await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
      return;
    }
  }

  // Server visibility of THIS interaction's user (dbUser — resolved above from the
  // component interaction, linked or shadow), not a global union: a copy on a
  // restricted server they hold no grant for must not answer "already available" and
  // leave them with no way to get it. dbUser's row is already loaded, so this only
  // costs the two registry reads.
  const mediaAccess = await getMediaInstanceAccessLists();
  const visibleServers = visibleInstancesFor(
    effPerms,
    parseMediaServerGrants(dbUser.mediaServerGrants),
    mediaAccess.plex,
    mediaAccess.jellyfin,
  );
  // The routed instance's *arr-available cache is read for EVERY slug, the default
  // included (parity with request-create.ts): an auto-approver treats a hit as
  // already-here, and the mirror branch below needs it as the only evidence (short
  // of a visible library copy) that an AVAILABLE peer's status is true for THIS
  // requester too. Reading it only for named instances let an auto-approver
  // re-request a default-instance title Radarr/Sonarr already had on disk.
  const [plexItem, jellyfinItem, arrAvailableRow] = await Promise.all([
    prisma.plexLibraryItem.findFirst({ where: { tmdbId: selected.id, mediaType, serverInstance: { in: visibleServers.plex } } }),
    prisma.jellyfinLibraryItem.findFirst({ where: { tmdbId: selected.id, mediaType, serverInstance: { in: visibleServers.jellyfin } } }),
    mediaType === "MOVIE"
      ? prisma.radarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: selected.id, arrInstance: routedSlug } } })
      : prisma.sonarrAvailableItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId: selected.id, arrInstance: routedSlug } } }),
  ]);
  const arrHasInstance = arrAvailableRow !== null;

  const baseData = {
    tmdbId: selected.id,
    mediaType,
    arrInstance: routedSlug,
    title: selected.title,
    posterPath: selected.posterPath ?? null,
    releaseYear: releaseYearOf(selected),
    note: null,
    requestedBy: dbUser.id,
  } as const;

  const mayAutoApprove = hasAutoApproveRole || canAutoApproveInstance(effPerms, routedAccess, grants, mediaType);

  // A visible library copy is "already available" for everyone (skipped for
  // skipLibraryCheck instances); the instance's arr cache only for an auto-approver,
  // exactly as request-create.ts computes `arrAvailable = isAutoApprove && arrHasInstance`.
  const alreadyAvailable = (!skipLibraryCheck && (!!plexItem || !!jellyfinItem)) || (mayAutoApprove && arrHasInstance);

  // Consume the pending search row only now: every gate above has passed and a
  // reply that settles this pick follows. Best-effort — the row also expires.
  prisma.discordSearchCache.delete({ where: { queryKey: key } }).catch(() => {});

  // Clear the requester's own delete-vote for this title — a request and a deletion
  // vote are contradictory, and the vote route already blocks the reverse. Only
  // once a request EXISTS (parity with request-create.ts): a pick refused by the
  // quota recount or a duplicate, or one that finds the title already here, files
  // nothing, so nothing contradicts the vote. Outside any transaction, and
  // `.catch` (not bare `void`): a Prisma promise is lazy, and a detached rejection
  // would surface as an unhandledRejection on the long-lived Node server.
  const clearOwnDeletionVote = () => {
    prisma.deletionVote
      .deleteMany({ where: { userId: dbUser.id, tmdbId: selected.id, mediaType } })
      .catch((err) => console.error("[interactions] deletion-vote cleanup failed:", err));
  };

  let note: string;
  try {
    if (alreadyAvailable) {
      // Parity with the web route (requests/route.ts alreadyAvailable branch):
      // a library hit is NOT a request — don't create a row, so it doesn't
      // consume the user's rolling quota.
      //
      // No clearDeletionVotesForTmdbs here. That helper is the GLOBAL wipe for
      // genuine AVAILABLE transitions: it deletes every user's vote for the
      // title and clears the deletionVoteNotified gate. This branch transitions
      // nothing — the title was already available — so calling it let any user
      // reset the whole community tally just by re-requesting, and the threshold
      // could never accumulate. Nor is the requester's own vote cleared: no
      // request is filed, so nothing contradicts it (the web route returns
      // before its clear on this branch too).
      note = t("notify.bot.pick.inLibrary");
      confirmEmbed.color = 0x57f287;
    } else if (mayAutoApprove) {
      // pendingNotifyAt arms the orchestrator's 90s download backstop so a dropped
      // scheduleDownloadCheck job still yields a follow-up notification.
      // Serializable is load-bearing: at the default Read Committed two concurrent
      // txs both read count < limit and both commit past the quota boundary, and
      // runWithSerializableRetry's P2034 retry can never fire (parity with
      // requests/route.ts and requests/bulk/route.ts).
      const request = await runWithSerializableRetry(async () =>
        prisma.$transaction(async (tx) => {
          if (quotaApplies && rq && rq.limit > 0) {
            const count = await tx.mediaRequest.count({
              where: quotaUsageWhere(dbUser.id, mediaType, rq.since),
            });
            if (count >= rq.limit) throw new Error("QUOTA_EXCEEDED");
          }
          // Only now that a create is guaranteed to follow, and in the same tx —
          // an abort past this point rolls the delete back with it. deleteMany
          // (not delete) no-ops on a concurrent double re-request; the CAS on
          // status + permanentlyDeclined leaves the row intact if an admin
          // re-approved it or made the decline permanent since the read, and the
          // create below then surfaces P2002 instead of evading that. The declined
          // row's comment thread (it would cascade) moves to the new row
          // (request-comment-carry.ts).
          const carried = await dropStaleDeclined(tx, staleDeclinedId);
          // approvedAt: auto-approve is an approval (MediaRequest.approvedAt).
          const row = await tx.mediaRequest.create({ data: { ...baseData, status: "APPROVED", approvedAt: new Date(), pendingNotifyAt: new Date(Date.now() + 90_000) } });
          await restoreThread(tx, row.id, carried);
          return row;
        }, { isolationLevel: "Serializable" })
      );
      clearOwnDeletionVote();
      // Keep the admin request list live (every other creation path emits).
      emitSSE({ type: "request:new", requestId: request.id, userId: dbUser.id });
      let arrFailed = false;
      let pushedTvdbId: number | null = null;
      const pushProgress: AddProgress = { sent: false };
      try {
        if (mediaType === "MOVIE") {
          await addMovieToRadarr(selected.id, routedSlug, undefined, dbUser.id, pushProgress);
        } else {
          pushedTvdbId = await addSeriesToSonarr(selected.id, routedSlug, undefined, dbUser.id, pushProgress);
        }
      } catch (err) {
        // Unknown only once the add itself was sent (AddProgress).
        if (pushProgress.sent && arrWriteOutcomeUnknown(err)) {
          // No definite answer (a timeout, a dropped connection, a gateway
          // 502/504): the arr may have added it. Left APPROVED, like the web
          // path (request-create.ts); the sync re-pushes an APPROVED title the
          // arr doesn't hold.
          console.error("[interactions] arr push outcome unknown, left APPROVED:", arrErrorMessage(err));
        } else {
          console.error("[interactions] arr push failed:", arrErrorMessage(err));
          // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
          // may have flipped this row to AVAILABLE between create and here. Clear
          // pendingNotifyAt too: the push failed, so there's no download to pend.
          await prisma.mediaRequest.updateMany({ where: { id: request.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } });
          arrFailed = true;
        }
      }
      // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the
      // series by this point, so a P2025 (row deleted mid-push) or transient DB error
      // must not trip the APPROVED->PENDING rollback and leave Sonarr grabbing content
      // the DB says is pending. updateMany no-ops on a concurrently deleted row.
      if (!arrFailed && pushedTvdbId !== null) {
        await prisma.mediaRequest.updateMany({ where: { id: request.id }, data: { tvdbId: pushedTvdbId } });
      }
      if (arrFailed) {
        // Corrective SSE: request:new above announced this row as APPROVED, but
        // the push failed and it rolled back to PENDING — emit the update so the
        // admin request list doesn't stay stuck at APPROVED (parity with the web
        // POST/PATCH rollback paths, which emit the same corrective event).
        emitSSE({ type: "request:updated", requestId: request.id, status: "PENDING", userId: dbUser.id });
        // The row now sits in the admin queue like any pending request and
        // pendingNotifyAt is cleared, so this is the only alert admins get.
        await announceRolledBackToAdmins(
          request,
          { tmdbId: selected.id, mediaType, arrInstance: routedSlug, title: selected.title, posterPath: selected.posterPath ?? null, releaseYear: releaseYearOf(selected) },
          dbUser.name ?? dbUser.email ?? dbUser.id,
          dbUser.id,
        );
        // The push failed and the request rolled back to PENDING — don't tell
        // the user it's "being downloaded"; surface that an admin will review it.
        note = t("notify.bot.pick.arrFailed");
        confirmEmbed.color = 0xfee75c;
      } else {
        note = t("notify.bot.pick.autoApproved");
        confirmEmbed.color = 0x57f287;
      }

      scheduleDownloadCheck({
        requestId: request.id,
        tmdbId: selected.id,
        mediaType,
        arrInstance: routedSlug,
        requestedBy: dbUser.id,
        title: selected.title,
      }, { name: "interactions:90s-download-check" });
    } else {
      // If another request for this title ON THE SAME INSTANCE is already APPROVED
      // or AVAILABLE, the content is already greenlit — mirror that status so this
      // user is tracked for the "now available" notification, and skip the admin
      // "new request" alert (nothing to review).
      // One Serializable tx covers the quota recount, the greenlit check, and
      // the mirror/pending create (parity with requests/route.ts) — mirror rows
      // are APPROVED/AVAILABLE and count against the quota window, so a create
      // outside the tx would let concurrent picks overshoot the boundary.
      let mirrored = false;
      let announce = false;
      const createdRequest = await runWithSerializableRetry(async () =>
        prisma.$transaction(async (tx) => {
          mirrored = false; // reset — the callback re-runs on a P2034 retry
          announce = false;
          if (quotaApplies && rq && rq.limit > 0) {
            const count = await tx.mediaRequest.count({
              where: quotaUsageWhere(dbUser.id, mediaType, rq.since),
            });
            if (count >= rq.limit) throw new Error("QUOTA_EXCEEDED");
          }
          // Same rollback-safety as the auto-approve tx above: deleted only in
          // the tx that creates the replacement, so a QUOTA_EXCEEDED throw or a
          // P2034 retry-exhaustion cannot leave the decline erased with nothing
          // in its place. Its comment thread moves to the new row, as above.
          const carried = await dropStaleDeclined(tx, staleDeclinedId);
          // No approvedAt on the copy, as in the web route: the watch grade
          // counts it through the approval of the request it copied. A row
          // stamped `cleanedUpAt` records a deliberate removal, not a
          // greenlight (guardrail 14b) — never copied, or the sync re-pushes it.
          //
          // An AVAILABLE peer counts only when the title is available to THIS
          // requester: no visible library copy exists (that returned above), so the
          // instance's *arr-available cache is the remaining evidence. Without it the
          // peer may have been marked off a restricted server (guardrail 35) or off
          // the HD copy of a 4K request — not an approval, so the pick goes to review.
          // The same rule as request-create.ts (greenlitPeerStatuses).
          const alreadyGreenlit = await tx.mediaRequest.findFirst({
            where: { tmdbId: selected.id, mediaType, arrInstance: routedSlug, status: { in: greenlitPeerStatuses(arrHasInstance) }, cleanedUpAt: null },
            select: { status: true },
          });
          if (alreadyGreenlit) {
            mirrored = true;
            const mirrorStatus = alreadyGreenlit.status;
            // Mirror availableAt when the copied status is AVAILABLE, matching the
            // alreadyAvailable branch — otherwise an AVAILABLE mirror row has a null
            // availableAt and looks freshly approved.
            const copy = await tx.mediaRequest.create({
              data: {
                ...baseData,
                status: mirrorStatus,
                ...(mirrorStatus === "AVAILABLE" ? { availableAt: new Date() } : {}),
              },
            });
            await restoreThread(tx, copy.id, carried);
            return copy;
          }
          // Only the first PENDING request for the title alerts the admins —
          // decided here, in the Serializable tx (parity with request-create.ts):
          // two concurrent picks that each read "no PENDING peer" and insert one
          // form a read/write cycle Postgres aborts (P2034), and the retry sees
          // the committed peer.
          const pendingPeer = await tx.mediaRequest.findFirst({
            where: { tmdbId: selected.id, mediaType, arrInstance: routedSlug, status: "PENDING" },
            select: { id: true },
          });
          const row = await tx.mediaRequest.create({ data: baseData });
          await restoreThread(tx, row.id, carried);
          announce = !pendingPeer;
          return row;
        }, { isolationLevel: "Serializable" })
      );
      clearOwnDeletionVote();
      // Keep the admin request list live (every other creation path emits).
      emitSSE({ type: "request:new", requestId: createdRequest.id, userId: dbUser.id });
      if (mirrored) {
        note = t("notify.bot.pick.mirrored");
        confirmEmbed.color = 0x57f287;
      } else {
        if (announce) {
          alertAdmins(
            createdRequest,
            { tmdbId: selected.id, mediaType, arrInstance: routedSlug, title: selected.title, posterPath: selected.posterPath ?? null, releaseYear: releaseYearOf(selected) },
            dbUser.name ?? dbUser.email ?? dbUser.id,
            dbUser.id,
          );
        }
        note = t("notify.bot.pick.pending");
        confirmEmbed.color = 0x57f287;
      }
    }
  } catch (err) {
    if (isPrismaErrorCode(err, "P2002")) {
      confirmEmbed.color = 0xfee75c;
      confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.alreadyRequested")}`;
      await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
      return;
    }
    if (err instanceof Error && err.message === "QUOTA_EXCEEDED") {
      confirmEmbed.color = 0xed4245;
      confirmEmbed.description = t("notify.bot.pick.quota", { limit: rq?.limit ?? 0, window: quotaWindowLabel(t, rq?.windowLabel) });
      await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
      return;
    }
    throw err;
  }

  confirmEmbed.description = `(${selected.releaseYear}) — ${note}`;
  await editOriginal(appId, token, { content: t("notify.bot.pick.submitted"), embeds: [confirmEmbed], components: [] });
}
