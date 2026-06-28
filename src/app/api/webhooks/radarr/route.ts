import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush, notifyAdminsManualInteractionRequiredPush } from "@/lib/push";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isMovieDownloadedInRadarr } from "@/lib/arr";

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
  downloadClient?: string;
}

export async function POST(req: NextRequest) {
  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  if (!checkRateLimit(`webhook:radarr:${clientIp}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const [sourceRow, source4kRow, legacyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "radarrWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "radarr4kWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const hdSecret = sourceRow?.value || legacyRow?.value || "";
  const fourKSecret = source4kRow?.value || "";

  if (hdSecret.length === 0 && fourKSecret.length === 0) {
    console.warn("[webhook/radarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Radarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  // Secret-as-discriminator: the 4K instance is configured with the 4K secret, so
  // the secret that matches tells us which instance fired. Compare against both
  // without an early return (no timing oracle). Guardrail 2: keep ?token= + the
  // timing-safe compare; no HMAC.
  const matchedHd = token != null && hdSecret.length > 0 && safeCompare(token, hdSecret);
  const matched4k = token != null && fourKSecret.length > 0 && safeCompare(token, fourKSecret);
  if (!token || (!matchedHd && !matched4k)) {
    console.warn("[webhook/radarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // HD wins a tie (both secrets equal = misconfig) so we default to the HD instance.
  const is4k = matched4k && !matchedHd;
  const secret = is4k ? fourKSecret : hdSecret;

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

  // Radarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically (mismatch, sample, etc.) and is parked in the queue. There's nothing to
  // mark available — alert admins (best-effort) so they can resolve it in Radarr's queue.
  if (payload.eventType === "ManualInteractionRequired") {
    const title = payload.movie?.title ?? "A movie";
    // Don't interpolate the payload-supplied title into the log line. It's a
    // remote-controlled string, and logging it verbatim is a log-injection vector:
    // an attacker could embed newlines/control characters to forge or corrupt log
    // entries. The title still reaches admins through the structured push below,
    // which doesn't share the log's plain-text framing.
    console.warn("[webhook/radarr] manual interaction required — resolve it in Radarr's queue");
    // Per-item one-shot gate (same idempotent pattern as the deletion-vote
    // threshold in /api/votes): Radarr re-emits ManualInteractionRequired for the
    // same parked release on every queue tick (changing queue id / progress), and
    // the replay digest hashes the full payload so each one passes — push exactly
    // once per stuck item. Key on the STABLE tmdbId + service, never the volatile
    // queue id/progress. ISO value lets the marker be pruned later.
    const stableTmdbId = payload.movie?.tmdbId;
    let shouldNotify = true;
    if (Number.isInteger(stableTmdbId) && (stableTmdbId as number) > 0) {
      const manualKey = `manualInteractionNotified:radarr:${stableTmdbId}`;
      const claim = await prisma.setting.createMany({
        data: [{ key: manualKey, value: new Date().toISOString() }],
        skipDuplicates: true,
      });
      shouldNotify = claim.count === 1;
    }
    if (shouldNotify) {
      after(() =>
        notifyAdminsManualInteractionRequiredPush({ service: "Radarr", title, detail: payload.downloadClient })
          .catch((err) => console.warn("[webhook/radarr] manual-interaction alert failed:", err)),
      );
    }
    syncCompleted = true;
    return NextResponse.json({ ok: true, manualInteraction: true });
  }

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

  // Never trust the payload's tmdbId on its own. The webhook secret authenticates
  // the request but does NOT prove the named title was actually downloaded: anyone
  // who learns the secret (or any process that can replay a captured request) could
  // POST a forged Download event for an arbitrary tmdbId and flip an APPROVED
  // request straight to AVAILABLE for a movie Radarr never grabbed. To close that,
  // verify the title against Radarr's own authoritative API before changing any
  // status. Tri-state result: `false` = Radarr is reachable and confirms there is
  // NO file, so we SKIP the flip (this is the forgery case we reject); `true` =
  // confirmed downloaded, proceed; `null` = we couldn't determine it (the HD/4K
  // variant isn't configured, or Radarr is unreachable) so we proceed optimistically
  // and let the periodic library sync reconcile availability later. Proceeding on
  // null is safe against forgery because an attacker cannot force a null result
  // without first breaking the operator's own Radarr connectivity.
  const downloaded = await isMovieDownloadedInRadarr(tmdbId, is4k ? "4k" : "hd");
  if (downloaded === false) {
    console.warn(`[webhook/radarr] Download event for tmdbId=${tmdbId} not confirmed downloaded in Radarr; skipping status flip.`);
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }

  // Advisory lock 1001,1 prevents a concurrent Radarr sync from overwriting the wanted table mid-transaction
  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
    // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
    const resetNotify = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", is4k, status: "APPROVED", availableAt: null },
      // Clear the approve-time 90s backstop: the item is downloaded, so a stale
      // timer would fire a false "download pending" if a later sync revert flips
      // this back to APPROVED.
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    const alreadyAvailable = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", is4k, status: "APPROVED", availableAt: { not: null } },
      // Clear the approve-time 90s backstop: the item is downloaded, so a stale
      // timer would fire a false "download pending" if a later sync revert flips
      // this back to APPROVED.
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    updated = { count: resetNotify.count + alreadyAvailable.count };
    await tx.radarrWantedItem.deleteMany({ where: { tmdbId, is4k } });
  }, { timeout: 30_000 });

  if (updated.count > 0) {
    void clearDeletionVotesForTmdbs([{ tmdbId, mediaType: "MOVIE" }]);
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId, is4k ? "4k" : "hd");

    // Scope by is4k to the variant that fired this webhook: an HD Download must not
    // sweep in the sibling 4K request (or vice versa) and notify it off the wrong grab.
    const pending = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: "MOVIE", is4k, status: "AVAILABLE", notifiedAvailable: false },
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
