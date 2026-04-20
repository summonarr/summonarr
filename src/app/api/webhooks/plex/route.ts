import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  isPlayHistoryEnabled,
  isSourceEnabled,
  resolveMediaServerUser,
  recordCompletedSession,
  getWatchedThreshold,
  resolveShowTmdbId,
} from "@/lib/play-history";
import { extractTmdbIdFromGuids } from "@/lib/plex";
import { checkAndRecordWebhook } from "@/lib/webhook-replay";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface PlexWebhookPayload {
  event: string;
  Account?: { id?: number; title?: string; thumb?: string };
  Player?: {
    title?: string;
    platform?: string;
    publicAddress?: string;
    uuid?: string;
    local?: boolean;
  };
  Metadata?: {
    ratingKey?: string;
    grandparentRatingKey?: string;
    title?: string;
    grandparentTitle?: string;
    parentIndex?: number;
    index?: number;
    type?: string;
    year?: number;
    duration?: number;
    viewOffset?: number;
    Guid?: Array<{ id: string }>;
    Media?: Array<{
      container?: string;
      bitrate?: number;
      videoResolution?: string;
    }>;
  };
  Session?: { id?: string };
}

export async function POST(req: NextRequest) {
  const secretRow = await prisma.setting.findUnique({ where: { key: "webhookSecret" } });
  const secret = secretRow?.value ?? "";
  if (secret.length === 0) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Plex webhook UI only sends query params, no header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;
  if (!token || !safeCompare(token, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (token === queryToken && queryToken) {
    console.warn(
      "[webhook/plex] Authenticated via ?token= query parameter. " +
      "This exposes the webhook secret in server/proxy logs. " +
      "Configure the Authorization header instead if your webhook source supports it."
    );
  }

  const rawBytes = new Uint8Array(await req.arrayBuffer());

  if (rawBytes.length > 1_048_576) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!await checkAndRecordWebhook("plex", secret, rawBytes)) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  if (!(await isPlayHistoryEnabled()) || !(await isSourceEnabled("plex"))) {
    return NextResponse.json({ message: "Play history tracking disabled for Plex" });
  }

  let payload: PlexWebhookPayload;
  try {
    // Plex sends webhooks as multipart/form-data with the JSON in the "payload" field, not raw JSON
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const boundary = contentType.match(/boundary=([^;,\s]+)/)?.[1];
      if (!boundary) {
        return NextResponse.json({ error: "Missing multipart boundary" }, { status: 400 });
      }
      const reparsed = new Response(rawBytes, {
        headers: { "content-type": contentType },
      });
      const formData = await reparsed.formData();
      const payloadStr = formData.get("payload");
      if (typeof payloadStr !== "string") {
        return NextResponse.json({ error: "Missing payload field" }, { status: 400 });
      }
      if (payloadStr.length > 100_000) {
        return NextResponse.json({ error: "Payload field too large" }, { status: 413 });
      }
      payload = JSON.parse(payloadStr);
    } else {
      payload = JSON.parse(new TextDecoder().decode(rawBytes));
    }
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const event = payload.event;
  if (!event) {
    return NextResponse.json({ error: "Missing event" }, { status: 400 });
  }

  const account = payload.Account;
  const meta = payload.Metadata;
  const player = payload.Player;

  if (!account?.id || !meta?.ratingKey) {
    return NextResponse.json({ message: "Ignoring event — missing account or metadata" });
  }

  if (!meta.type) {
    return NextResponse.json({ message: "ok" });
  }

  const accountId = String(account.id);
  const sessionKey = payload.Session?.id ?? `${accountId}:${meta.ratingKey}`;
  const sessionId = `plex:${sessionKey}`;
  const now = new Date();

  const msUserId = await resolveMediaServerUser({
    source: "plex",
    sourceUserId: accountId,
    username: account.title ?? "",
    thumbUrl: account.thumb ?? null,
  });

  const mediaType = meta.type === "episode" ? "TV" : meta.type === "movie" ? "MOVIE" : null;

  const tmdbId = meta.type === "episode"
    ? await resolveShowTmdbId("plex", meta.grandparentRatingKey)
    : extractTmdbIdFromGuids(meta.Guid);
  const title = meta.type === "episode"
    ? (meta.grandparentTitle ?? "")
    : meta.title ?? "";

  if (event === "media.play" || event === "media.resume") {
    let posterPath: string | null = null;
    if (tmdbId !== null && mediaType) {
      const core = await prisma.tmdbMediaCore.findUnique({
        where: { tmdbId_mediaType: { tmdbId, mediaType: mediaType as "MOVIE" | "TV" } },
        select: { posterPath: true },
      }).catch(() => null);
      posterPath = core?.posterPath ?? null;
    }

    await prisma.activeSession.upsert({
      where: { id: sessionId },
      update: { lastSeenAt: now, state: "playing", ...(posterPath ? { posterPath } : {}) },
      create: {
        id: sessionId,
        source: "plex",
        sessionKey,
        startedAt: now,
        lastSeenAt: now,
        state: "playing",
        mediaServerUserId: msUserId,
        serverUsername: account.title ?? "",
        tmdbId,
        mediaType,
        title,
        year: meta.year != null ? String(meta.year) : null,
        seasonNumber: meta.parentIndex ?? null,
        episodeNumber: meta.index ?? null,
        episodeTitle: meta.type === "episode" ? (meta.title ?? null) : null,
        sourceItemId: meta.ratingKey,
        posterPath,
        durationMs: BigInt(Math.max(0, meta.duration ?? 0)),
        platform: player?.platform ?? null,
        player: player?.title ?? null,
        device: player?.uuid ?? null,
        ipAddress: player?.publicAddress ?? null,
      },
    });
    return NextResponse.json({ message: `Session ${event} recorded` });
  }

  if (event === "media.pause") {
    await prisma.activeSession.updateMany({
      where: { id: sessionId },
      data: {
        lastSeenAt: now,
        state: "paused",
        ...(meta.viewOffset != null ? { progressMs: BigInt(Math.max(0, meta.viewOffset)) } : {}),
      },
    });
    return NextResponse.json({ message: "Session paused" });
  }

  if (event === "media.stop") {
    const session = await prisma.activeSession.findUnique({ where: { id: sessionId } });
    if (session) {
      await recordCompletedSession(session);
      return NextResponse.json({ message: "Session stopped and recorded" });
    }
    return NextResponse.json({ message: "Session not found (may have already ended)" });
  }

  if (event === "media.scrobble") {
    // Plex fires scrobble at ~90% progress; synthesize a progress position for completion tracking
    const session = await prisma.activeSession.findUnique({ where: { id: sessionId } });
    if (session) {
      const threshold = await getWatchedThreshold();
      const progressMs = Number(session.durationMs) * (threshold / 100);
      await prisma.activeSession.update({
        where: { id: sessionId },
        data: { progressMs: BigInt(Math.floor(progressMs)), lastSeenAt: now },
      });
    }
    return NextResponse.json({ message: "Scrobble noted" });
  }

  return NextResponse.json({ message: `Unhandled event: ${event}` });
}
