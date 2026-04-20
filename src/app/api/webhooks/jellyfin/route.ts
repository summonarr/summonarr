import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  isPlayHistoryEnabled,
  isSourceEnabled,
  resolveMediaServerUser,
  recordCompletedSession,
  resolveShowTmdbId,
} from "@/lib/play-history";
import { checkAndRecordWebhook } from "@/lib/webhook-replay";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface JellyfinWebhookPayload {
  NotificationType?: string;
  UserId?: string;
  UserName?: string;
  ItemId?: string;
  ItemType?: string;
  SeriesId?: string;
  SeriesName?: string;
  SeasonNumber?: number;
  EpisodeNumber?: number;
  Name?: string;
  Year?: number;
  PlaybackPosition?: number;
  RunTime?: number;
  PlayedToCompletion?: boolean;
  DeviceName?: string;
  ClientName?: string;
  DeviceId?: string;
  IsPaused?: boolean;
  PlaybackPositionTicks?: number;
  RunTimeTicks?: number;
  ProviderIds?: Record<string, string>;
  PlaySessionId?: string;
  RemoteEndPoint?: string;
}

export async function POST(req: NextRequest) {
  const secretRow = await prisma.setting.findUnique({ where: { key: "webhookSecret" } });
  const secret = secretRow?.value ?? "";
  if (secret.length === 0) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Jellyfin webhook plugin doesn't always support Authorization headers
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;
  if (!token || !safeCompare(token, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (token === queryToken && queryToken) {
    console.warn(
      "[webhook/jellyfin] Authenticated via ?token= query parameter. " +
      "This exposes the webhook secret in server/proxy logs. " +
      "Configure the Authorization header instead if your webhook source supports it."
    );
  }

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  if (!await checkAndRecordWebhook("jellyfin", secret, rawBody)) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  if (!(await isPlayHistoryEnabled()) || !(await isSourceEnabled("jellyfin"))) {
    return NextResponse.json({ message: "Play history tracking disabled for Jellyfin" });
  }

  let payload: JellyfinWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = payload.NotificationType;
  if (!event) {
    return NextResponse.json({ error: "Missing NotificationType" }, { status: 400 });
  }

  if (!payload.UserId || !payload.ItemId) {
    return NextResponse.json({ message: "Ignoring event — missing user or item" });
  }

  const sessionKey = payload.PlaySessionId ?? `${payload.UserId}:${payload.ItemId}`;
  const sessionId = `jellyfin:${sessionKey}`;
  const now = new Date();

  const msUserId = await resolveMediaServerUser({
    source: "jellyfin",
    sourceUserId: payload.UserId,
    username: payload.UserName ?? "",
  });

  const mediaType = payload.ItemType === "Episode" ? "TV" : payload.ItemType === "Movie" ? "MOVIE" : null;

  let tmdbId: number | null;
  if (payload.ItemType === "Episode") {
    tmdbId = await resolveShowTmdbId("jellyfin", payload.SeriesId);
  } else {
    const tmdbRaw = payload.ProviderIds?.Tmdb ?? payload.ProviderIds?.tmdb;
    const parsed = tmdbRaw ? parseInt(tmdbRaw, 10) : NaN;
    tmdbId = Number.isFinite(parsed) ? parsed : null;
  }

  const title = payload.ItemType === "Episode"
    ? (payload.SeriesName ?? "")
    : payload.Name ?? "";

  // RunTimeTicks/PlaybackPositionTicks are 100-nanosecond ticks; divide by 10,000 for milliseconds
  const durationTicks = payload.RunTimeTicks ?? payload.RunTime ?? 0;
  const positionTicks = payload.PlaybackPositionTicks ?? payload.PlaybackPosition ?? 0;
  const durationMs = Math.max(0, Math.floor(durationTicks / 10_000));
  const positionMs = Math.max(0, Math.floor(positionTicks / 10_000));
  const progressPercent = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;

  if (event === "PlaybackStart") {
    const resolvedTmdbId = tmdbId !== null && !isNaN(tmdbId) ? tmdbId : null;
    let posterPath: string | null = null;
    if (resolvedTmdbId !== null && mediaType) {
      const core = await prisma.tmdbMediaCore.findUnique({
        where: { tmdbId_mediaType: { tmdbId: resolvedTmdbId, mediaType: mediaType as "MOVIE" | "TV" } },
        select: { posterPath: true },
      }).catch(() => null);
      posterPath = core?.posterPath ?? null;
    }

    await prisma.activeSession.upsert({
      where: { id: sessionId },
      update: { lastSeenAt: now, state: "playing", progressMs: BigInt(positionMs), progressPercent, ...(posterPath ? { posterPath } : {}) },
      create: {
        id: sessionId,
        source: "jellyfin",
        sessionKey,
        startedAt: now,
        lastSeenAt: now,
        state: "playing",
        mediaServerUserId: msUserId,
        serverUsername: payload.UserName ?? "",
        tmdbId: resolvedTmdbId,
        mediaType,
        title,
        year: payload.Year != null ? String(payload.Year) : null,
        seasonNumber: payload.SeasonNumber ?? null,
        episodeNumber: payload.EpisodeNumber ?? null,
        episodeTitle: payload.ItemType === "Episode" ? (payload.Name ?? null) : null,
        sourceItemId: payload.ItemId,
        posterPath,
        progressPercent,
        progressMs: BigInt(positionMs),
        durationMs: BigInt(durationMs),
        platform: payload.ClientName ?? null,
        player: payload.DeviceName ?? payload.ClientName ?? null,
        device: payload.DeviceName ?? null,
        ipAddress: payload.RemoteEndPoint ?? null,
      },
    });
    return NextResponse.json({ message: "PlaybackStart recorded" });
  }

  if (event === "PlaybackProgress") {
    const state = payload.IsPaused ? "paused" : "playing";
    await prisma.activeSession.updateMany({
      where: { id: sessionId },
      data: {
        lastSeenAt: now,
        state,
        progressMs: BigInt(positionMs),
        progressPercent,
      },
    });
    return NextResponse.json({ message: "PlaybackProgress updated" });
  }

  if (event === "PlaybackStop") {
    const session = await prisma.activeSession.findUnique({ where: { id: sessionId } });
    if (session) {
      await prisma.activeSession.update({
        where: { id: sessionId },
        data: { lastSeenAt: now, progressMs: BigInt(positionMs), progressPercent },
      });
      await recordCompletedSession({
        ...session,
        lastSeenAt: now,
        progressMs: BigInt(positionMs),
      });
      return NextResponse.json({ message: "PlaybackStop recorded" });
    }
    return NextResponse.json({ message: "Session not found" });
  }

  return NextResponse.json({ message: `Unhandled event: ${event}` });
}
