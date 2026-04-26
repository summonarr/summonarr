import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush } from "@/lib/push";
import { checkAndRecordWebhook } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { sanitizeForLog } from "@/lib/sanitize";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface SonarrWebhookPayload {
  eventType: string;
  series?: {
    tvdbId: number;
    tmdbId?: number;
    title: string;
  };
}

export async function POST(req: NextRequest) {
  const secretRow = await prisma.setting.findUnique({ where: { key: "webhookSecret" } });
  const secret = secretRow?.value ?? "";

  if (secret.length === 0) {
    console.warn("[webhook/sonarr] 401 secret not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Sonarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  if (!token || !safeCompare(token, secret)) {
    console.warn("[webhook/sonarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    console.warn(`[webhook/sonarr] 413 payload too large bytes=${rawBytes.length}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  if (!await checkAndRecordWebhook("sonarr", secret, rawBody)) {
    console.warn("[webhook/sonarr] 409 replayed webhook");
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  let payload: SonarrWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.warn("[webhook/sonarr] 400 invalid JSON:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.eventType === "Test") {
    console.warn("[webhook/sonarr] 200 event=Test");
    return NextResponse.json({ ok: true, message: "Sonarr webhook connected" });
  }

  if (payload.eventType !== "Download" || !payload.series) {
    const loggedEvent = payload.eventType === "Test" ? "Test" : payload.eventType === "Grab" ? "Grab" : "(other)";
    console.warn(`[webhook/sonarr] 200 skipped event=${loggedEvent}`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tvdbId, tmdbId, title } = payload.series;

  const safeVdbId = Number.isInteger(tvdbId) ? tvdbId : null;
  const safeMdbId = Number.isInteger(tmdbId) ? tmdbId : null;

  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };

  let effectiveMdbId: number | null = null;
  let effectiveVdbId: number | null = null;

  // Try tmdbId first; fall back to tvdbId because Sonarr may not always send tmdbId
  if (safeMdbId) {
    // Advisory lock 1001,2 prevents a concurrent Sonarr sync from overwriting the wanted table mid-transaction
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
      updated = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", status: "APPROVED" },
        data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: false },
      });
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: safeMdbId } });
    }, { timeout: 30_000 });
    if (updated.count > 0) effectiveMdbId = safeMdbId;
  }

  if (updated.count === 0 && safeVdbId) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;

      const req = await tx.mediaRequest.findFirst({
        where: { tvdbId: safeVdbId!, mediaType: "TV" },
        select: { tmdbId: true },
      });
      updated = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", status: "APPROVED" },
        data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: false },
      });
      if (req && updated.count > 0) {
        await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: req.tmdbId } });
      } else if (!req) {
        console.warn(`[webhooks/sonarr] could not evict sonarrWantedItem: no MediaRequest found for tvdbId ${sanitizeForLog(safeVdbId)}`);
      }
    }, { timeout: 30_000 });
    if (updated.count > 0) effectiveVdbId = safeVdbId;
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("tv", safeMdbId ?? undefined);

    const whereNotify = effectiveMdbId
      ? { tmdbId: effectiveMdbId, mediaType: "TV" as const, status: "AVAILABLE" as const, notifiedAvailable: false }
      : effectiveVdbId
      ? { tvdbId: effectiveVdbId, mediaType: "TV" as const, status: "AVAILABLE" as const, notifiedAvailable: false }
      : null;
    if (!whereNotify) return;

    const pending = await prisma.mediaRequest.findMany({
      where: whereNotify,
      select: { id: true, tmdbId: true, requestedBy: true, title: true, mediaType: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const tmdbIdForCheck = effectiveMdbId ?? pending[0].tmdbId;
    if (!tmdbIdForCheck) return;

    const [plexUrlRow, plexTokenRow, jfUrlRow, jfKeyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexUrlRow?.value && plexTokenRow?.value
        ? () => hasPlexItemByTmdbId(plexUrlRow.value!, plexTokenRow.value!, tmdbIdForCheck, "tv")
        : null,
      jfUrlRow?.value && jfKeyRow?.value
        ? () => hasJellyfinItemByTmdbId(jfUrlRow.value!, jfKeyRow.value!, tmdbIdForCheck, "tv")
        : null,
      "webhook/sonarr",
    ).catch((err) => { console.warn("[webhooks/sonarr] notification failed after marking AVAILABLE:", err); });
  });

  const grabWhere = safeMdbId
    ? { tmdbId: safeMdbId, mediaType: "TV" as const, notifiedAt: null }
    : safeVdbId
    ? { tvdbId: safeVdbId, mediaType: "TV" as const, notifiedAt: null }
    : null;
  if (grabWhere) {
    const pendingGrabs = await prisma.issueGrab.findMany({ where: grabWhere });
    if (pendingGrabs.length > 0) {
      const now = new Date();
      await Promise.all(
        pendingGrabs.map(async (grab) => {

          // CAS: ensure only one concurrent webhook fires the notification for this grab
          const claimed = await prisma.issueGrab.updateMany({
            where: { id: grab.id, notifiedAt: null },
            data: { notifiedAt: now },
          });
          if (claimed.count === 0) return;

          const sent = await notifyAdminGrabCompletedPush({
            userId: grab.triggeredById,
            title: grab.title,
            scope: grab.scope,
            seasonNumber: grab.seasonNumber,
            episodeNumber: grab.episodeNumber,
            issueId: grab.issueId,
          }).then(() => true).catch((err) => { console.error("[webhook/sonarr] grab push error:", err); return false; });
          if (!sent) {
            await prisma.issueGrab.update({
              where: { id: grab.id, notifiedAt: now },
              data: { notifiedAt: null },
            }).catch(() => {});
            console.warn("[webhook/sonarr] grab notification failed, reset for retry");
          }
        })
      );
    }
  }

  console.warn(
    `[webhook/sonarr] 200 event=Download tmdbId=${sanitizeForLog(safeMdbId ?? "none")} tvdbId=${sanitizeForLog(safeVdbId ?? "none")} title=${sanitizeForLog(JSON.stringify(title))} marked=${updated.count}`,
  );
  return NextResponse.json({ ok: true, marked: updated.count });
}
