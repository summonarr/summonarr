import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withPermission } from "@/lib/api-auth";
import { isArrConfigured } from "@/lib/arr";
import { ArrInstanceError } from "@/lib/arr-admin";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { hasPermission, Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadRequestArrStatus } from "@/lib/request-arr-status-data";

type RouteContext = { params: Promise<{ id: string }> };

// Each check is a few live Radarr/Sonarr reads (the title, its queue, its
// history); bounded per caller like the request queue's other arr actions.
const STATUS_LIMIT_PER_MIN = 30;

// "Why is this request stuck?" — the request queue's status check for one
// APPROVED (or AVAILABLE) request. Bound to the request's OWN title and
// instance (tmdbId, mediaType, arrInstance — guardrail 32): the caller names a
// request, never an arr id. Answers one verdict plus details
// (request-arr-status.ts has the verdicts and their precedence); a Radarr/Sonarr
// read that fails is the `unreachable` verdict, not an error status.
//
// MANAGE_REQUESTS delegates read this, so the answer is COARSE: phase,
// progress, time left, the attention flag with the arr's message scrubbed,
// quality names, counts and dates — never an output path, download id, download
// client or indexer name, release title or arr URL (guardrail 5e). Read-only
// and not audited; nothing is written here or upstream.
//
// `canOpenQueue` tells the panel whether to link the ADMIN-only Download Queue
// for a download that needs attention.
export const GET = withPermission(Permission.MANAGE_REQUESTS)(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`request-arr-status:${session.user.id}`, STATUS_LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }
  const { id } = await params;
  const row = await prisma.mediaRequest.findUnique({
    where: { id },
    select: { id: true, mediaType: true, tmdbId: true, tvdbId: true, status: true, arrInstance: true, requestedBy: true, approvedAt: true, createdAt: true },
  });
  if (!row) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  if (row.status !== "APPROVED" && row.status !== "AVAILABLE") {
    return NextResponse.json({ error: t("apiUser.requests.arrStatus.invalidStatus") }, { status: 409 });
  }
  const service = row.mediaType === "MOVIE" ? "radarr" : "sonarr";
  if (!isValidInstanceSlug(row.arrInstance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  if (!(await isArrConfigured(service, row.arrInstance))) return notConfigured(t, service, row.arrInstance);

  try {
    const status = await loadRequestArrStatus({
      service,
      instance: row.arrInstance,
      tmdbId: row.tmdbId,
      // Sonarr-sourced (the push and the webhook write it): the fallback when the series' tmdbId drifted.
      tvdbId: row.tvdbId ?? null,
      mediaType: row.mediaType,
      requestedBy: row.requestedBy,
      since: row.approvedAt ?? row.createdAt,
    });
    // The arr's row id leaves only with an admin, as the queue link's filter
    // (guardrail 5g keeps a delegate's view coarse); `queue` is additive.
    const { arrId, ...coarse } = status;
    const canOpenQueue = hasPermission(session.user.permissions, Permission.ADMIN);
    return NextResponse.json({
      ...coarse,
      canOpenQueue,
      queue: canOpenQueue && arrId !== null ? { service, instance: row.arrInstance, arrId } : null,
    });
  } catch (err) {
    // Configured keys for an instance the registry no longer lists (guardrail 32).
    if (err instanceof ArrInstanceError) return notConfigured(t, service, row.arrInstance);
    throw err;
  }
});

function notConfigured(t: Translator, service: "radarr" | "sonarr", instance: string): NextResponse {
  const error = instance === ""
    ? t("apiUser.common.notConfigured", { name: service === "radarr" ? "Radarr" : "Sonarr" })
    : t("apiUser.issues.instanceNotConfigured", { service, instance });
  return NextResponse.json({ error }, { status: 422 });
}
