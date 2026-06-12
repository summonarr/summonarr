import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { checkRateLimit } from "@/lib/rate-limit";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeForLog } from "@/lib/sanitize";
import { resolveMediaMeta } from "@/lib/request-meta";
import {
  canRequest,
  canAutoApprove,
  hasPermission,
  effectivePermissions,
  Permission,
} from "@/lib/permissions";
import { resolveUserQuota } from "@/lib/quota";
import { logAudit, auditContext } from "@/lib/audit";

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

export const POST = withPermission(Permission.REQUEST)(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`bulk:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let body: { items?: unknown; onBehalfOfUserId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
      movieQuotaLimit: true,
      movieQuotaDays: true,
      tvQuotaLimit: true,
      tvQuotaDays: true,
    },
  });
  if (!target) return NextResponse.json({ error: "Target user not found" }, { status: 404 });

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
      select: { tmdbId: true, mediaType: true, permanentlyDeclined: true },
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
  for (const it of items) {
    const k = keyOf(it.tmdbId, it.mediaType);
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
      skipped.push({ ...it, result: ex.permanentlyDeclined ? "skipped-declined" : "already-requested" });
      continue;
    }
    toCreate.push(it);
  }

  if (toCreate.length === 0) {
    return NextResponse.json({ results: skipped, created: 0 }, { status: 200 });
  }

  // Quota — all-or-nothing, per media type, evaluated against the TARGET user.
  if (!hasPermission(targetPerms, Permission.QUOTA_UNLIMITED)) {
    const qrows = await prisma.setting.findMany({ where: { key: { in: ["quotaLimit", "quotaPeriod"] } } });
    const qmap = Object.fromEntries(qrows.map((s) => [s.key, s.value]));
    const gLimit = parseInt(qmap.quotaLimit ?? "0", 10);
    const gPeriod = qmap.quotaPeriod ?? "week";
    for (const mt of ["MOVIE", "TV"] as MediaType[]) {
      const newCount = toCreate.filter((i) => i.mediaType === mt).length;
      if (newCount === 0) continue;
      const rq = resolveUserQuota(mt, target, gLimit, gPeriod);
      if (rq.limit <= 0) continue;
      const used = await prisma.mediaRequest.count({
        where: { requestedBy: targetUserId, mediaType: mt, createdAt: { gte: rq.since }, status: { notIn: ["DECLINED"] } },
      });
      if (used + newCount > rq.limit) {
        const remaining = Math.max(0, rq.limit - used);
        const noun = mt === "MOVIE" ? "movie" : "TV";
        return NextResponse.json(
          {
            error: `This would exceed the ${noun} quota of ${rq.limit} per ${rq.windowLabel} (${remaining} remaining).`,
          },
          { status: 429 },
        );
      }
    }
  }

  // Create with bounded concurrency. Each: resolve meta, decide auto-approve,
  // push to *arr (rolling back to PENDING on push failure, like the single route).
  const outcomes = await mapLimit<{ tmdbId: number; mediaType: MediaType }, CreateOutcome>(
    toCreate,
    ARR_CONCURRENCY,
    async (it) => {
      try {
        const meta = await resolveMediaMeta(it.tmdbId, it.mediaType);
        if (!meta) return { ...it, result: "error" };

        const autoApprove = canAutoApprove(targetPerms, it.mediaType, false);
        const baseData = {
          tmdbId: it.tmdbId,
          mediaType: it.mediaType,
          title: meta.title,
          posterPath: meta.posterPath,
          releaseYear: meta.releaseYear,
          note: null,
          requestedBy: targetUserId,
        };

        let request;
        try {
          request = await prisma.mediaRequest.create({
            data: { ...baseData, status: autoApprove ? "APPROVED" : "PENDING" },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            return { ...it, result: "already-requested" };
          }
          throw err;
        }

        emitSSE({ type: "request:new", requestId: request.id, userId: targetUserId });

        if (autoApprove) {
          try {
            if (it.mediaType === "MOVIE") {
              await addMovieToRadarr(it.tmdbId);
            } else {
              const tvdbId = await addSeriesToSonarr(it.tmdbId);
              await prisma.mediaRequest.update({ where: { id: request.id }, data: { tvdbId } });
            }
            return { ...it, result: "auto-approved" };
          } catch (err) {
            console.error(
              `[requests/bulk] auto-approve push failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
            );
            await prisma.mediaRequest
              .update({ where: { id: request.id }, data: { status: "PENDING" } })
              .catch(() => {});
            // Fell back to PENDING — treat as a normal pending creation.
            return { ...it, result: "created" };
          }
        }

        return { ...it, result: "created" };
      } catch (err) {
        console.error(
          `[requests/bulk] create failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
        );
        return { ...it, result: "error" };
      }
    },
  );

  const results = [...skipped, ...outcomes.map((o) => ({ tmdbId: o.tmdbId, mediaType: o.mediaType, result: o.result }))];
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
