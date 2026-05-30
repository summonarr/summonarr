import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush } from "@/lib/push";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

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
  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  if (!checkRateLimit(`webhook:radarr:${clientIp}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const [sourceRow, legacyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "radarrWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const secret = sourceRow?.value || legacyRow?.value || "";

  if (secret.length === 0) {
    console.warn("[webhook/radarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Radarr's webhook UI has no Authorization header field — ?token= is the only
  // option upstream supports. Don't warn about it; nothing the user can do.

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    console.warn(`[webhook/radarr] 413 payload too large bytes=${rawBytes.length}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  let payload: RadarrWebhookPayload;
  try {
    const parsed = JSON.parse(rawBody);
    // JSON.parse("null") / primitives / arrays are valid JSON but not a payload
    // object; guard so the eventType dereference below can't throw a 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    payload = parsed;
  } catch (err) {
    console.warn("[webhook/radarr] 400 invalid JSON:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Test events have a fixed payload shape — admins clicking "Test" twice within
  // the 24h replay TTL would otherwise see the second click 409. Skip the digest
  // check and short-circuit before recording.
  if (payload.eventType === "Test") {
    return NextResponse.json({ ok: true, message: "Radarr webhook connected" });
  }

  // Canonical-JSON replay digest: a replay with reordered keys still produces the same digest
  if (!await checkAndRecordWebhookJson("radarr", secret, payload)) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  // Track whether the synchronous body completed; if it throws we roll back the
  // replay digest so Radarr's source-side retry can re-deliver.
  let syncCompleted = false;
  try {

  if (payload.eventType !== "Download" || !payload.movie?.tmdbId) {
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tmdbId } = payload.movie;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    console.warn("[webhook/radarr] 400 invalid tmdbId");
    syncCompleted = true;  // Bad payload from Radarr; retry won't help.
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

  // Advisory lock 1001,1 prevents a concurrent Radarr sync from overwriting the wanted table mid-transaction
  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
    // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
    const resetNotify = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", status: "APPROVED", availableAt: null },
      data: { status: "AVAILABLE", availableAt: new Date() },
    });
    const alreadyAvailable = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", status: "APPROVED", availableAt: { not: null } },
      data: { status: "AVAILABLE", availableAt: new Date() },
    });
    updated = { count: resetNotify.count + alreadyAvailable.count };
    await tx.radarrWantedItem.deleteMany({ where: { tmdbId } });
  }, { timeout: 30_000 });

  if (updated.count > 0) {
    void clearDeletionVotesForTmdbs([{ tmdbId, mediaType: "MOVIE" }]);
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId);

    const pending = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: "MOVIE", status: "AVAILABLE", notifiedAvailable: false },
      select: { id: true, requestedBy: true, title: true, mediaType: true, posterPath: true, tmdbId: true, user: { select: { mediaServer: true } } },
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

        const outcome = await notifyAdminGrabCompletedPush({
          userId: grab.triggeredById,
          title: grab.title,
          scope: grab.scope,
          seasonNumber: grab.seasonNumber,
          episodeNumber: grab.episodeNumber,
          issueId: grab.issueId,
        });
        // "failed" → reset notifiedAt for retry on the next webhook tick.
        // "skipped-no-subs" / "skipped-no-keys" → leave notifiedAt set
        // (retrying won't help; no subs/keys are missing operator-side), but
        // log so an operator can wire up email/Discord backstop notification.
        if (outcome === "failed") {
          await prisma.issueGrab.update({
            where: { id: grab.id, notifiedAt: now },
            data: { notifiedAt: null },
          }).catch(() => {});
          console.warn("[webhook/radarr] grab notification failed, reset for retry");
        } else if (outcome === "skipped-no-subs" || outcome === "skipped-no-keys") {
          console.warn(`[webhook/radarr] grab push skipped (${outcome}) for user=${grab.triggeredById} issue=${grab.issueId}`);
        }
      })
    );
  }

  syncCompleted = true;
  return NextResponse.json({ ok: true, marked: updated.count });
  } finally {
    if (!syncCompleted) {
      await clearWebhookReplayDigestJson("radarr", secret, payload);
    }
  }
}
