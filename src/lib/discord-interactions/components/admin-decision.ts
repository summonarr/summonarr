import { prisma } from "@/lib/prisma";
import { localizedTitleFor } from "@/lib/tmdb-localize";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { effectivePermissions, hasPermission, Permission } from "@/lib/permissions";
import {
  announceStatus,
  approvalAuditDetails,
  approvalStands,
  claimApproval,
  claimDecline,
  declineAuditDetails,
  followUpDecidedApprovals,
  notifyDecided,
  pushApproval,
  type PushOutcome,
} from "@/lib/request-transition";
import type { Translator } from "@/lib/i18n/translate";
import { TMDB_POSTER_BASE, editOriginal, ephemeralFollowup, handledEmbed } from "../reply";
import type { ComponentContext } from "../types";

// `admin_approve:<requestId>` / `admin_decline:<requestId>` — the buttons on the
// admin-channel "new request" card. The decision itself is the web PATCH's
// (request-transition.ts): the same claim, push, rollback, audit, notification
// and download check. Only the gate and the card live here.

const COLOR_APPROVED = 0x57f287;
const COLOR_WARNING = 0xfee75c;
const COLOR_DECLINED = 0xed4245;

// The admin who clicked, as the card and the audit name them.
interface Decider {
  id: string;
  name: string;
}

// The card's final edit. Every one passes `content: ""`: Discord's edit is a
// partial PATCH, and withDiscordTimeout may already have written its "taking
// longer" line into `content` on a slow arr push — an omitted field would leave
// it standing above the finished embed. For the same reason an edit that leaves
// out `components` keeps the card's buttons.
type CardEdit = {
  content: "";
  embeds: Record<string, unknown>[];
  components?: [];
};

export async function handleAdminDecision(ctx: ComponentContext): Promise<void> {
  const { channelT, appId, token, customId } = ctx;
  const colonIdx = customId.indexOf(":");
  const action = customId.substring(0, colonIdx);
  const requestId = customId.substring(colonIdx + 1);

  const decider = await authorizeDecider(ctx);
  if (!decider) return;

  const request = await loadDecisionRequest(requestId);
  // The shared admin-channel card is written in the instance default language,
  // and so is the title in it — the pending card it edits was built that way
  // (discord-notify.ts, guardrail 40a); an English MediaRequest.title would flip
  // it back on click. Embed titles don't render markdown, so no escMd.
  const title = request
    ? await localizedTitleFor({ title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType }, null)
    : channelT("notify.bot.admin.requestFallback");

  const edit = !request || request.status !== "PENDING"
    ? handledCard(channelT, title)
    : action === "admin_approve"
      ? await approveFromDiscord(channelT, decider, request, title)
      : await declineFromDiscord(channelT, decider, request, title);
  await editOriginal(appId, token, edit);
}

// Match the web gate (withPermission(MANAGE_REQUESTS) on /api/requests/[id]):
// anyone whose EFFECTIVE permissions hold MANAGE_REQUESTS (the ADMIN superbit,
// or a custom mask with it) may decide — not just role=ADMIN. `deactivatedAt:
// null` is load-bearing: deactivation leaves role, permissions and discordId
// intact, so a banned admin would still pass and push approvals to the arr —
// every session-backed transport already refuses them (verifyAndRefreshSession).
// Refusals are told to the clicker alone; the shared card stays as it is.
async function authorizeDecider(ctx: ComponentContext): Promise<Decider | null> {
  const { t, appId, token, discordUserId } = ctx;
  const adminUser = await prisma.user.findFirst({
    where: { discordId: discordUserId, deactivatedAt: null },
    select: { id: true, name: true, email: true, role: true, permissions: true },
  });
  const perms = adminUser ? effectivePermissions(adminUser.role, adminUser.permissions) : 0n;
  if (!adminUser || !hasPermission(perms, Permission.MANAGE_REQUESTS)) {
    await ephemeralFollowup(appId, token, t("notify.bot.admin.noPermission"));
    return null;
  }
  // The ADMIN bit bypasses maintenance, as on the web (maintenance.ts), and an
  // unreadable maintenance setting refuses everyone else.
  if (!hasPermission(perms, Permission.ADMIN) && (await getMaintenanceStatus()).enabled) {
    await ephemeralFollowup(appId, token, t("notify.bot.admin.maintenance"));
    return null;
  }
  if (!checkRateLimit(`discord-admin-action:${adminUser.id}`, 30, 60 * 1000)) {
    await ephemeralFollowup(appId, token, t("notify.bot.admin.tooMany"));
    return null;
  }
  return { id: adminUser.id, name: adminUser.name ?? adminUser.email };
}

// adminNote: a decline here writes none, so the requester is told the note the
// row already holds — what the web and batch declines send too. The requester's
// display name is for the audit row (never the email).
function loadDecisionRequest(id: string) {
  return prisma.mediaRequest.findUnique({
    where: { id },
    select: {
      id: true, title: true, mediaType: true, tmdbId: true, posterPath: true, status: true, requestedBy: true,
      qualityProfileId: true, arrInstance: true, adminNote: true, releaseYear: true,
      user: { select: { name: true } },
    },
  });
}

type DecisionRequest = NonNullable<Awaited<ReturnType<typeof loadDecisionRequest>>>;

async function approveFromDiscord(channelT: Translator, decider: Decider, request: DecisionRequest, title: string): Promise<CardEdit> {
  if (!(await claimApproval(request.id, "PENDING"))) return handledCard(channelT, title);
  announceStatus(request, "APPROVED");
  // With the requester's stored quality profile, like the web approve.
  const outcome = await pushApproval(request, "Discord approve");
  // Audited like the web approve, plus where it came from. `arrFailed` (any
  // definite push failure) is the field Discord rows always carried.
  void logAudit({
    userId: decider.id,
    userName: decider.name,
    action: "REQUEST_APPROVE",
    target: `request:${request.id}`,
    details: { ...approvalAuditDetails(request, "PENDING", outcome), tmdbId: request.tmdbId, via: "discord", arrFailed: !approvalStands(outcome) },
    provider: "discord",
  });
  followUpDecidedApprovals([{ row: request, outcome }], {
    actorId: decider.id,
    checkName: "interactions:admin-approve-90s-download-check",
    logScope: "interactions",
  });
  return approvalCard(channelT, decider, request.posterPath, title, outcome);
}

// The card after an approve, true to where the request now stands.
function approvalCard(channelT: Translator, decider: Decider, posterPath: string | null, title: string, outcome: PushOutcome): CardEdit {
  const admin = decider.name;
  if (outcome.kind === "rolled-back") {
    // Back in the queue: the card says so and KEEPS its buttons (no
    // `components`), so the request can be approved again or declined here.
    return {
      content: "",
      embeds: [cardEmbed(COLOR_WARNING, channelT("notify.bot.admin.approveRolledBackTitle", { title }), channelT("notify.bot.admin.approveRolledBackBy", { admin }), posterPath)],
    };
  }
  if (outcome.kind === "failed") {
    // A definite failure whose rollback did not land: the request was not
    // returned to the queue, and the arr does not hold it.
    return {
      content: "",
      embeds: [cardEmbed(COLOR_WARNING, channelT("notify.bot.admin.approvedArrFailedTitle", { title }), channelT("notify.bot.admin.approvedByArrFailed", { admin }), posterPath)],
      components: [],
    };
  }
  return {
    content: "",
    embeds: [cardEmbed(COLOR_APPROVED, channelT("notify.bot.admin.approvedTitle", { title }), channelT("notify.bot.admin.approvedBy", { admin }), posterPath)],
    components: [],
  };
}

async function declineFromDiscord(channelT: Translator, decider: Decider, request: DecisionRequest, title: string): Promise<CardEdit> {
  if (!(await claimDecline(request.id, "PENDING"))) return handledCard(channelT, title);
  announceStatus(request, "DECLINED");
  void logAudit({
    userId: decider.id,
    userName: decider.name,
    action: "REQUEST_DECLINE",
    target: `request:${request.id}`,
    details: { ...declineAuditDetails(request, "PENDING"), tmdbId: request.tmdbId, via: "discord" },
    provider: "discord",
  });
  void notifyDecided("DECLINED", [request], decider.id, "interactions");
  return {
    content: "",
    embeds: [cardEmbed(COLOR_DECLINED, channelT("notify.bot.admin.declinedTitle", { title }), channelT("notify.bot.admin.declinedBy", { admin: decider.name }), request.posterPath)],
    components: [],
  };
}

// Someone else decided it first (or it was removed): the card says so and
// drops its buttons.
function handledCard(channelT: Translator, title: string): CardEdit {
  return { content: "", embeds: [handledEmbed(channelT, title)], components: [] };
}

function cardEmbed(color: number, title: string, description: string, posterPath: string | null): Record<string, unknown> {
  return {
    color,
    title,
    description,
    timestamp: new Date().toISOString(),
    ...(posterPath ? { thumbnail: { url: `${TMDB_POSTER_BASE}${posterPath}` } } : {}),
  };
}
