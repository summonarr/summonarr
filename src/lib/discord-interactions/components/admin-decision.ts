import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { localizedTitleFor } from "@/lib/tmdb-localize";
import { notifyRequestStatusChange } from "@/lib/request-notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { scheduleDownloadCheck } from "@/lib/download-check";
import { logAudit } from "@/lib/audit";
import { effectivePermissions, hasPermission, Permission } from "@/lib/permissions";
import { emitSSE } from "@/lib/sse-emitter";
import { DISCORD_API, DISCORD_HOSTS, TMDB_POSTER_BASE, editOriginal } from "../reply";
import type { ComponentContext } from "../types";

// `admin_approve:<requestId>` / `admin_decline:<requestId>` — the buttons on the
// admin-channel "new request" embed.
export async function handleAdminDecision(ctx: ComponentContext): Promise<void> {
  const { t, channelT, appId, token, customId, discordUserId } = ctx;
  const colonIdx = customId.indexOf(":");
  const action = customId.substring(0, colonIdx);
  const requestId = customId.substring(colonIdx + 1);

  // Match the web UI gate (/api/requests/[id] PATCH → withPermission(MANAGE_REQUESTS)):
  // anyone holding the MANAGE_REQUESTS permission bit (the ADMIN superbit, or a
  // custom mask that includes it) can approve/decline — not just role=ADMIN. Look up by discordId,
  // then resolve the effective permission mask (ADMIN superbit / legacy-unseeded → role
  // preset) before checking the bit. `deactivatedAt: null` is load-bearing: deactivation
  // leaves role/permissions/discordId intact, so a banned admin would still pass the
  // MANAGE_REQUESTS check here and push approvals to the ARR instances — every
  // session-backed transport already hard-fails them (verifyAndRefreshSession).
  const adminUser = await prisma.user.findFirst({
    where: { discordId: discordUserId, deactivatedAt: null },
    select: { id: true, name: true, email: true, role: true, permissions: true },
  });
  const adminPerms = adminUser
    ? effectivePermissions(adminUser.role, adminUser.permissions)
    : 0n;
  if (!adminUser || !hasPermission(adminPerms, Permission.MANAGE_REQUESTS)) {
    await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}`, {
      allowedHosts: DISCORD_HOSTS,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: t("notify.bot.admin.noPermission"), flags: 64 }),
      timeoutMs: 15_000,
    });
    return;
  }
  const maintRow = await prisma.setting.findUnique({ where: { key: "maintenanceEnabled" } });
  if (maintRow?.value === "true") {
    // ADMIN bit, not the role string — maintenance.ts's web bypass keys off the
    // bit, and a bit-only granular admin shouldn't be blocked here either.
    if (!hasPermission(adminPerms, Permission.ADMIN)) {
      await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}`, {
        allowedHosts: DISCORD_HOSTS,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: t("notify.bot.admin.maintenance"), flags: 64 }),
        timeoutMs: 15_000,
      });
      return;
    }
  }
  if (!checkRateLimit(`discord-admin-action:${adminUser.id}`, 30, 60 * 1000)) {
    await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}`, {
      allowedHosts: DISCORD_HOSTS,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: t("notify.bot.admin.tooMany"), flags: 64 }),
      timeoutMs: 15_000,
    });
    return;
  }

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, mediaType: true, tmdbId: true, posterPath: true, status: true, requestedBy: true, qualityProfileId: true, arrInstance: true },
  });

  // The shared admin-channel embed is written in the instance default language,
  // and so is the title in it — the pending embed it edits was built that way
  // (discord-notify.ts, guardrail 40a); an English MediaRequest.title would
  // flip it back on click. Embed titles don't render markdown, so no escMd.
  const channelTitle = request
    ? await localizedTitleFor({ title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType }, null)
    : null;

  // Every final edit below passes `content: ""`: Discord's edit is a partial
  // PATCH, and withDiscordTimeout may already have written its "taking longer"
  // line into `content` on a slow arr push — an omitted field would leave it
  // standing above the finished embed.
  if (!request || request.status !== "PENDING") {
    const embed: Record<string, unknown> = {
      color: 0x71767B,
      title: channelTitle ?? channelT("notify.bot.admin.requestFallback"),
      description: channelT("notify.bot.admin.handled"),
      timestamp: new Date().toISOString(),
    };
    await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
    return;
  }

  const adminName = adminUser.name ?? adminUser.email;
  // Non-null from here: `request` survived the guard above.
  const localizedTitle: string = channelTitle ?? request.title;

  if (action === "admin_approve") {
    // Match the /api/requests/[id] PATCH path: set pendingNotifyAt so the sync
    // orchestrator's 90s "not yet downloading" follow-up notifier fires for
    // Discord-button approvals too. Arming the field is only half of it — the
    // scheduleDownloadCheck below is what runs the check PROMPTLY at ~90s; the
    // orchestrator sweep is the backstop for when this job is dropped or fails.
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "APPROVED", approvedAt: new Date(), pendingNotifyAt: new Date(Date.now() + 90_000) },
    });
    if (claimed.count === 0) {
      const embed: Record<string, unknown> = {
        color: 0x71767B,
        title: localizedTitle,
        description: channelT("notify.bot.admin.handled"),
        timestamp: new Date().toISOString(),
      };
      await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
      return;
    }
    let arrFailed = false;
    let pushedTvdbId: number | null = null;
    try {
      if (request.mediaType === "MOVIE") {
        // Forward the requester's stored quality profile (a REQUEST_ADVANCED web
        // requester may have chosen one) — parity with requests/[id] approve.
        await addMovieToRadarr(request.tmdbId, request.arrInstance, request.qualityProfileId ?? undefined, request.requestedBy);
      } else {
        pushedTvdbId = await addSeriesToSonarr(request.tmdbId, request.arrInstance, request.qualityProfileId ?? undefined, request.requestedBy);
      }
    } catch (err) {
      console.error("[interactions] admin_approve arr push failed:", err);
      // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
      // may have flipped this row to AVAILABLE since we claimed it.
      await prisma.mediaRequest.updateMany({ where: { id: requestId, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } });
      arrFailed = true;
    }
    // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the
    // series by this point, so a P2025 (row deleted mid-push) or transient DB error
    // must not trip the APPROVED->PENDING rollback and leave Sonarr grabbing content
    // the DB says is pending. updateMany no-ops on a concurrently deleted row.
    if (!arrFailed && pushedTvdbId !== null) {
      await prisma.mediaRequest.updateMany({ where: { id: requestId }, data: { tvdbId: pushedTvdbId } });
    }
    // Audit the Discord-driven approval the same way the HTTP /api/requests/[id] PATCH path does.
    // Without this, an admin clicking "Approve" in Discord leaves no trace in the audit log.
    void logAudit({
      userId: adminUser.id,
      userName: adminName,
      action: "REQUEST_APPROVE",
      target: `request:${request.id}`,
      details: { tmdbId: request.tmdbId, mediaType: request.mediaType, title: request.title, via: "discord", arrFailed },
      provider: "discord",
    });
    // Keep the admin request list live (parity with the web PATCH path's emit).
    emitSSE({ type: "request:updated", requestId: request.id, status: arrFailed ? "PENDING" : "APPROVED", userId: request.requestedBy });
    // Fan out push + email + Discord so a web/iOS requester without Discord linked
    // is still notified. Skip self-notify when the admin approved their own request.
    // Gate on the arr push sticking: on failure the row rolled back to PENDING, and
    // telling the requester "approved" would be a lie (the web PATCH path gates the
    // same way via arrPushSucceeded).
    // `requestId`, not the row's `id`: RequestInfo names the field requestId
    // (the web PATCH path passes `requestId: updated.id`), and the row's `id`
    // is simply ignored — every Discord-driven decision used to emit
    // `request.id: null` to the outbound channels.
    if (!arrFailed && request.requestedBy !== adminUser.id) {
      notifyRequestStatusChange("APPROVED", { ...request, requestId: request.id });
    }
    // Queued unconditionally, exactly like the web PATCH path: on an arr failure the
    // row rolled back to PENDING and the job's own status re-read bails, so there is
    // no second gate to keep in sync here.
    scheduleDownloadCheck({
      requestId: request.id,
      tmdbId: request.tmdbId,
      mediaType: request.mediaType,
      arrInstance: request.arrInstance,
      requestedBy: request.requestedBy,
      title: request.title,
    }, { name: "interactions:admin-approve-90s-download-check" });
    const embed: Record<string, unknown> = {
      color: arrFailed ? 0xFEE75C : 0x57F287,
      title: arrFailed
        ? channelT("notify.bot.admin.approvedArrFailedTitle", { title: localizedTitle })
        : channelT("notify.bot.admin.approvedTitle", { title: localizedTitle }),
      description: arrFailed
        ? channelT("notify.bot.admin.approvedByArrFailed", { admin: adminName })
        : channelT("notify.bot.admin.approvedBy", { admin: adminName }),
      timestamp: new Date().toISOString(),
    };
    if (request.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${request.posterPath}` };
    await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
  } else {
    // approvedAt: null — a decline withdraws any approval, including one whose
    // push failed and rolled back to PENDING (MediaRequest.approvedAt).
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "DECLINED", approvedAt: null },
    });
    if (claimed.count === 0) {
      const embed: Record<string, unknown> = {
        color: 0x71767B,
        title: localizedTitle,
        description: channelT("notify.bot.admin.handled"),
        timestamp: new Date().toISOString(),
      };
      await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
      return;
    }
    void logAudit({
      userId: adminUser.id,
      userName: adminName,
      action: "REQUEST_DECLINE",
      target: `request:${request.id}`,
      details: { tmdbId: request.tmdbId, mediaType: request.mediaType, title: request.title, via: "discord" },
      provider: "discord",
    });
    // Keep the admin request list live (parity with the web PATCH path's emit).
    emitSSE({ type: "request:updated", requestId: request.id, status: "DECLINED", userId: request.requestedBy });
    // Fan out push + email + Discord. Skip self-notify when the admin declined their own request.
    if (request.requestedBy !== adminUser.id) {
      notifyRequestStatusChange("DECLINED", { ...request, requestId: request.id });
    }
    const embed: Record<string, unknown> = {
      color: 0xED4245,
      title: channelT("notify.bot.admin.declinedTitle", { title: localizedTitle }),
      description: channelT("notify.bot.admin.declinedBy", { admin: adminName }),
      timestamp: new Date().toISOString(),
    };
    if (request.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${request.posterPath}` };
    await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
  }
}
