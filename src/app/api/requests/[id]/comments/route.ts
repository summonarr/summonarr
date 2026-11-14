import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeText } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { logAudit, auditContext } from "@/lib/audit";
import { requesterAuditDetails } from "@/lib/audit-scrub";
import { emitSSE } from "@/lib/sse-emitter";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { canPostComment, canReadThread, parseCommentBody } from "@/lib/request-comments";
import { announceRequestComment } from "@/lib/request-comment-notify";
import { THREAD_READ_CAP } from "@/lib/api-body-limits";
import { splitAtCap, truncationHeaders } from "@/lib/truncation";
import { olderThanWhere, parseThreadCursor } from "@/lib/thread-cursor";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

type RouteContext = { params: Promise<{ id: string }> };

const FEATURE_KEY = "feature.behavior.requestComments";
// The newest comments a thread read returns; older ones drop off (X-Truncated).
const MAX_THREAD_MESSAGES = THREAD_READ_CAP;

// Mirrors the issue messages route: a thread is private to the requester and
// the people who manage requests. `email` is sent to managers only — the
// requester must not learn a name-less manager's address.
export const GET = withAuth(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const request = await prisma.mediaRequest.findUnique({ where: { id }, select: { requestedBy: true } });
  if (!request) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const isManager = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const isRequester = request.requestedBy === session.user.id;
  if (!canReadThread({ isManager, isRequester })) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
  }
  // A requester sees nothing while the feature is off; managers keep read access
  // so a thread already running can still be wound down.
  if (!isManager && !(await isFeatureEnabled(FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiUser.comments.disabled") }, { status: 403 });
  }

  // The NEWEST 500, answered oldest first: past the cap it is the oldest that
  // drop off, never the latest replies (the same window a re-request carries —
  // request-comment-carry.ts). The id breaks createdAt ties so the cut is stable.
  // `?before=<createdAt>|<id>` reads the page of comments older than that one
  // (same shape, same cap); X-Truncated then says whether still older ones remain.
  const before = parseThreadCursor(req.nextUrl.searchParams.get("before"));
  const newestFirst = await prisma.requestComment.findMany({
    where: { requestId: id, ...olderThanWhere(before) },
    include: { author: { select: { name: true, role: true, ...(isManager ? { email: true } : {}) } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_THREAD_MESSAGES + 1,
  });
  const { rows, truncated } = splitAtCap(newestFirst, MAX_THREAD_MESSAGES);
  return NextResponse.json(rows.reverse(), { headers: truncationHeaders(truncated, MAX_THREAD_MESSAGES) });
});

export const POST = withAuth(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`request-comment:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.comments.rateLimited") }, { status: 429 });
  }

  const { id } = await params;
  const request = await prisma.mediaRequest.findUnique({
    where: { id },
    select: {
      id: true, title: true, mediaType: true, tmdbId: true, posterPath: true,
      requestedBy: true, arrInstance: true, permanentlyDeclined: true,
      user: { select: { name: true } },
    },
  });
  if (!request) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const isManager = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const isRequester = request.requestedBy === session.user.id;
  const verdict = canPostComment({ isManager, isRequester }, { permanentlyDeclined: request.permanentlyDeclined });
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.reason === "closed" ? t("apiUser.comments.closed") : t("apiUser.common.forbidden") },
      { status: 403 },
    );
  }

  // Managers can still post with the feature off (closing notes); requesters cannot.
  if (!isManager && !(await isFeatureEnabled(FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiUser.comments.disabled") }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ body?: unknown }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parseCommentBody(parsed.body);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.error === "too-long" ? t("apiUser.comments.bodyTooLong") : t("apiUser.comments.bodyRequired") },
      { status: 400 },
    );
  }
  const text = sanitizeText(body.text);
  // sanitizeText can strip a body made only of markup characters down to nothing.
  if (!text) return NextResponse.json({ error: t("apiUser.comments.bodyRequired") }, { status: 400 });

  // The request was read above, outside any transaction: one deleted since then
  // fails the comment's foreign key (P2003), which is this route's 404, not a 500.
  // A bare create with no transaction around it, so catching is safe (guardrail 23).
  let comment;
  try {
    comment = await prisma.requestComment.create({
      data: { requestId: id, authorId: session.user.id, body: text, fromAdmin: isManager },
      include: { author: { select: { name: true, role: true, ...(isManager ? { email: true } : {}) } } },
    });
  } catch (err) {
    if (!isPrismaErrorCode(err, "P2003")) throw err;
    return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  }

  emitSSE({ type: "request:comment", requestId: id, userId: request.requestedBy });

  // Post-commit, so the swallowing variant (guardrail 26). Ids and the title only —
  // the comment body is user text and stays out of the audit trail. The requester is
  // named the way every request-moderation row names them (requesterAuditDetails),
  // so the account purge finds and scrubs these rows by request id (guardrail 33).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "REQUEST_COMMENT",
    target: `request:${id}`,
    details: {
      commentId: comment.id,
      fromAdmin: isManager,
      title: request.title,
      mediaType: request.mediaType,
      ...requesterAuditDetails(request.requestedBy, request.user?.name),
    },
    ...auditContext(req, session),
  });

  void announceRequestComment({
    request: {
      id, title: request.title, mediaType: request.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: request.tmdbId,
      posterPath: request.posterPath, requestedBy: request.requestedBy, arrInstance: request.arrInstance,
    },
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Someone",
    // The requester's label is resolved in THEIR language (requesterFacingAuthor).
    authorDisplayName: session.user.name ?? null,
    text,
    authorIsManager: isManager,
  });

  return NextResponse.json(comment, { status: 201 });
});
