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

interface RadarrWebhookPayload {
  eventType: string;
  movie?: {
    tmdbId: number;
    title: string;
  };
}

export async function POST(req: NextRequest) {
  const secretRow = await prisma.setting.findUnique({ where: { key: "webhookSecret" } });
  const secret = secretRow?.value ?? "";

  if (secret.length === 0) {
    console.warn("[webhook/radarr] 401 secret not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Radarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  if (!token || !safeCompare(token, secret)) {
    console.warn("[webhook/radarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    console.warn(`[webhook/radarr] 413 payload too large bytes=${rawBytes.length}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  if (!await checkAndRecordWebhook("radarr", secret, rawBody)) {
    console.warn("[webhook/radarr] 409 replayed webhook");
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  let payload: RadarrWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.warn("[webhook/radarr] 400 invalid JSON:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.eventType === "Test") {
    console.warn("[webhook/radarr] 200 event=Test");
    return NextResponse.json({ ok: true, message: "Radarr webhook connected" });
  }

  if (payload.eventType !== "Download" || !payload.movie?.tmdbId) {
    const loggedEvent = payload.eventType === "Test" ? "Test" : payload.eventType === "Grab" ? "Grab" : "(other)";
    const loggedTmdbId = Number.isInteger(payload.movie?.tmdbId) ? payload.movie!.tmdbId : 0;
    console.warn(
      `[webhook/radarr] 200 skipped event=${sanitizeForLog(loggedEvent)} tmdbId=${loggedTmdbId}`,
    );
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tmdbId, title } = payload.movie;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    console.warn("[webhook/radarr] 400 invalid tmdbId");
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

  // Advisory lock 1001,1 prevents a concurrent Radarr sync from overwriting the wanted table mid-transaction
  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
    updated = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", status: "APPROVED" },
      data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: false },
    });
    await tx.radarrWantedItem.deleteMany({ where: { tmdbId } });
  }, { timeout: 30_000 });

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId);

    const pending = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: "MOVIE", status: "AVAILABLE", notifiedAvailable: false },
      select: { id: true, requestedBy: true, title: true, mediaType: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const [plexUrlRow, plexTokenRow, jfUrlRow, jfKeyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexUrlRow?.value && plexTokenRow?.value
        ? () => hasPlexItemByTmdbId(plexUrlRow.value!, plexTokenRow.value!, tmdbId, "movie")
        : null,
      jfUrlRow?.value && jfKeyRow?.value
        ? () => hasJellyfinItemByTmdbId(jfUrlRow.value!, jfKeyRow.value!, tmdbId, "movie")
        : null,
      "webhook/radarr",
    ).catch((err) => { console.warn("[webhooks/radarr] notification failed after marking AVAILABLE:", err); });
  });

  const pendingGrabs = await prisma.issueGrab.findMany({
    where: { tmdbId, mediaType: "MOVIE", notifiedAt: null },
  });
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
        }).then(() => true).catch((err) => { console.error("[webhook/radarr] grab push error:", err); return false; });
        if (!sent) {
          await prisma.issueGrab.update({
            where: { id: grab.id, notifiedAt: now },
            data: { notifiedAt: null },
          }).catch(() => {});
          console.warn("[webhook/radarr] grab notification failed, reset for retry");
        }
      })
    );
  }

  console.warn(
    `[webhook/radarr] 200 event=Download tmdbId=${tmdbId} title=${sanitizeForLog(JSON.stringify(title))} marked=${updated.count}`,
  );
  return NextResponse.json({ ok: true, marked: updated.count });
}
