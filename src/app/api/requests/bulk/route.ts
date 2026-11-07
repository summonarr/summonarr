import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { maintenanceGuard } from "@/lib/maintenance";
import { hasPermission, effectivePermissions, parseInstanceGrants, Permission } from "@/lib/permissions";
import { translateQuotaWindow } from "@/lib/quota";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { BULK_REQUEST_MAX_ITEMS } from "@/lib/request-limits";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { QuotaExceededError } from "@/lib/request-policy";
import {
  BULK_TARGET_SELECT,
  applyRatingCaps,
  bulkVisibleServers,
  classifyItems,
  clearRequestedDeletionVotes,
  createRowsTx,
  keyOf,
  loadFiler,
  prepareItems,
  pushAutoApproved,
  routeItems,
  type BulkContext,
  type CreatedRows,
  type MediaType,
} from "@/lib/request-bulk";

// Bulk request creation. Backs the collection "Request all" button and admin
// "request on behalf of" flow. A single self-item or whole collection both go
// through here; the single POST /api/requests stays self-only.
//
// CSRF: relies on the proxy Origin/Referer check for mutating /api/* (same as
// the admin batch-approve and settings PATCH routes) — no per-item _token.
//
// Each new PENDING row emits a `request:new` SSE (the admin request list is
// live), but per-item email/push/Discord admin nudges are intentionally NOT
// sent — a 50-item "Request all" would flood every admin channel. The one
// exception is an auto-approval whose push failed and rolled back to PENDING:
// the requester expected no review, so the call sends ONE admin alert for those
// rows (phase 3) and marks each `pushFailed` in the results.

// The item pipeline (routing, classification, caps, the create transaction and
// the Radarr/Sonarr push) is src/lib/request-bulk.ts; this handler keeps the
// HTTP half: the body, the target, the refusals, the audit and the answer.

// Shared with the collection "Request all" button, which chunks by it.
const MAX_ITEMS = BULK_REQUEST_MAX_ITEMS;

// The door check accepts ANY request grant, not just the umbrella bit.
// REQUEST_MOVIE / REQUEST_TV narrow REQUEST rather than depending on it
// (Overseerr semantics — either the umbrella OR the specific bit grants a
// type), and the permissions modal renders all three as independent
// checkboxes. So a perfectly ordinary mask of REQUEST_MOVIE|REQUEST_TV was
// 403'd here while the single-request route created the row happily, and the
// UI — which computes button visibility with the umbrella-aware canRequest —
// showed the button and surfaced a raw "Forbidden" beside it.
//
// This stays as a cheap door check rather than becoming withAuth: a caller
// with no request grant at all should be refused before paying the TMDB
// routing work. The REAL decision is per item, per media type and per
// instance, and it already lives at the canRequestInstance call below — which
// has been umbrella-correct since the route's first commit. This gate was
// simply stricter than the gate it precedes.
export const POST = withPermission([
  Permission.REQUEST,
  Permission.REQUEST_MOVIE,
  Permission.REQUEST_TV,
])(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  // Honour the admin's "requests per minute" Setting like the single POST and
  // the votes route do; a lower configured cap must bound "Request all" too.
  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const bulkLimit = parseRateLimit(rlRow?.value, 10);
  if (!checkRateLimit(`bulk:${session.user.id}`, bulkLimit, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const rawBody = await readJsonCapped<{ items?: unknown; onBehalfOfUserId?: unknown }>(req, 1048576);
  if (rawBody instanceof NextResponse) return rawBody;
  const body = rawBody;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: t("apiUser.requests.bulk.itemsRequired") }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS) {
    return NextResponse.json({ error: t("apiUser.common.tooManyItems", { max: MAX_ITEMS }) }, { status: 400 });
  }

  const parsed: { tmdbId: number; mediaType: MediaType }[] = [];
  for (const raw of body.items) {
    // A null/primitive element is a malformed item, not a TypeError (500).
    const it = (raw !== null && typeof raw === "object" ? raw : {}) as { tmdbId?: unknown; mediaType?: unknown };
    if (!Number.isInteger(it.tmdbId) || (it.tmdbId as number) <= 0) {
      return NextResponse.json({ error: t("apiUser.requests.bulk.itemTmdbId") }, { status: 400 });
    }
    // Bulk carries no per-item _token (the single POST's HMAC token is minted only
    // for an in-range id), so an INT4-overflowing id would reach the first keyed
    // mediaRequest read below and throw out of Prisma as a 500.
    if (!isTmdbIdInRange(it.tmdbId as number)) {
      return NextResponse.json({ error: t("apiUser.common.tmdbIdOutOfRange") }, { status: 400 });
    }
    if (it.mediaType !== "MOVIE" && it.mediaType !== "TV") {
      return NextResponse.json({ error: t("apiUser.requests.bulk.itemMediaType") }, { status: 400 });
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

  // Resolve the target user. A PRESENT but non-string id is a client bug, not
  // "no target": silently filing the rows under the caller re-targets requests
  // to the wrong account with a 201, where every other malformed field is a 400.
  if (body.onBehalfOfUserId !== undefined && body.onBehalfOfUserId !== null && typeof body.onBehalfOfUserId !== "string") {
    return NextResponse.json({ error: t("apiUser.requests.bulk.onBehalfIdInvalid") }, { status: 400 });
  }
  const onBehalfId =
    typeof body.onBehalfOfUserId === "string" && body.onBehalfOfUserId.length > 0
      ? body.onBehalfOfUserId
      : null;
  const isOnBehalf = onBehalfId !== null && onBehalfId !== session.user.id;
  if (isOnBehalf && !hasPermission(session.user.permissions, Permission.REQUEST_ON_BEHALF)) {
    return NextResponse.json(
      { error: t("apiUser.requests.bulk.onBehalfForbidden") },
      { status: 403 },
    );
  }
  const targetUserId = onBehalfId ?? session.user.id;

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: BULK_TARGET_SELECT,
  });
  if (!target) return NextResponse.json({ error: t("apiUser.requests.bulk.targetNotFound") }, { status: 404 });
  // A deactivated account can't sign in and shouldn't accumulate requests via the
  // on-behalf flow (the picker filters these out, but the id is client-supplied).
  if (target.deactivatedAt != null) {
    return NextResponse.json({ error: t("apiUser.requests.bulk.targetDeactivated") }, { status: 422 });
  }

  const targetPerms = effectivePermissions(target.role, target.permissions);

  // REQUEST_ON_BEHALF must not become a privilege-escalation primitive. Every gate
  // below (canRequestInstance, canAutoApproveInstance, maxContentRating, quota) is
  // evaluated against targetPerms — the TARGET's rights — so without this check a
  // plain user holding only REQUEST_ON_BEHALF could name an ADMIN as the target
  // (their id is freely readable from GET /api/requests/users, which is gated on the
  // same bit) and thereby auto-approve arbitrary titles past the review queue, reach
  // restricted/4K instances they hold no grant for, and bypass their own content-rating
  // cap and quota — with the requests attributed to that admin.
  //
  // Rule: a non-ADMIN actor may only act on behalf of a user whose effective rights are
  // a SUBSET of their own — you can never do by proxy what you cannot do yourself. Real
  // admins short-circuit (they already hold every bit), so the delegated-admin flow is
  // unchanged. Mirrors the "only an admin can modify an admin" gate in
  // /api/admin/users/[id].
  if (
    isOnBehalf &&
    !hasPermission(session.user.permissions, Permission.ADMIN) &&
    (targetPerms & ~session.user.permissions) !== 0n
  ) {
    return NextResponse.json(
      { error: t("apiUser.requests.bulk.targetMorePermissions") },
      { status: 403 },
    );
  }

  // The on-behalf filer's own instance grants, server visibility, cap and quota
  // (request-bulk.ts loadFiler): grant only what you hold.
  const { filerChecked, filerRow, filerMay } = await loadFiler(session, isOnBehalf);
  const ctx: BulkContext = {
    session,
    isOnBehalf,
    target,
    targetUserId,
    targetPerms,
    grants: parseInstanceGrants(target.instanceGrants),
    filerChecked,
    filerRow,
    filerMay,
  };

  // discordRequireLinkedAccountSite only gates SELF requests — an admin acting on
  // behalf is trusted and shouldn't be blocked by the target's link state.
  if (!isOnBehalf) {
    const reqLinked = await prisma.setting.findUnique({
      where: { key: "discordRequireLinkedAccountSite" },
    });
    if (reqLinked?.value === "true" && !target.discordId) {
      return NextResponse.json(
        { error: t("apiUser.common.discordLinkRequired") },
        { status: 403 },
      );
    }
  }

  const routing = await routeItems(ctx, items);
  const visible = bulkVisibleServers(ctx, routing.mediaAccess);
  const classified = await classifyItems(ctx, items, routing, visible);
  const { skipped, staleDeclinedIdByKey } = classified;
  const capped = await applyRatingCaps(ctx, classified.toCreate, routing, staleDeclinedIdByKey);
  const { ratingBlocked } = capped;

  if (capped.toCreate.length === 0) {
    return NextResponse.json({ results: [...skipped, ...ratingBlocked], created: 0 }, { status: 200 });
  }

  const { prepared, metaFailed } = await prepareItems(ctx, capped.toCreate, routing, staleDeclinedIdByKey);

  let created: CreatedRows = { createdRows: [], mirroredKeys: new Set() };
  if (prepared.length > 0) {
    try {
      created = await createRowsTx(ctx, prepared, classified);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const remaining = Math.max(0, err.limit - err.used);
        return NextResponse.json(
          {
            error: t(
              err.whose === "filer"
                ? err.mediaType === "MOVIE" ? "apiUser.requests.bulk.filerQuotaMovie" : "apiUser.requests.bulk.filerQuotaTv"
                : err.mediaType === "MOVIE" ? "apiUser.requests.bulk.quotaMovie" : "apiUser.requests.bulk.quotaTv",
              {
                limit: err.limit,
                window: translateQuotaWindow(t, err.windowLabel),
                remaining,
              },
            ),
          },
          { status: 429 },
        );
      }
      throw err;
    }
    clearRequestedDeletionVotes(ctx, prepared);
  }

  const outcomes = await pushAutoApproved(ctx, prepared, created);

  const results = [...skipped, ...metaFailed, ...ratingBlocked, ...outcomes];
  const createdCount = outcomes.filter((o) => o.result === "created" || o.result === "auto-approved").length;

  if (isOnBehalf) {
    // The account by id (+ display name), never the email — the convention for
    // a row ABOUT a user (audit-scrub.ts).
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "REQUEST_ON_BEHALF",
      target: `user:${targetUserId}`,
      details: { targetUserId, ...(target.name ? { targetUser: target.name } : {}), created: createdCount, results },
      ...auditContext(req, session),
    });
  }

  // 201 only when something was created — a batch where every item fell to
  // metaFailed / no row is the same zero-row outcome the all-skipped path
  // answers 200 for.
  return NextResponse.json({ results, created: createdCount }, { status: createdCount > 0 ? 201 : 200 });
});
