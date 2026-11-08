import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { createIssue } from "@/lib/issue-create";
import { sessionForUser } from "@/lib/auto-request";
import { maintenanceGuard } from "@/lib/maintenance";
import type { Translator } from "@/lib/i18n/translate";
import { TMDB_POSTER_BASE, editOriginal, loadPending, requireLinkedSiteAccount, savePending } from "../reply";
import { PENDING_ISSUE } from "../pending-schemas";
import type { ComponentContext, PendingIssue, TmdbResult } from "../types";

type IssueScope = "FULL" | "SEASON" | "EPISODE";
type IssueSession = ReturnType<typeof sessionForUser>;

// Who may file from this button right now: the issues page is on, the clicker
// has a linked active account, maintenance lets them through and they are
// inside the web POST's per-user issue budget. Checked on the click, not only
// on the command, since the button outlives the command.
async function issuePickGate(t: Translator, discordUserId: string): Promise<{ refusal: string } | { session: IssueSession }> {
  if (!(await isFeatureEnabled("feature.page.issues"))) return { refusal: t("notify.bot.issue.disabled") };
  const linked = await requireLinkedSiteAccount(t, discordUserId);
  if ("refusal" in linked) return linked;
  const session = sessionForUser(linked.user);
  if (await maintenanceGuard(session)) return { refusal: t("notify.bot.maintenance") };
  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitIssues" } });
  if (!checkRateLimit(`issues:${linked.user.id}`, parseRateLimit(rlRow?.value, 10), 60 * 1000)) {
    return { refusal: t("notify.bot.tooFast") };
  }
  return { session };
}

function issueScopeOf(selected: TmdbResult, pending: PendingIssue): IssueScope {
  if (selected.mediaType !== "tv" || pending.season === null) return "FULL";
  return pending.episode !== null ? "EPISODE" : "SEASON";
}

function reportedWhere(t: Translator, scope: IssueScope, pending: PendingIssue): string | null {
  if (scope === "EPISODE") return t("notify.bot.issue.whereEpisode", { season: pending.season ?? 0, episode: pending.episode ?? 0 });
  if (scope === "SEASON") return t("notify.bot.issue.whereSeason", { season: pending.season ?? 0 });
  return null;
}

// `issuepick:<interactionId>:<discordUserId>:<index>` — an /issue result button.
export async function handleIssuePick(ctx: ComponentContext): Promise<void> {
  const { t, appId, token, customId, discordUserId } = ctx;
  const reply = (content: string) => editOriginal(appId, token, { content, embeds: [], components: [] });
  const [, pendingInteractionId, ownerId, idxStr] = customId.split(":");
  if (discordUserId !== ownerId) return;
  const key = `pi:${pendingInteractionId}:${discordUserId}`;
  const pending = await loadPending(key, PENDING_ISSUE);
  if (!pending) return reply(t("notify.bot.issue.expired"));
  const selected = pending.results[parseInt(idxStr, 10)];
  if (!selected) return reply(t("notify.bot.pick.invalid"));
  const gate = await issuePickGate(t, discordUserId);
  if ("refusal" in gate) return reply(gate.refusal);
  // Claim the search: one report per search, so a double click can't file two.
  const claimed = await prisma.discordSearchCache.deleteMany({ where: { queryKey: key } });
  if (claimed.count === 0) return reply(t("notify.bot.issue.expired"));

  const scope = issueScopeOf(selected, pending);
  // Nothing filed — a refusal or a throw — gives the search back, so another
  // result (or this one, once fixed) can still be picked instead of "search
  // expired".
  const giveBack = () => savePending(key, pending).catch(() => {});
  let created: Awaited<ReturnType<typeof createIssue>>;
  try {
    created = await createIssue(
      gate.session,
      {
        mediaType: selected.mediaType === "tv" ? "TV" : "MOVIE",
        tmdbId: selected.id,
        issueType: pending.issueType,
        scope,
        seasonNumber: scope === "FULL" ? undefined : (pending.season ?? undefined),
        episodeNumber: scope === "EPISODE" ? (pending.episode ?? undefined) : undefined,
        note: pending.note ?? undefined,
      },
      t,
    );
  } catch (err) {
    await giveBack();
    throw err;
  }
  const embed: Record<string, unknown> = { title: `${selected.title} (${selected.releaseYear})` };
  if (selected.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
  if (!created.ok) {
    await giveBack();
    embed.color = 0xed4245;
    embed.description = created.error;
  } else {
    // This handler is already detached from the interaction's request (the
    // route answered Discord before it ran), so the admin fan-out runs here
    // rather than through after(). It never throws.
    void created.notify();
    embed.color = 0x57f287;
    embed.description = [t("notify.bot.issue.reported"), reportedWhere(t, scope, pending)].filter(Boolean).join("\n");
  }
  await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
}
