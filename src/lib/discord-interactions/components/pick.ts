import { prisma } from "@/lib/prisma";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { sessionForUser } from "@/lib/auto-request";
import { createMediaRequest, loadRequestContext, type CreateMediaRequestResult } from "@/lib/request-create";
import { TMDB_POSTER_BASE, editOriginal, quotaWindowLabel, releaseYearOf } from "../reply";
import type { ComponentContext, PendingSearch } from "../types";

// The Discord /request picker files through the request chokepoint
// (createMediaRequest) like the web route and the watchlist auto-request: the
// instance routing and its grants, quota, blacklist, content rating, duplicate
// and stale-decline handling, mirroring, auto-approve with its push and
// rollback, and the admin alerts are ONE copy. Only the Discord parts live here:
// the maintenance gate, the linked/shadow account, the deactivation gate, the
// auto-approve role, and the reply.

// The admin alerts run once the response is sent; Discord was answered before
// this handler started, so they run now.
function runNow(task: () => Promise<void>): void {
  void task().catch((err) => console.error("[interactions] admin alert failed:", err));
}

// `pick:<interactionId>:<discordUserId>:<index>` — a /request result button.
export async function handlePick(ctx: ComponentContext): Promise<void> {
  const { interaction, t, appId, token, customId, discordUser, discordUserId } = ctx;
  const [, interactionId, userId, idxStr] = customId.split(":");

  if (discordUserId !== userId) return;

  const key = `p:${interactionId}:${discordUserId}`;
  const cachedRow = await prisma.discordSearchCache.findUnique({ where: { queryKey: key } }).catch(() => null);
  let pending: PendingSearch | null = null;
  if (cachedRow && new Date() < cachedRow.expiresAt) {
    try { pending = JSON.parse(cachedRow.data) as PendingSearch; } catch { }
  }

  if (!pending) {
    prisma.discordSearchCache.delete({ where: { queryKey: key } }).catch(() => {});
    await editOriginal(appId, token, {
      content: t("notify.bot.pick.expired"),
      embeds: [],
      components: [],
    });
    return;
  }

  const idx = parseInt(idxStr, 10);
  const selected = pending.results[idx];
  if (!selected) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.invalid"), embeds: [], components: [] });
    return;
  }

  // The pending search row is NOT consumed here. Every gate (maintenance,
  // permission, blacklist, rating, quota, already-requested, permanently denied)
  // answers without creating anything; consuming the row first made the user's
  // next pick from the same results answer "search expired". It is deleted once
  // the chokepoint has filed the pick (or found the title already here).

  // The Discord-side settings this click reads, in one query (the request's own
  // are the chokepoint's, read by loadRequestContext).
  const settingRows = await prisma.setting.findMany({
    where: { key: { in: ["maintenanceEnabled", "discordRequireLinkedAccount", "discordAutoApproveRoles"] } },
  });
  const setting = new Map(settingRows.map((r) => [r.key, r.value]));

  // Maintenance gate: a user who ran /request BEFORE maintenance was enabled could
  // still click a result button afterward and create a request (incl. auto-approve
  // → ARR push). Block unless the clicker is a linked Discord admin (admins bypass).
  if (setting.get("maintenanceEnabled") === "true") {
    const discordAdmin = await prisma.user.findFirst({ where: { discordId: discordUserId, role: "ADMIN" }, select: { id: true } });
    if (!discordAdmin) {
      await editOriginal(appId, token, { content: t("notify.bot.maintenance"), embeds: [], components: [] });
      return;
    }
  }

  const mediaType = selected.mediaType === "movie" ? "MOVIE" : "TV";

  // A Discord auto-approve role both exempts the clicker from the linked-account
  // requirement and auto-approves the request (the chokepoint's `autoApprove`).
  const memberRoles: string[] = interaction.member?.roles ?? [];
  const requireLinkedComponent = setting.get("discordRequireLinkedAccount") === "true";
  const autoApproveRoles = (setting.get("discordAutoApproveRoles") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const hasAutoApproveRole = autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));

  let dbUser;
  if (requireLinkedComponent && !hasAutoApproveRole) {
    const linked = await prisma.user.findFirst({
      where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
    });
    if (!linked) {
      await editOriginal(appId, token, {
        content: t("notify.bot.linkRequiredToRequest"),
        embeds: [],
        components: [],
      });
      return;
    }
    dbUser = linked;
  } else {
    // Create a shadow user with a synthetic email; they can merge into a real account via /link.
    // Use the LIVE username from the component interaction rather than the cached
    // `pending.discordUsername` (which was captured at /request time and may be stale).
    const liveUsername = (discordUser.username as string | undefined) ?? pending.discordUsername;
    dbUser = await prisma.user.upsert({
      where: { discordId: discordUserId },
      // `permissions` is seeded on create only — deliberately NOT re-set on update, so an
      // admin's per-user permission edits aren't clobbered on every Discord interaction.
      // Legacy rows with permissions=0 stay correct via the effectivePermissions(role, …)
      // fallback in sessionForUser; don't "fix" this by adding permissions to `update`.
      update: {},
      create: {
        discordId: discordUserId,
        name: liveUsername,
        email: `discord_${discordUserId}@discord.local`,
        permissions: defaultPermissionsForRole("USER"),
      },
    });
    // Refresh the display name for SHADOW rows only. `/link` puts the same discordId on
    // the user's REAL row (mergeDiscordIntoWebAccount), so an unconditional
    // `update: { name }` rewrote a provider-provisioned name (Plex/OIDC/registration)
    // with the Discord handle on every result click — and nothing in the UI sets it back.
    if (dbUser.email.endsWith("@discord.local") && dbUser.name !== liveUsername) {
      dbUser = await prisma.user.update({ where: { id: dbUser.id }, data: { name: liveUsername } });
    }
  }

  const confirmEmbed: Record<string, unknown> = { title: selected.title };
  if (selected.posterPath) {
    confirmEmbed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
  }

  // Deactivation gate. A deactivated (banned) account keeps its role, permissions and
  // discordId fully intact — only `deactivatedAt` is set — so every permission check
  // below still passes for it. Session-backed transports hard-fail these users in
  // verifyAndRefreshSession; Discord is not session-backed, so without this the banned
  // user keeps creating (and, with an auto-approve role, auto-approving) requests.
  if (dbUser.deactivatedAt) {
    confirmEmbed.color = 0xed4245;
    confirmEmbed.description = `(${selected.releaseYear}) — ${t("notify.bot.pick.deactivated")}`;
    await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
    return;
  }

  // The chokepoint, as this account. Discord has no instance picker, no profile
  // and no note: routing is server-side (an auto-routed instance the user can't
  // use falls back to the default), and the title's metadata is the server's own
  // TMDB search result this pick came from.
  const result = await createMediaRequest(
    sessionForUser(dbUser),
    await loadRequestContext(dbUser.id),
    { tmdbId: selected.id, mediaType },
    t,
    {
      afterResponse: runNow,
      autoApprove: hasAutoApproveRole,
      meta: { title: selected.title, posterPath: selected.posterPath ?? null, releaseYear: releaseYearOf(selected) },
    },
  );

  if (!result.ok) {
    await editOriginal(appId, token, { content: "", embeds: [refusalEmbed(confirmEmbed, result, selected.releaseYear, t)], components: [] });
    return;
  }

  // Consume the pending search row only now: the pick is filed (or the title is
  // already here), and the reply that settles it follows. Best-effort — the row
  // also expires.
  prisma.discordSearchCache.delete({ where: { queryKey: key } }).catch(() => {});

  let note: string;
  if (result.kind === "already-available") {
    // A library hit is NOT a request: no row, so it doesn't consume the quota.
    note = t("notify.bot.pick.inLibrary");
    confirmEmbed.color = 0x57f287;
  } else if (result.branch === "auto-approve" && result.pushFailed) {
    // The push failed and the request rolled back to PENDING — don't tell the
    // user it's "being downloaded"; an admin will review it.
    note = t("notify.bot.pick.arrFailed");
    confirmEmbed.color = 0xfee75c;
  } else {
    note = t(result.branch === "auto-approve" ? "notify.bot.pick.autoApproved" : result.branch === "mirror-approved" ? "notify.bot.pick.mirrored" : "notify.bot.pick.pending");
    confirmEmbed.color = 0x57f287;
  }

  confirmEmbed.description = `(${selected.releaseYear}) — ${note}`;
  await editOriginal(appId, token, { content: t("notify.bot.pick.submitted"), embeds: [confirmEmbed], components: [] });
}

// The reply for a refused pick. A refusal the picker can't produce (it sends no
// instance, profile or note, and its metadata is the server's own) is a fault,
// thrown to the handler's error reply.
function refusalEmbed(
  embed: Record<string, unknown>,
  result: Extract<CreateMediaRequestResult, { ok: false }>,
  releaseYear: string | null | undefined,
  t: ComponentContext["t"],
): Record<string, unknown> {
  const red = (key: string) => ({ ...embed, color: 0xed4245, description: `(${releaseYear}) — ${t(key)}` });
  switch (result.reason) {
    case "forbidden":
      return red("notify.bot.pick.noPermission");
    case "blacklisted":
      return red("notify.bot.pick.blacklisted");
    case "rating-cap":
      return red("notify.bot.pick.rating");
    case "permanently-declined":
      return red("notify.bot.pick.permanentlyDenied");
    case "already-requested":
      return { ...embed, color: 0xfee75c, description: `(${releaseYear}) — ${t("notify.bot.pick.alreadyRequested")}` };
    case "quota":
      return {
        ...embed,
        color: 0xed4245,
        description: t("notify.bot.pick.quota", { limit: result.quota?.limit ?? 0, window: quotaWindowLabel(t, result.quota?.windowLabel) }),
      };
    default:
      throw new Error(`[interactions] unexpected request refusal: ${result.reason}`);
  }
}
