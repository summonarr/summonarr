import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, searchMovieInRadarr, arrErrorMessage } from "@/lib/arr";
import { addSeriesToSonarr, searchSeriesInSonarr } from "@/lib/arr";
import { notifyUserDownloadPending, notifyUserAwaitingRelease } from "@/lib/discord-notify";
import { isMovieDownloadingInRadarr, isSeriesDownloadingInSonarr, getMovieReleaseInfo, getSeriesFirstAired } from "@/lib/arr";
import { emitSSE } from "@/lib/sse-emitter";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { notifyRequestStatusChange } from "@/lib/request-notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { scheduleDelayed } from "@/lib/delayed-jobs";

const VALID_STATUSES = ["APPROVED", "DECLINED", "AVAILABLE", "PENDING"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isTokenExpired(session) || session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!checkRateLimit(`admin-req:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const { id } = await params;

  let body: { status?: string; retry?: boolean; search?: boolean; adminNote?: string; permanent?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { status, retry, search, adminNote, permanent } = body;

  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > 1000)) {
    return NextResponse.json({ error: "adminNote must be a string under 1000 characters" }, { status: 400 });
  }
  const sanitizedAdminNote = sanitizeOptional(adminNote);

  const existing = await prisma.mediaRequest.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (search) {
    if (existing.status !== "APPROVED" && existing.status !== "AVAILABLE") {
      return NextResponse.json(
        { error: "Search is only valid for APPROVED or AVAILABLE requests" },
        { status: 400 }
      );
    }

    if (adminNote !== undefined) {
      await prisma.mediaRequest.update({ where: { id }, data: { adminNote: sanitizedAdminNote } });
    }
    let arrError: string | null = null;
    try {
      if (existing.mediaType === "MOVIE") {
        await searchMovieInRadarr(existing.tmdbId);
      } else {
        if (!existing.tvdbId) throw new Error("No TVDB ID stored — re-push the request first");
        await searchSeriesInSonarr(existing.tvdbId);
      }
    } catch (err) {
      console.error("[arr] Search failed:", err);
      arrError = arrErrorMessage(err);
    }
    return NextResponse.json({ ...existing, adminNote: sanitizedAdminNote ?? existing.adminNote, arrError });
  }

  if (retry) {
    if (existing.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Retry is only valid for APPROVED requests" },
        { status: 400 }
      );
    }

    if (adminNote !== undefined) {
      await prisma.mediaRequest.update({ where: { id }, data: { adminNote: sanitizedAdminNote } });
    }
    let arrError: string | null = null;
    try {
      if (existing.mediaType === "MOVIE") {
        await addMovieToRadarr(existing.tmdbId);
      } else {
        const tvdbId = await addSeriesToSonarr(existing.tmdbId);
        await prisma.mediaRequest.update({ where: { id }, data: { tvdbId } });
      }
    } catch (err) {
      console.error("[arr] Retry push failed:", err);
      arrError = arrErrorMessage(err);
    }
    return NextResponse.json({ ...existing, adminNote: sanitizedAdminNote ?? existing.adminNote, arrError });
  }

  if (!status || !VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const VALID_TRANSITIONS: Record<string, string[]> = {
    PENDING:   ["APPROVED", "DECLINED"],
    APPROVED:  ["AVAILABLE", "DECLINED"],
    DECLINED:  ["PENDING"],
    AVAILABLE: [],
  };

  const currentStatus = existing.status;
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(status)) {
    return NextResponse.json(
      { error: `Cannot transition from ${currentStatus} to ${status}` },
      { status: 422 }
    );
  }

  if (status === "APPROVED" && existing.status !== "APPROVED") {
    // CAS on current status prevents double-approve race conditions
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id, status: existing.status },
      data: {
        status: "APPROVED",
        ...(sanitizedAdminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),
        // pendingNotifyAt triggers a 90s download-check notification if the item still isn't in the queue
        pendingNotifyAt: new Date(Date.now() + 90_000),
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "Request was modified concurrently" }, { status: 409 });
    }
  } else if (status === "DECLINED" && existing.status !== "DECLINED") {
    // CAS on current status prevents double-decline races
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id, status: existing.status },
      data: {
        status: "DECLINED",
        permanentlyDeclined: permanent === true,
        ...(sanitizedAdminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),
        pendingNotifyAt: null,
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "Request was modified concurrently" }, { status: 409 });
    }
  } else {
    await prisma.mediaRequest.update({
      where: { id },
      data: {
        status: status as ValidStatus,
        ...(sanitizedAdminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),

        ...(status === "AVAILABLE" || status === "DECLINED" ? { pendingNotifyAt: null } : {}),

        ...(status === "AVAILABLE" && !existing.availableAt ? { availableAt: new Date() } : {}),
      },
    });
  }

  const updated = await prisma.mediaRequest.findUnique({
    where: { id },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  emitSSE({ type: "request:updated", requestId: id, status: updated.status, userId: existing.requestedBy });

  const requestedByName = existing.user?.name ?? existing.user?.email ?? existing.requestedBy;
  if (status === "APPROVED" && existing.status !== "APPROVED") {
    await logAuditOrFail({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_APPROVE", target: `request:${id}`, details: { title: updated.title, mediaType: updated.mediaType, year: updated.releaseYear, requestedBy: requestedByName, before: { status: existing.status }, after: { status } }, ...auditContext(req, session) });
  } else if (status === "DECLINED" && existing.status !== "DECLINED") {
    await logAuditOrFail({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_DECLINE", target: `request:${id}`, details: { title: updated.title, mediaType: updated.mediaType, year: updated.releaseYear, requestedBy: requestedByName, adminNote: updated.adminNote, before: { status: existing.status }, after: { status } }, ...auditContext(req, session) });
  }

  if (status === "APPROVED" && existing.status !== "APPROVED") {
    let arrError: string | null = null;
    try {
      if (updated.mediaType === "MOVIE") {
        await addMovieToRadarr(updated.tmdbId);
      } else {
        const tvdbId = await addSeriesToSonarr(updated.tmdbId);
        await prisma.mediaRequest.update({ where: { id }, data: { tvdbId } });
      }
    } catch (err) {
      console.error("[arr] Failed to push request:", err);
      arrError = arrErrorMessage(err);
    }

    notifyRequestStatusChange("APPROVED", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, posterPath: updated.posterPath, tmdbId: updated.tmdbId });

    scheduleDelayed(90_000, async () => {
      try {
        const current = await prisma.mediaRequest.findUnique({ where: { id }, select: { status: true } });
        if (current?.status !== "APPROVED") return;

        const downloading = updated.mediaType === "MOVIE"
          ? await isMovieDownloadingInRadarr(updated.tmdbId)
          : await isSeriesDownloadingInSonarr(updated.tmdbId);
        if (downloading) return;

        const now = new Date();
        let released = true;
        let soonestReleaseDate: string | null = null;

        if (updated.mediaType === "MOVIE") {
          const info = await getMovieReleaseInfo(updated.tmdbId);
          if (info) {
            const futureDates = [info.digitalRelease, info.physicalRelease]
              .filter((d): d is string => !!d && new Date(d) > now);
            const pastDates = [info.digitalRelease, info.physicalRelease]
              .filter((d): d is string => !!d && new Date(d) <= now);

            if (pastDates.length === 0 && futureDates.length > 0) {
              released = false;
              soonestReleaseDate = futureDates.sort()[0];
            }
          }
        } else {
          const firstAired = await getSeriesFirstAired(updated.tmdbId);
          if (firstAired && new Date(firstAired) > now) {
            released = false;
            soonestReleaseDate = firstAired;
          }
        }

        if (!released) {
          await notifyUserAwaitingRelease(updated.requestedBy, updated.title, updated.mediaType, soonestReleaseDate);
        } else {
          await notifyUserDownloadPending(updated.requestedBy, updated.title, updated.mediaType);
        }
        await prisma.mediaRequest.update({ where: { id }, data: { pendingNotifyAt: null } });
      } catch (err) {
        console.error("[download-check] 90s status check failed:", err);
      }
    }, { name: "requests:90s-download-check" });

    return NextResponse.json({ ...updated, arrError });
  }

  if (status === "AVAILABLE" && existing.status !== "AVAILABLE" && !existing.notifiedAvailable) {
    try {
      await prisma.mediaRequest.update({ where: { id }, data: { notifiedAvailable: true } });
    } catch (err) {
      console.error("[requests] Failed to set notifiedAvailable:", err);
    }

    // Clear any pending deletion votes when a request becomes available — they're no longer meaningful
    void prisma.deletionVote.deleteMany({
      where: { tmdbId: updated.tmdbId, mediaType: updated.mediaType },
    }).catch(() => {});
    notifyRequestStatusChange("AVAILABLE", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, posterPath: updated.posterPath, tmdbId: updated.tmdbId });
  }

  if (status === "DECLINED" && existing.status !== "DECLINED") {
    notifyRequestStatusChange("DECLINED", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, adminNote: updated.adminNote, posterPath: updated.posterPath, tmdbId: updated.tmdbId });
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isTokenExpired(session) || session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const existing = await prisma.mediaRequest.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.mediaRequest.delete({ where: { id } });
  emitSSE({ type: "request:deleted", requestId: id, userId: existing.requestedBy });
  await logAuditOrFail({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_DELETE", target: `request:${id}`, details: { title: existing.title, mediaType: existing.mediaType, year: existing.releaseYear, requestedBy: existing.user?.name ?? existing.user?.email ?? existing.requestedBy, before: { status: existing.status } }, ...auditContext(req, session) });
  return NextResponse.json({ ok: true });
}
