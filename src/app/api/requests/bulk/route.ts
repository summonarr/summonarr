import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import { exceedsCap } from "@/lib/content-rating";
import { checkRateLimit } from "@/lib/rate-limit";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeForLog } from "@/lib/sanitize";
import { resolveMediaMeta } from "@/lib/request-meta";
import { getBlacklistSet } from "@/lib/blacklist";
import {
  canRequest,
  canAutoApprove,
  hasPermission,
  effectivePermissions,
  Permission,
} from "@/lib/permissions";
import { resolveUserQuota, parseQuotaLimit } from "@/lib/quota";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";

// Bulk request creation. Backs the collection "Request all" button and admin
// "request on behalf of" flow. A single self-item or whole collection both go
// through here; the single POST /api/requests stays self-only.
//
// CSRF: relies on the proxy Origin/Referer check for mutating /api/* (same as
// the admin batch-approve and settings PATCH routes) — no per-item _token.
//
// Each new PENDING row emits a `request:new` SSE (the admin request list is
// live), but per-item email/push/Discord admin nudges are intentionally NOT
// sent — a 50-item "Request all" would flood every admin channel.

const MAX_ITEMS = 50;
const ARR_CONCURRENCY = 5;

type MediaType = "MOVIE" | "TV";
type ItemResult =
  | "created"
  | "auto-approved"
  | "already-available"
  | "already-requested"
  | "skipped-declined"
  | "no-permission"
  | "blacklisted"
  | "rating-blocked"
  | "error";

interface CreateOutcome {
  tmdbId: number;
  mediaType: MediaType;
  result: ItemResult;
}

// Minimal bounded-concurrency map so a 50-item collection doesn't fire 50
// simultaneous Radarr/Sonarr lookups.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const keyOf = (tmdbId: number, mediaType: string) => `${tmdbId}:${mediaType}`;

// Thrown inside the quota transaction to roll it back and surface a 429 carrying
// the offending media type's numbers.
class QuotaExceeded extends Error {
  constructor(
    readonly mt: MediaType,
    readonly limit: number,
    readonly windowLabel: string,
    readonly used: number,
  ) {
    super("QUOTA_EXCEEDED");
  }
}

export const POST = withPermission(Permission.REQUEST)(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`bulk:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const rawBody = await readJsonCapped<{ items?: unknown; onBehalfOfUserId?: unknown }>(req, 1048576);
  if (rawBody instanceof NextResponse) return rawBody;
  const body = rawBody;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "items must be a non-empty array" }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS})` }, { status: 400 });
  }

  const parsed: { tmdbId: number; mediaType: MediaType }[] = [];
  for (const raw of body.items) {
    const it = raw as { tmdbId?: unknown; mediaType?: unknown };
    if (!Number.isInteger(it.tmdbId) || (it.tmdbId as number) <= 0) {
      return NextResponse.json({ error: "each item needs a positive integer tmdbId" }, { status: 400 });
    }
    if (it.mediaType !== "MOVIE" && it.mediaType !== "TV") {
      return NextResponse.json({ error: "each item mediaType must be MOVIE or TV" }, { status: 400 });
    }
    parsed.push({ tmdbId: it.tmdbId as number, mediaType: it.mediaType });
  }

  // Dedup (tmdbId, mediaType).
  const seen = new Set<string>();
  const items = parsed.filter((i) => {
    const k = keyOf(i.tmdbId, i.mediaType);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Resolve the target user.
  const onBehalfId =
    typeof body.onBehalfOfUserId === "string" && body.onBehalfOfUserId.length > 0
      ? body.onBehalfOfUserId
      : null;
  const isOnBehalf = onBehalfId !== null && onBehalfId !== session.user.id;
  if (isOnBehalf && !hasPermission(session.user.permissions, Permission.REQUEST_ON_BEHALF)) {
    return NextResponse.json(
      { error: "You don't have permission to request on behalf of other users" },
      { status: 403 },
    );
  }
  const targetUserId = onBehalfId ?? session.user.id;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      permissions: true,
      discordId: true,
      deactivatedAt: true,
      movieQuotaLimit: true,
      movieQuotaDays: true,
      tvQuotaLimit: true,
      tvQuotaDays: true,
      maxContentRating: true,
    },
  });
  if (!target) return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  // A deactivated account can't sign in and shouldn't accumulate requests via the
  // on-behalf flow (the picker filters these out, but the id is client-supplied).
  if (target.deactivatedAt != null) {
    return NextResponse.json({ error: "Target user is deactivated" }, { status: 422 });
  }

  const targetPerms = effectivePermissions(target.role, target.permissions);

  // discordRequireLinkedAccountSite only gates SELF requests — an admin acting on
  // behalf is trusted and shouldn't be blocked by the target's link state.
  if (!isOnBehalf) {
    const reqLinked = await prisma.setting.findUnique({
      where: { key: "discordRequireLinkedAccountSite" },
    });
    if (reqLinked?.value === "true" && !target.discordId) {
      return NextResponse.json(
        { error: "You must link your Discord account before making requests" },
        { status: 403 },
      );
    }
  }

  // Authoritative existing-state lookup — never trust client-supplied availability.
  const orPairs = items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType }));
  const movieIds = items.filter((i) => i.mediaType === "MOVIE").map((i) => i.tmdbId);
  const tvIds = items.filter((i) => i.mediaType === "TV").map((i) => i.tmdbId);
  const [existingReqs, plexItems, jellyfinItems, radarrAvail, sonarrAvail] = await Promise.all([
    prisma.mediaRequest.findMany({
      // Bulk requests are HD-only (is4k defaults false), so scope the existing-request
      // lookup to HD rows too — otherwise a target who holds only a 4K request for a
      // title is wrongly classified "already-requested" and the HD create is skipped.
      where: { requestedBy: targetUserId, is4k: false, OR: orPairs },
      select: { id: true, tmdbId: true, mediaType: true, status: true, permanentlyDeclined: true },
    }),
    prisma.plexLibraryItem.findMany({ where: { OR: orPairs }, select: { tmdbId: true, mediaType: true } }),
    prisma.jellyfinLibraryItem.findMany({ where: { OR: orPairs }, select: { tmdbId: true, mediaType: true } }),
    movieIds.length
      ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: movieIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length
      ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: tvIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const existingMap = new Map(existingReqs.map((r) => [keyOf(r.tmdbId, r.mediaType), r]));
  const availSet = new Set<string>();
  for (const r of plexItems) availSet.add(keyOf(r.tmdbId, r.mediaType));
  for (const r of jellyfinItems) availSet.add(keyOf(r.tmdbId, r.mediaType));
  for (const r of radarrAvail) availSet.add(keyOf(r.tmdbId, "MOVIE"));
  for (const r of sonarrAvail) availSet.add(keyOf(r.tmdbId, "TV"));

  // Classify each item; collect the ones to actually create.
  const skipped: { tmdbId: number; mediaType: MediaType; result: ItemResult }[] = [];
  const toCreate: { tmdbId: number; mediaType: MediaType }[] = [];
  // Ids of stale, non-permanent DECLINED rows to drop so a fresh request can be
  // created (the @@unique constraint would otherwise make createMany skip them).
  const staleDeclinedIds: string[] = [];
  const blacklistSet = await getBlacklistSet();
  for (const it of items) {
    const k = keyOf(it.tmdbId, it.mediaType);
    if (blacklistSet.has(k)) {
      skipped.push({ ...it, result: "blacklisted" });
      continue;
    }
    if (!canRequest(targetPerms, it.mediaType, false)) {
      skipped.push({ ...it, result: "no-permission" });
      continue;
    }
    if (availSet.has(k)) {
      skipped.push({ ...it, result: "already-available" });
      continue;
    }
    const ex = existingMap.get(k);
    if (ex) {
      if (ex.permanentlyDeclined) {
        skipped.push({ ...it, result: "skipped-declined" });
        continue;
      }
      // An ordinary (non-permanent) decline is re-requestable: delete the stale
      // row below and create fresh. APPROVED/AVAILABLE/PENDING stay blocked.
      if (ex.status === "DECLINED") {
        staleDeclinedIds.push(ex.id);
        toCreate.push(it);
        continue;
      }
      skipped.push({ ...it, result: "already-requested" });
      continue;
    }
    toCreate.push(it);
  }

  // Drop stale declined rows before the create transaction so their fresh
  // replacements don't collide on the unique (tmdbId, mediaType, requestedBy, is4k).
  if (staleDeclinedIds.length > 0) {
    // CAS on status + permanentlyDeclined: an admin who re-approved or made the decline
    // permanent between the snapshot and here leaves that row intact. The createMany
    // below skipDuplicates, so a surviving row is simply not recreated rather than
    // orphaning its ARR grab or evading a permanent ban.
    await prisma.mediaRequest.deleteMany({ where: { id: { in: staleDeclinedIds }, status: "DECLINED", permanentlyDeclined: false } });
  }

  if (toCreate.length === 0) {
    return NextResponse.json({ results: skipped, created: 0 }, { status: 200 });
  }

  // Phase 1 — resolve TMDB metadata up front (bounded) so the create transaction
  // below holds no network calls. Items whose meta can't resolve become "error".
  const resolved = await mapLimit(toCreate, ARR_CONCURRENCY, async (it) => {
    try {
      const meta = await resolveMediaMeta(it.tmdbId, it.mediaType);
      return { it, meta };
    } catch (err) {
      console.error(`[requests/bulk] meta resolve failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      return { it, meta: null };
    }
  });
  let prepared = resolved.flatMap((r) =>
    r.meta
      ? [{
          tmdbId: r.it.tmdbId,
          mediaType: r.it.mediaType,
          title: r.meta.title,
          posterPath: r.meta.posterPath,
          releaseYear: r.meta.releaseYear,
          autoApprove: canAutoApprove(targetPerms, r.it.mediaType, false),
        }]
      : [],
  );
  const metaFailed = resolved
    .filter((r) => !r.meta)
    .map((r): CreateOutcome => ({ tmdbId: r.it.tmdbId, mediaType: r.it.mediaType, result: "error" }));

  // Parental control — drop any prepared item whose US certification exceeds the
  // TARGET user's cap (covers on-behalf-of-a-kid AND a capped user's own collection
  // "Request all"). Only capped, non-admin targets pay the per-item certification
  // fetch; unknown/unrated titles are allowed (see content-rating.ts).
  let ratingBlocked: CreateOutcome[] = [];
  if (target.maxContentRating && !hasPermission(targetPerms, Permission.ADMIN)) {
    const cap = target.maxContentRating;
    const checked = await mapLimit(prepared, ARR_CONCURRENCY, async (p) => {
      let cert: string | undefined;
      try {
        const d = p.mediaType === "MOVIE" ? await getMovieDetails(p.tmdbId) : await getTVDetails(p.tmdbId);
        cert = d.certification;
      } catch {
        cert = undefined;
      }
      return { p, blocked: exceedsCap(cert, cap) };
    });
    prepared = checked.filter((c) => !c.blocked).map((c) => c.p);
    ratingBlocked = checked
      .filter((c) => c.blocked)
      .map((c): CreateOutcome => ({ tmdbId: c.p.tmdbId, mediaType: c.p.mediaType, result: "rating-blocked" }));
  }

  // Phase 2 — quota re-check + insert, atomic under Serializable. This closes the
  // TOCTOU: a concurrent batch (or a single POST /api/requests) for the same target
  // can't both pass the quota gate and overshoot — the two count→insert transactions
  // form a read-write cycle and Postgres aborts one (retried below). createMany with
  // skipDuplicates so a racing duplicate doesn't abort the batch (a P2002 inside a tx
  // would); re-query to recover row ids for the *arr phase.
  let createdRows: { id: string; tmdbId: number; mediaType: MediaType; status: string }[] = [];
  // Keys (tmdbId:mediaType) whose status was mirrored from another user's already
  // APPROVED/AVAILABLE request — already greenlit, so phase 3 must NOT re-push them to *arr.
  const mirroredKeys = new Set<string>();
  if (prepared.length > 0) {
    const enforceQuota = !hasPermission(targetPerms, Permission.QUOTA_UNLIMITED);
    let gLimit = 0;
    let gPeriod = "week";
    if (enforceQuota) {
      const qrows = await prisma.setting.findMany({ where: { key: { in: ["quotaLimit", "quotaPeriod"] } } });
      const qmap = Object.fromEntries(qrows.map((s) => [s.key, s.value]));
      gLimit = parseQuotaLimit(qmap.quotaLimit);
      gPeriod = qmap.quotaPeriod ?? "week";
    }
    const pairs = prepared.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType }));
    try {
      createdRows = await runWithSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            if (enforceQuota) {
              for (const mt of ["MOVIE", "TV"] as MediaType[]) {
                const n = prepared.filter((p) => p.mediaType === mt).length;
                if (n === 0) continue;
                const rq = resolveUserQuota(mt, target, gLimit, gPeriod);
                if (rq.limit <= 0) continue;
                const used = await tx.mediaRequest.count({
                  where: { requestedBy: targetUserId, mediaType: mt, createdAt: { gte: rq.since }, status: { notIn: ["DECLINED"] } },
                });
                if (used + n > rq.limit) throw new QuotaExceeded(mt, rq.limit, rq.windowLabel, used);
              }
            }
            // Capture rows that existed BEFORE this insert so the side effects below
            // (SSE + ARR push) fire ONLY for rows THIS request created. Two concurrent
            // bulk requests with overlapping items would otherwise both re-query the
            // same skipDuplicates rows and both push/notify. With Serializable + retry,
            // a duplicate's retry re-snapshots, sees the other's committed rows in
            // `before`, and emits nothing. (Bulk analog of the requests/route fix.)
            const before = await tx.mediaRequest.findMany({
              where: { requestedBy: targetUserId, is4k: false, OR: pairs },
              select: { id: true },
            });
            const beforeIds = new Set(before.map((r) => r.id));

            // If another user's HD request for the same title is already APPROVED or
            // AVAILABLE, the content is greenlit/fulfilled — mirror that status so the
            // bulk requester is tracked (and gets the "now available" ping) instead of
            // queuing a duplicate PENDING for an admin to re-review. Matches the single
            // POST /api/requests "mirror-approved" branch.
            const greenlit = await tx.mediaRequest.findMany({
              where: { is4k: false, status: { in: ["APPROVED", "AVAILABLE"] }, OR: pairs },
              select: { tmdbId: true, mediaType: true, status: true },
            });
            const greenlitMap = new Map<string, "APPROVED" | "AVAILABLE">();
            for (const g of greenlit) {
              const k = keyOf(g.tmdbId, g.mediaType);
              // Prefer AVAILABLE over APPROVED if both exist for the title.
              if (g.status === "AVAILABLE" || !greenlitMap.has(k)) {
                greenlitMap.set(k, g.status as "APPROVED" | "AVAILABLE");
              }
            }
            mirroredKeys.clear();
            const now = new Date();
            await tx.mediaRequest.createMany({
              data: prepared.map((p) => {
                const k = keyOf(p.tmdbId, p.mediaType);
                const mirror = greenlitMap.get(k);
                if (mirror) mirroredKeys.add(k);
                const status = mirror ?? (p.autoApprove ? "APPROVED" : "PENDING");
                // Auto-approved (non-mirrored) rows arm the orchestrator's 90s
                // download-pending backstop, matching the single POST route. Mirrored
                // rows skip it — the original greenlit row drives notifications.
                const isAutoApproved = !mirror && p.autoApprove;
                return {
                  tmdbId: p.tmdbId,
                  mediaType: p.mediaType,
                  title: p.title,
                  posterPath: p.posterPath,
                  releaseYear: p.releaseYear,
                  note: null,
                  requestedBy: targetUserId,
                  status,
                  ...(mirror === "AVAILABLE" ? { availableAt: now } : {}),
                  ...(isAutoApproved ? { pendingNotifyAt: new Date(now.getTime() + 90_000) } : {}),
                };
              }),
              skipDuplicates: true,
            });
            const after = await tx.mediaRequest.findMany({
              where: { requestedBy: targetUserId, is4k: false, OR: pairs },
              select: { id: true, tmdbId: true, mediaType: true, status: true },
            });
            return after.filter((r) => !beforeIds.has(r.id));
          },
          { isolationLevel: "Serializable" },
        ),
      );
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        const remaining = Math.max(0, err.limit - err.used);
        const noun = err.mt === "MOVIE" ? "movie" : "TV";
        return NextResponse.json(
          { error: `This would exceed the ${noun} quota of ${err.limit} per ${err.windowLabel} (${remaining} remaining).` },
          { status: 429 },
        );
      }
      throw err;
    }

    // Clear the target user's own delete-votes for the titles they just requested —
    // a request and a deletion vote are contradictory, and the vote route already
    // blocks the reverse direction.
    void prisma.deletionVote.deleteMany({ where: { userId: targetUserId, OR: pairs } });
  }

  // Phase 3 — push auto-approved rows to *arr (bounded, post-commit), rolling back
  // to PENDING on push failure like the single route. Every created row emits request:new.
  const rowByKey = new Map(createdRows.map((r) => [keyOf(r.tmdbId, r.mediaType), r]));
  const outcomes = await mapLimit(prepared, ARR_CONCURRENCY, async (p): Promise<CreateOutcome> => {
    const row = rowByKey.get(keyOf(p.tmdbId, p.mediaType));
    if (!row) return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "error" };

    emitSSE({ type: "request:new", requestId: row.id, userId: targetUserId });

    // Mirrored rows (greenlit by another user) are already in *arr — re-pushing
    // would be a no-op at best; just track the row.
    if (mirroredKeys.has(keyOf(p.tmdbId, p.mediaType))) {
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: row.status === "AVAILABLE" ? "already-available" : "auto-approved" };
    }

    if (row.status !== "APPROVED") {
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "created" };
    }
    try {
      if (p.mediaType === "MOVIE") {
        await addMovieToRadarr(p.tmdbId);
      } else {
        const tvdbId = await addSeriesToSonarr(p.tmdbId);
        await prisma.mediaRequest.update({ where: { id: row.id }, data: { tvdbId } });
      }
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "auto-approved" };
    } catch (err) {
      console.error(
        `[requests/bulk] auto-approve push failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      );
      // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
      // may have flipped this row to AVAILABLE. Clear pendingNotifyAt too.
      await prisma.mediaRequest.updateMany({ where: { id: row.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } }).catch(() => {});
      // The client already saw request:new for an APPROVED row; emit a corrective
      // update so it reflects the rolled-back PENDING state (mirrors the single route).
      emitSSE({ type: "request:updated", requestId: row.id, status: "PENDING", userId: targetUserId });
      return { tmdbId: p.tmdbId, mediaType: p.mediaType, result: "created" };
    }
  });

  const results = [...skipped, ...metaFailed, ...ratingBlocked, ...outcomes];
  const createdCount = outcomes.filter((o) => o.result === "created" || o.result === "auto-approved").length;
  const requesterName = target.name ?? target.email;

  if (isOnBehalf) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "REQUEST_ON_BEHALF",
      target: `user:${targetUserId}`,
      details: { targetUser: requesterName, created: createdCount, results },
      ...auditContext(req, session),
    });
  }

  return NextResponse.json({ results, created: createdCount }, { status: 201 });
});
