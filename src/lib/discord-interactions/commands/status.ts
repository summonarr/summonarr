import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import { editOriginal, truncateText } from "../reply";
import type { CommandContext } from "../types";

export async function handleStatusCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, discordUserId, requireLinked, isExemptByRole } = ctx;

  if (requireLinked && !isExemptByRole) {
    const linkedCheck = await prisma.user.findFirst({
      where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
      select: { id: true },
    });
    if (!linkedCheck) {
      await editOriginal(appId, token, { content: t("notify.bot.linkRequired") });
      return;
    }
  }
  // A disabled account reads nothing (guardrail 33), exactly as every
  // other command and button here refuses it; the answer stays "no
  // requests", which is what a stranger's Discord id gets too.
  const user = await prisma.user.findFirst({
    where: { discordId: discordUserId, deactivatedAt: null },
    select: { id: true },
  });
  if (!user) {
    await editOriginal(appId, token, { content: t("notify.bot.status.none") });
    return;
  }
  const requests = await prisma.mediaRequest.findMany({
    where: { requestedBy: user.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { title: true, mediaType: true, status: true, tmdbId: true },
  });
  if (!requests.length) {
    await editOriginal(appId, token, { content: t("notify.bot.status.none") });
    return;
  }

  const approvedMovieIds = requests.filter(r => r.status === "APPROVED" && r.mediaType === "MOVIE").map(r => r.tmdbId);
  const approvedTvIds    = requests.filter(r => r.status === "APPROVED" && r.mediaType === "TV").map(r => r.tmdbId);
  const [radarrQueued, sonarrQueued] = await Promise.all([
    // Any instance counts as queued — approved requests may target a named instance.
    approvedMovieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: approvedMovieIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
    approvedTvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: approvedTvIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);
  const radarrQueuedSet = new Set(radarrQueued.map(r => r.tmdbId));
  const sonarrQueuedSet = new Set(sonarrQueued.map(r => r.tmdbId));

  const emoji: Record<string, string> = { PENDING: "⏳", APPROVED: "🔄", DECLINED: "❌", AVAILABLE: "📺" };
  const knownStatus = new Set(["PENDING", "DECLINED", "AVAILABLE"]);
  const lines = requests.map((r) => {
    let statusLabel: string = knownStatus.has(r.status) ? t(`notify.bot.status.${r.status}`) : r.status;
    if (r.status === "APPROVED") {
      const inQueue = r.mediaType === "MOVIE" ? radarrQueuedSet.has(r.tmdbId) : sonarrQueuedSet.has(r.tmdbId);
      statusLabel = inQueue ? t("notify.bot.status.APPROVED_QUEUE") : t("notify.bot.status.APPROVED_PENDING");
    }
    const media = r.mediaType === "MOVIE" ? t("notify.bot.status.movie") : t("notify.bot.status.tv");
    return `${emoji[r.status] ?? "❓"} **${escMd(truncateText(r.title, 80))}** (${media}) — ${statusLabel}`;
  });
  await editOriginal(appId, token, { content: `${t("notify.bot.status.header")}\n${lines.join("\n")}` });
}
