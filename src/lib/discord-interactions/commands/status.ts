import { DISCORD_SYNTHETIC_EMAIL_SUFFIX } from "@/lib/user-source";
import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import { editOriginal, truncateText } from "../reply";
import type { CommandContext } from "../types";

function queueKey(mediaType: string, tmdbId: number, arrInstance: string): string {
  return `${mediaType}:${tmdbId}:${arrInstance}`;
}

// The approved requests their OWN instance still lists as wanted — "in queue".
// A title wanted only on another instance (the 4K one, a named one) is not this
// request's download.
async function queuedApprovedKeys(
  requests: ReadonlyArray<{ status: string; mediaType: string; tmdbId: number; arrInstance: string }>,
): Promise<Set<string>> {
  const approved = requests.filter((r) => r.status === "APPROVED");
  const movieIds = approved.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const tvIds = approved.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  const [radarr, sonarr] = await Promise.all([
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
  ]);
  return new Set([
    ...radarr.map((r) => queueKey("MOVIE", r.tmdbId, r.arrInstance)),
    ...sonarr.map((r) => queueKey("TV", r.tmdbId, r.arrInstance)),
  ]);
}

export async function handleStatusCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, discordUserId, requireLinked, isExemptByRole } = ctx;

  // One read answers both gates. A disabled account reads nothing (guardrail 33)
  // and is told so, as /recent and /request tell it. A required link refuses a
  // missing or shadow (`@discord.local`) account.
  const user = await prisma.user.findUnique({
    where: { discordId: discordUserId },
    select: { id: true, email: true, deactivatedAt: true },
  });
  if (user?.deactivatedAt) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.deactivated") });
    return;
  }
  if (requireLinked && !isExemptByRole && (!user || user.email.endsWith(DISCORD_SYNTHETIC_EMAIL_SUFFIX))) {
    await editOriginal(appId, token, { content: t("notify.bot.linkRequired") });
    return;
  }
  if (!user) {
    await editOriginal(appId, token, { content: t("notify.bot.status.none") });
    return;
  }
  const requests = await prisma.mediaRequest.findMany({
    where: { requestedBy: user.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { title: true, mediaType: true, status: true, tmdbId: true, arrInstance: true },
  });
  if (!requests.length) {
    await editOriginal(appId, token, { content: t("notify.bot.status.none") });
    return;
  }

  const queued = await queuedApprovedKeys(requests);
  const emoji: Record<string, string> = { PENDING: "⏳", APPROVED: "🔄", DECLINED: "❌", AVAILABLE: "📺" };
  const knownStatus = new Set(["PENDING", "DECLINED", "AVAILABLE"]);
  const lines = requests.map((r) => {
    let statusLabel: string = knownStatus.has(r.status) ? t(`notify.bot.status.${r.status}`) : r.status;
    if (r.status === "APPROVED") {
      const inQueue = queued.has(queueKey(r.mediaType, r.tmdbId, r.arrInstance));
      statusLabel = inQueue ? t("notify.bot.status.APPROVED_QUEUE") : t("notify.bot.status.APPROVED_PENDING");
    }
    const media = r.mediaType === "MOVIE" ? t("notify.bot.status.movie") : t("notify.bot.status.tv");
    return `${emoji[r.status] ?? "❓"} **${escMd(truncateText(r.title, 80))}** (${media}) — ${statusLabel}`;
  });
  await editOriginal(appId, token, { content: `${t("notify.bot.status.header")}\n${lines.join("\n")}` });
}
