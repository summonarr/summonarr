import { NextRequest, NextResponse } from "next/server";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, isMovieDownloadingInRadarr, isSeriesDownloadingInSonarr, getMovieReleaseInfo, getSeriesFirstAired } from "@/lib/arr";
import { notifyUserDownloadPending, notifyUserAwaitingRelease, assignDiscordRolesOnLink, notifyAdminsNewRequestDiscord } from "@/lib/discord-notify";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { notifyRequestStatusChange } from "@/lib/request-notifications";
import { Prisma } from "@/generated/prisma";
import { mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { scheduleDelayed } from "@/lib/delayed-jobs";
import { logAudit } from "@/lib/audit";
import { sanitizeForLog } from "@/lib/sanitize";
import { checkBodySize, assertBodyBytesUnderCap } from "@/lib/body-size";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { canAutoApprove, canRequest, defaultPermissionsForRole, effectivePermissions, hasPermission, Permission } from "@/lib/permissions";
import { isBlacklisted } from "@/lib/blacklist";
import { exceedsCap } from "@/lib/content-rating";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import { resolveUserQuota, parseQuotaLimit, type ResolvedQuota } from "@/lib/quota";
import { runWithSerializableRetry } from "@/lib/serializable-retry";
import { emitSSE } from "@/lib/sse-emitter";
import { isFeatureEnabled } from "@/lib/features";

export const dynamic = "force-dynamic";

const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];
const TMDB_HOSTS = ["api.themoviedb.org"];

let cachedPublicKey: string | null = null;

export function invalidatePublicKeyCache() {
  cachedPublicKey = null;
}

export async function prewarmPublicKeyCache(): Promise<void> {
  await getPublicKey();
}

async function getPublicKey(): Promise<string | null> {
  if (cachedPublicKey) return cachedPublicKey;
  const pkRow = await prisma.setting.findUnique({ where: { key: "discordPublicKey" } });
  if (pkRow?.value) cachedPublicKey = pkRow.value;
  return cachedPublicKey ?? null;
}

function verifySignature(publicKeyHex: string, signature: string, timestamp: string, body: string): boolean {
  try {
    // Discord sends Ed25519 raw keys; wrap with SPKI DER header so Node's crypto can parse it
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    const derKey = Buffer.concat([prefix, Buffer.from(publicKeyHex, "hex")]);
    const key = createPublicKey({ key: derKey, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

interface TmdbResult {
  id: number;
  title: string;
  mediaType: "movie" | "tv";
  releaseYear: string;
  posterPath: string | null;
  overview: string;
  voteAverage: number;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
}

async function attachAvailability(results: TmdbResult[]): Promise<TmdbResult[]> {
  if (results.length === 0) return results;
  const orClause = results.map((r) => ({
    tmdbId: r.id,
    mediaType: r.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
  }));
  const movieIds = results.filter((r) => r.mediaType === "movie").map((r) => r.id);
  const tvIds    = results.filter((r) => r.mediaType === "tv").map((r) => r.id);

  const [plexRows, jfRows, requestRows, radarrRows, sonarrRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({ where: { OR: orClause }, select: { tmdbId: true, mediaType: true } }),
    prisma.jellyfinLibraryItem.findMany({ where: { OR: orClause }, select: { tmdbId: true, mediaType: true } }),
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, OR: orClause },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const plexSet      = new Set(plexRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const jfSet        = new Set(jfRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const requestedSet = new Set(requestRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const radarrSet    = new Set(radarrRows.map((r) => r.tmdbId));
  const sonarrSet    = new Set(sonarrRows.map((r) => r.tmdbId));

  return results.map((r) => {
    const dbType = r.mediaType === "movie" ? "MOVIE" : "TV";
    const key = `${r.id}:${dbType}`;
    return {
      ...r,
      plexAvailable:     plexSet.has(key),
      jellyfinAvailable: jfSet.has(key),
      requested:         requestedSet.has(key),
      arrPending:        r.mediaType === "movie" ? radarrSet.has(r.id) : sonarrSet.has(r.id),
    };
  });
}

async function searchTmdb(query: string, type: "movie" | "tv"): Promise<TmdbResult[]> {
  const auth = tmdbAuth();
  if (!auth) throw new Error("No TMDB credentials configured (set TMDB_READ_TOKEN)");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("include_adult", "false");

  const res = await safeFetchTrusted(url.toString(), {
    allowedHosts: TMDB_HOSTS,
    headers: auth.headers,
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  const data = (await res.json()) as { results: Record<string, unknown>[] };

  return data.results
    .slice(0, 5)
    .map((item) => {
      const rawDate = (type === "movie" ? item.release_date : item.first_air_date) as string | undefined;
      const title = (type === "movie" ? item.title : item.name) as string | undefined;
      return {
        id: item.id as number,
        title: title ?? "",
        mediaType: type,
        releaseYear: rawDate ? rawDate.substring(0, 4) : "Unknown",
        posterPath: (item.poster_path as string | null) ?? null,
        overview: (item.overview as string) ?? "",
        voteAverage: (item.vote_average as number) ?? 0,
      };
    })
    .filter((r) => r.title.length > 0);
}

interface PendingSearch {
  results: TmdbResult[];
  discordUserId: string;
  discordUsername: string;
}

async function cachedSearchTmdb(query: string, type: "movie" | "tv", discordUserId: string): Promise<TmdbResult[]> {
  // Per-user cache scope prevents one Discord user's stale/poisoned results from leaking to others
  const key = `q:${discordUserId}:${type}:${query.toLowerCase().trim()}`;
  const cached = await prisma.discordSearchCache.findUnique({ where: { queryKey: key } }).catch(() => null);
  if (cached && new Date() < cached.expiresAt) {
    try { return JSON.parse(cached.data) as TmdbResult[]; } catch { }
  }
  const results = await searchTmdb(query, type);
  prisma.discordSearchCache.upsert({
    where:  { queryKey: key },
    create: { queryKey: key, data: JSON.stringify(results), expiresAt: new Date(Date.now() + 3_600_000) },
    update: { data: JSON.stringify(results), expiresAt: new Date(Date.now() + 3_600_000) },
  }).catch(() => {});
  return results;
}

async function editOriginal(appId: string, token: string, payload: Record<string, unknown>): Promise<void> {
  const res = await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`, {
    allowedHosts: DISCORD_HOSTS,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    console.error("[interactions] editOriginal failed:", res.status, await res.text());
  }
}

function buildResultsPayload(query: string, results: TmdbResult[], interactionId: string, discordUserId: string) {
  const embeds = results.map((r, i) => {
    const embed: Record<string, unknown> = {
      title: `${i + 1}. ${r.title} (${r.releaseYear})`,
      color: 0x5865f2,
    };

    const typeLine = r.mediaType === "movie" ? "🎬 Movie" : "📺 TV Show";
    const ratingLine = r.voteAverage > 0 ? `⭐ ${r.voteAverage.toFixed(1)}/10` : "";

    const statusParts: string[] = [];
    if (r.plexAvailable)                                          statusParts.push("🟡 On Plex");
    if (r.jellyfinAvailable)                                      statusParts.push("🔵 On Jellyfin");
    if (!r.plexAvailable && !r.jellyfinAvailable && r.arrPending) statusParts.push("🟠 Approved — In Queue");
    if (r.requested)                                              statusParts.push("✅ Already Requested");

    const desc = [
      [typeLine, ratingLine].filter(Boolean).join("  ·  "),
      statusParts.join("  ·  "),
      r.overview ? r.overview.substring(0, 200) : "",
    ].filter(Boolean).join("\n");

    if (desc) embed.description = desc;
    if (r.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${r.posterPath}` };
    return embed;
  });

  const components = [{
    type: 1,
    components: results.map((_, i) => ({
      type: 2,
      style: 1,
      label: `Select ${i + 1}`,
      custom_id: `pick:${interactionId}:${discordUserId}:${i}`,
    })),
  }];

  return {
    content: `Found **${results.length}** result(s) for **"${query}"**. Pick one:`,
    embeds,
    components,
  };
}

function withDiscordTimeout(
  fn: () => Promise<void>,
  appId: string,
  token: string,
  timeoutMs = 25_000,
): void {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void editOriginal(appId, token, {
      content: "This is taking longer than expected. Please try again.",
    }).catch(() => {});
  }, timeoutMs);

  void fn()
    .catch((err) => {
      if (!timedOut) {
        console.error("[interactions] handler error:", err);
        void editOriginal(appId, token, {
          content: "An unexpected error occurred. Please try again.",
        }).catch(() => {});
      }
    })
    .finally(() => clearTimeout(timer));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleCommand(interaction: any): Promise<void> {
  const appId = interaction.application_id as string;
  const token = interaction.token as string;
  const interactionId = interaction.id as string;
  const data = interaction.data;
  const discordUser = interaction.member?.user ?? interaction.user;
  const discordUserId = discordUser.id as string;
  const discordUsername = discordUser.username as string;
  const commandName = data.name as string;

  const channelId = interaction.channel_id as string | undefined;
  const memberRoles: string[] = interaction.member?.roles ?? [];

  const [welcomeRow, requireLinkedRow, autoApproveRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "discordWelcomeChannelId" } }),
    prisma.setting.findUnique({ where: { key: "discordRequireLinkedAccount" } }),
    prisma.setting.findUnique({ where: { key: "discordAutoApproveRoles" } }),
  ]);

  const welcomeChannelId = welcomeRow?.value?.trim() || null;
  const requireLinked = requireLinkedRow?.value === "true";
  const autoApproveRoles = (autoApproveRow?.value ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const isExemptByRole = autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));

  if (welcomeChannelId && channelId) {
    const inWelcome = channelId === welcomeChannelId;
    if (commandName === "link" && !inWelcome) {
      await editOriginal(appId, token, { content: `The \`/link\` command can only be used in the designated welcome channel.` });
      return;
    }
    if ((commandName === "request" || commandName === "status") && inWelcome) {
      await editOriginal(appId, token, { content: `The \`/${commandName}\` command is not available in this channel.` });
      return;
    }
  }

  try {
    if (commandName === "request") {
      const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
      const rlLimit = parseRateLimit(rlRow?.value, 20);
      if (!checkRateLimit(`discord-request:${discordUserId}`, rlLimit, 60 * 1000)) {
        await editOriginal(appId, token, { content: "You're making requests too quickly — please try again in a minute." });
        return;
      }

      const maintRow = await prisma.setting.findUnique({ where: { key: "maintenanceEnabled" } });
      if (maintRow?.value === "true") {
        const discordAdmin = await prisma.user.findFirst({ where: { discordId: discordUserId, role: "ADMIN" }, select: { id: true } });
        if (!discordAdmin) {
          await editOriginal(appId, token, { content: "The site is currently under maintenance. Please try again later." });
          return;
        }
      }

      if (requireLinked && !isExemptByRole) {
        const linkedUser = await prisma.user.findFirst({
          where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
          select: { id: true },
        });
        if (!linkedUser) {
          await editOriginal(appId, token, { content: "You need to link your Discord account to a site account before making requests. Use `/link` with a token from your Profile page." });
          return;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const type = data.options.find((o: any) => o.name === "type")?.value as "movie" | "tv";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = data.options.find((o: any) => o.name === "query")?.value as string;

      let results: TmdbResult[];
      try {
        const raw = await cachedSearchTmdb(query, type, discordUserId);
        results = await attachAvailability(raw);
      } catch (err) {
        console.error("[interactions] TMDB search error:", err);
        await editOriginal(appId, token, { content: "Search failed. Please try again." });
        return;
      }

      if (results.length === 0) {
        const label = type === "movie" ? "movies" : "TV shows";
        await editOriginal(appId, token, { content: `No ${label} found for **"${query}"**.` });
        return;
      }

      const key = `p:${interactionId}:${discordUserId}`;
      const pendingPayload: PendingSearch = { results, discordUserId, discordUsername };
      await prisma.discordSearchCache.upsert({
        where:  { queryKey: key },
        create: { queryKey: key, data: JSON.stringify(pendingPayload), expiresAt: new Date(Date.now() + 5 * 60_000) },
        update: { data: JSON.stringify(pendingPayload), expiresAt: new Date(Date.now() + 5 * 60_000) },
      });

      await editOriginal(appId, token, buildResultsPayload(query, results, interactionId, discordUserId));
    }

    else if (commandName === "status") {
      if (requireLinked && !isExemptByRole) {
        const linkedCheck = await prisma.user.findFirst({
          where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
          select: { id: true },
        });
        if (!linkedCheck) {
          await editOriginal(appId, token, { content: "You need to link your Discord account to a site account first. Use `/link` with a token from your Profile page." });
          return;
        }
      }
      const user = await prisma.user.findUnique({ where: { discordId: discordUserId } });
      if (!user) {
        await editOriginal(appId, token, { content: "You have no requests yet." });
        return;
      }
      const requests = await prisma.mediaRequest.findMany({
        where: { requestedBy: user.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { title: true, mediaType: true, status: true, tmdbId: true },
      });
      if (!requests.length) {
        await editOriginal(appId, token, { content: "You have no requests yet." });
        return;
      }

      const approvedMovieIds = requests.filter(r => r.status === "APPROVED" && r.mediaType === "MOVIE").map(r => r.tmdbId);
      const approvedTvIds    = requests.filter(r => r.status === "APPROVED" && r.mediaType === "TV").map(r => r.tmdbId);
      const [radarrQueued, sonarrQueued] = await Promise.all([
        approvedMovieIds.length > 0
          ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: approvedMovieIds }, is4k: false }, select: { tmdbId: true } })
          : Promise.resolve([]),
        approvedTvIds.length > 0
          ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: approvedTvIds }, is4k: false }, select: { tmdbId: true } })
          : Promise.resolve([]),
      ]);
      const radarrQueuedSet = new Set(radarrQueued.map(r => r.tmdbId));
      const sonarrQueuedSet = new Set(sonarrQueued.map(r => r.tmdbId));

      const emoji: Record<string, string> = { PENDING: "⏳", APPROVED: "🔄", DECLINED: "❌", AVAILABLE: "📺" };
      const lines = requests.map((r) => {
        let statusLabel: string = r.status;
        if (r.status === "APPROVED") {
          const inQueue = r.mediaType === "MOVIE" ? radarrQueuedSet.has(r.tmdbId) : sonarrQueuedSet.has(r.tmdbId);
          statusLabel = inQueue ? "APPROVED — In Queue" : "APPROVED — Pending";
        }
        return `${emoji[r.status] ?? "❓"} **${r.title}** (${r.mediaType === "MOVIE" ? "Movie" : "TV"}) — ${statusLabel}`;
      });
      await editOriginal(appId, token, { content: `**Your recent requests:**\n${lines.join("\n")}` });
    }

    else if (commandName === "link") {

      // Rate-limit per Discord user. Token entropy makes brute-force impractical
      // (32 hex chars = 128 bits), but parity with /request + defense-in-depth
      // if entropy is ever lowered. Also caps audit-log noise and Discord
      // rate-limit budget burn from a guild member spamming /link FOOBAR.
      if (!checkRateLimit(`discord-link:${discordUserId}`, 10, 60_000)) {
        await editOriginal(appId, token, { content: "Too many link attempts — try again in a minute." });
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenValue = (data.options?.find((o: any) => o.name === "token")?.value as string ?? "").trim().toUpperCase();
      if (!tokenValue) {
        await editOriginal(appId, token, { content: "Please provide your link token." });
        return;
      }

      const row = await prisma.discordLinkToken.findUnique({ where: { token: tokenValue }, include: { user: true } });
      if (!row) {
        await editOriginal(appId, token, { content: "Could not link account: Invalid token." });
        return;
      }
      if (row.expiresAt < new Date()) {
        await prisma.discordLinkToken.delete({ where: { token: tokenValue } });
        await editOriginal(appId, token, { content: "Could not link account: Token has expired — generate a new one on your Profile page." });
        return;
      }
      if (row.discordId && row.discordId !== discordUserId) {
        await editOriginal(appId, token, { content: "Could not link account: This token was generated for a different Discord account." });
        return;
      }
      const existing = await prisma.user.findUnique({ where: { discordId: discordUserId } });
      if (existing && existing.id !== row.userId && !existing.email.endsWith("@discord.local")) {
        await editOriginal(appId, token, { content: "Could not link account: This Discord account is already linked to another user." });
        return;
      }

      let transferNote = "";
      try {
        const { migrated } = await mergeDiscordIntoWebAccount(row.userId, discordUserId);
        if (migrated > 0) {
          transferNote = ` ${migrated} previous Discord request${migrated !== 1 ? "s" : ""} have been transferred to your account.`;
        }
      } catch (err) {
        console.error("[interactions] link account failed:", (err as Error).message);
        await editOriginal(appId, token, { content: "Could not link account. Please try again or contact an admin." });
        return;
      }

      // deleteMany (not delete): a concurrent duplicate /link submit races both
      // callers past the merge; the loser's bare delete would throw P2025 into the
      // outer catch and report "unexpected error" for a link that SUCCEEDED.
      await prisma.discordLinkToken.deleteMany({ where: { token: tokenValue } });
      void assignDiscordRolesOnLink(discordUserId, row.user.email, row.user.role);
      const userName = row.user.name ?? row.user.email;
      await editOriginal(appId, token, { content: `Your Discord account is now linked to **${userName}**'s Summonarr account!${transferNote} (Tip: your link token is single-use and was valid for 10 minutes — keep it private.)` });
    }
  } catch (err) {
    console.error("[interactions] handleCommand error:", err);
    await editOriginal(appId, token, { content: "An unexpected error occurred. Please try again." }).catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleComponent(interaction: any): Promise<void> {
  const appId = interaction.application_id as string;
  const token = interaction.token as string;
  const customId = interaction.data.custom_id as string;
  const discordUser = interaction.member?.user ?? interaction.user;
  const discordUserId = discordUser.id as string;

  try {
    if (customId.startsWith("pick:")) {
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
          content: "This search has expired. Please run `/request` again.",
          embeds: [],
          components: [],
        });
        return;
      }

      const idx = parseInt(idxStr, 10);
      const selected = pending.results[idx];
      if (!selected) {
        await editOriginal(appId, token, { content: "Invalid selection.", embeds: [], components: [] });
        return;
      }

      prisma.discordSearchCache.delete({ where: { queryKey: key } }).catch(() => {});

      // Maintenance gate: a user who ran /request BEFORE maintenance was enabled could
      // still click a result button afterward and create a request (incl. auto-approve
      // → ARR push). Block unless the clicker is a linked Discord admin (admins bypass).
      const componentMaintRow = await prisma.setting.findUnique({ where: { key: "maintenanceEnabled" } });
      if (componentMaintRow?.value === "true") {
        const discordAdmin = await prisma.user.findFirst({ where: { discordId: discordUserId, role: "ADMIN" }, select: { id: true } });
        if (!discordAdmin) {
          await editOriginal(appId, token, { content: "The site is currently under maintenance. Please try again later.", embeds: [], components: [] });
          return;
        }
      }

      const mediaType = selected.mediaType === "movie" ? "MOVIE" : "TV";

      const componentMemberRoles: string[] = interaction.member?.roles ?? [];
      const requireLinkedComponent = (await prisma.setting.findUnique({ where: { key: "discordRequireLinkedAccount" } }))?.value === "true";
      const componentAutoApproveRow = await prisma.setting.findUnique({ where: { key: "discordAutoApproveRoles" } });
      const componentAutoApproveRoles = (componentAutoApproveRow?.value ?? "").split(",").map((r) => r.trim()).filter(Boolean);
      const componentExempt = componentAutoApproveRoles.length > 0 && componentMemberRoles.some((r) => componentAutoApproveRoles.includes(r));

      let dbUser;
      if (requireLinkedComponent && !componentExempt) {
        const linked = await prisma.user.findFirst({
          where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
        });
        if (!linked) {
          await editOriginal(appId, token, {
            content: "You need to link your Discord account to a site account before making requests. Use `/link` with a token from your Profile page.",
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
          // fallback below; don't "fix" this by adding permissions to `update`.
          update: { name: liveUsername },
          create: {
            discordId: discordUserId,
            name: liveUsername,
            email: `discord_${discordUserId}@discord.local`,
            permissions: defaultPermissionsForRole("USER"),
          },
        });
      }

      const confirmEmbed: Record<string, unknown> = { title: selected.title };
      if (selected.posterPath) {
        confirmEmbed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
      }

      const existing = await prisma.mediaRequest.findFirst({
        // is4k-scoped: Discord requests are HD-only (is4k: false), so a web-created
        // 4K request for the same title must not block this user's HD request.
        where: { tmdbId: selected.id, mediaType, requestedBy: dbUser.id, is4k: false },
      });
      if (existing) {
        if (existing.permanentlyDeclined) {
          confirmEmbed.color = 0xed4245;
          confirmEmbed.description = `(${selected.releaseYear}) — This request has been permanently denied.`;
          await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
          return;
        }
        // An ordinary (non-permanent) decline is not terminal — parity with the web
        // route: drop the stale DECLINED row and fall through to a fresh request.
        // APPROVED/AVAILABLE/PENDING still block. deleteMany no-ops on a concurrent
        // double re-request instead of throwing.
        if (existing.status === "DECLINED") {
          // CAS on status + permanentlyDeclined: if an admin re-approved or made the
          // decline permanent between the read and here, the delete no-ops and the
          // create below 409s on the surviving row instead of orphaning/evading it.
          await prisma.mediaRequest.deleteMany({ where: { id: existing.id, status: "DECLINED", permanentlyDeclined: false } });
        } else {
          confirmEmbed.color = 0xfee75c;
          confirmEmbed.description = `(${selected.releaseYear}) — Already requested.`;
          await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
          return;
        }
      }

      // Effective permissions (ADMIN superbit / unseeded → role preset). Drives
      // both the quota bypass and the auto-approve decision below.
      const effPerms = effectivePermissions(dbUser.role, dbUser.permissions);

      // Enforce request permission (parity with the web route, which 403s on this).
      // Without it, a user whose admin set a permission mask omitting the REQUEST
      // bits could still create a request through Discord.
      if (!canRequest(effPerms, mediaType, false)) {
        confirmEmbed.color = 0xed4245;
        confirmEmbed.description = `(${selected.releaseYear}) — You don't have permission to request this.`;
        await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
        return;
      }

      // Blacklist gate (parity with the web chokepoints, which 403 on this):
      // an admin-blocked title must be rejected before any request row is
      // created, or Discord becomes a bypass around the blacklist.
      if (await isBlacklisted(selected.id, mediaType)) {
        confirmEmbed.color = 0xed4245;
        confirmEmbed.description = `(${selected.releaseYear}) — This title has been blocked by an administrator.`;
        await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
        return;
      }

      // Parental control (parity with the web chokepoints): block a request whose
      // US certification exceeds the user's cap. Only capped, non-admin users pay
      // the (cached) certification fetch; unknown/unrated titles and TMDB failures
      // are allowed — fail-open, same as requests/route.ts.
      if (dbUser.maxContentRating && !hasPermission(effPerms, Permission.ADMIN)) {
        let cert: string | undefined;
        try {
          const detail = mediaType === "MOVIE" ? await getMovieDetails(selected.id) : await getTVDetails(selected.id);
          cert = detail.certification;
        } catch {
          cert = undefined;
        }
        if (exceedsCap(cert, dbUser.maxContentRating)) {
          confirmEmbed.color = 0xed4245;
          confirmEmbed.description = `(${selected.releaseYear}) — This title's rating exceeds your account's limit.`;
          await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
          return;
        }
      }

      const [quotaLimitRow, quotaPeriodRow] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "quotaLimit" } }),
        prisma.setting.findUnique({ where: { key: "quotaPeriod" } }),
      ]);
      let rq: ResolvedQuota | null = null;
      let quotaApplies = false;
      if (!hasPermission(effPerms, Permission.QUOTA_UNLIMITED)) {
        quotaApplies = true;
        rq = resolveUserQuota(
          mediaType,
          {
            movieQuotaLimit: dbUser.movieQuotaLimit ?? null,
            movieQuotaDays: dbUser.movieQuotaDays ?? null,
            tvQuotaLimit: dbUser.tvQuotaLimit ?? null,
            tvQuotaDays: dbUser.tvQuotaDays ?? null,
          },
          parseQuotaLimit(quotaLimitRow?.value),
          quotaPeriodRow?.value ?? "week",
        );
        if (rq && rq.limit > 0) {
          const count = await prisma.mediaRequest.count({
            where: { requestedBy: dbUser.id, mediaType, createdAt: { gte: rq.since }, status: { notIn: ["DECLINED"] } },
          });
          if (count >= rq.limit) {
            confirmEmbed.color = 0xed4245;
            confirmEmbed.description = `You have reached your request quota of ${rq.limit} per ${rq.windowLabel}.`;
            await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
            return;
          }
        }
      }

      const [plexItem, jellyfinItem] = await Promise.all([
        prisma.plexLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId: selected.id, mediaType } } }),
        prisma.jellyfinLibraryItem.findUnique({ where: { tmdbId_mediaType: { tmdbId: selected.id, mediaType } } }),
      ]);
      const alreadyAvailable = !!plexItem || !!jellyfinItem;

      const baseData = {
        tmdbId: selected.id,
        mediaType,
        title: selected.title,
        posterPath: selected.posterPath ?? null,
        releaseYear: selected.releaseYear ?? null,
        note: null,
        requestedBy: dbUser.id,
      } as const;

      const memberRoles: string[] = interaction.member?.roles ?? [];
      const autoApproveRow = await prisma.setting.findUnique({ where: { key: "discordAutoApproveRoles" } });
      const autoApproveRoles = (autoApproveRow?.value ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      const hasAutoApproveRole = autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));

      const mayAutoApprove = hasAutoApproveRole || canAutoApprove(effPerms, mediaType, false);

      // Clear the requester's own delete-vote for this title — a request and a deletion
      // vote are contradictory, and the vote route already blocks the reverse.
      void prisma.deletionVote.deleteMany({ where: { userId: dbUser.id, tmdbId: selected.id, mediaType } });

      let note: string;
      try {
        if (alreadyAvailable) {
          // Parity with the web route (requests/route.ts alreadyAvailable branch):
          // a library hit is NOT a request — don't create a row, so it doesn't
          // consume the user's rolling quota. Still clear any deletion votes.
          void clearDeletionVotesForTmdbs([{ tmdbId: selected.id, mediaType }]);
          note = "It's already in the library!";
          confirmEmbed.color = 0x57f287;
        } else if (mayAutoApprove) {
          // pendingNotifyAt arms the orchestrator's 90s download backstop so a dropped
          // scheduleDelayed job still yields a follow-up notification.
          // Serializable is load-bearing: at the default Read Committed two concurrent
          // txs both read count < limit and both commit past the quota boundary, and
          // runWithSerializableRetry's P2034 retry can never fire (parity with
          // requests/route.ts and requests/bulk/route.ts).
          const request = await runWithSerializableRetry(async () =>
            prisma.$transaction(async (tx) => {
              if (quotaApplies && rq && rq.limit > 0) {
                const count = await tx.mediaRequest.count({
                  where: { requestedBy: dbUser.id, mediaType, createdAt: { gte: rq.since }, status: { notIn: ["DECLINED"] } },
                });
                if (count >= rq.limit) throw new Error("QUOTA_EXCEEDED");
              }
              return tx.mediaRequest.create({ data: { ...baseData, status: "APPROVED", pendingNotifyAt: new Date(Date.now() + 90_000) } });
            }, { isolationLevel: "Serializable" })
          );
          // Keep the admin request list live (every other creation path emits).
          emitSSE({ type: "request:new", requestId: request.id, userId: dbUser.id });
          let arrFailed = false;
          try {
            if (mediaType === "MOVIE") {
              await addMovieToRadarr(selected.id);
            } else {
              const tvdbId = await addSeriesToSonarr(selected.id);
              await prisma.mediaRequest.update({ where: { id: request.id }, data: { tvdbId } });
            }
          } catch (err) {
            console.error("[interactions] arr push failed:", err);
            // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
            // may have flipped this row to AVAILABLE between create and here. Clear
            // pendingNotifyAt too: the push failed, so there's no download to pend.
            await prisma.mediaRequest.updateMany({ where: { id: request.id, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } });
            arrFailed = true;
          }
          if (arrFailed) {
            // Corrective SSE: request:new above announced this row as APPROVED, but
            // the push failed and it rolled back to PENDING — emit the update so the
            // admin request list doesn't stay stuck at APPROVED (parity with the web
            // POST/PATCH rollback paths, which emit the same corrective event).
            emitSSE({ type: "request:updated", requestId: request.id, status: "PENDING", userId: dbUser.id });
            // The push failed and the request rolled back to PENDING — don't tell
            // the user it's "being downloaded"; surface that an admin will review it.
            note = "Your request was received, but couldn't be queued automatically — an admin will review it shortly.";
            confirmEmbed.color = 0xfee75c;
          } else {
            note = "Your request was auto-approved and is being downloaded. You'll get a ping when it's ready!";
            confirmEmbed.color = 0x57f287;
          }

          scheduleDelayed(90_000, async () => {
            try {
              const current = await prisma.mediaRequest.findUnique({ where: { id: request.id }, select: { status: true } });
              if (current?.status !== "APPROVED") return;

              const downloading = mediaType === "MOVIE"
                ? await isMovieDownloadingInRadarr(selected.id)
                : await isSeriesDownloadingInSonarr(selected.id);
              // Skip on true (downloading) AND null (queue unreadable); only a
              // confirmed "not downloading" fires the pending notify.
              if (downloading !== false) return;

              const now = new Date();
              let released = true;
              let soonestReleaseDate: string | null = null;

              if (mediaType === "MOVIE") {
                const info = await getMovieReleaseInfo(selected.id);
                if (info) {
                  const futureDates = [info.digitalRelease, info.physicalRelease]
                    .filter((d): d is string => !!d && new Date(d) > now);
                  const pastDates = [info.digitalRelease, info.physicalRelease]
                    .filter((d): d is string => !!d && new Date(d) <= now);
                  if (pastDates.length === 0 && futureDates.length > 0) {
                    released = false;
                    soonestReleaseDate = futureDates.sort()[0];
                  }
                }
              } else {
                const firstAired = await getSeriesFirstAired(selected.id);
                if (firstAired && new Date(firstAired) > now) {
                  released = false;
                  soonestReleaseDate = firstAired;
                }
              }

              if (!released) {
                await notifyUserAwaitingRelease(dbUser.id, selected.title, mediaType, soonestReleaseDate);
              } else {
                await notifyUserDownloadPending(dbUser.id, selected.title, mediaType);
              }
            } catch (err) {
              console.error("[interactions] 90s download-check failed:", err);
            }
          }, { name: "interactions:90s-download-check" });
        } else {
          // If another request for this title is already APPROVED or AVAILABLE, the
          // content is already greenlit — mirror that status so this user is tracked
          // for the "now available" notification, and skip the admin "new request"
          // alert (nothing to review). Discord requests are HD-only (is4k: false).
          // One Serializable tx covers the quota recount, the greenlit check, and
          // the mirror/pending create (parity with requests/route.ts) — mirror rows
          // are APPROVED/AVAILABLE and count against the quota window, so a create
          // outside the tx would let concurrent picks overshoot the boundary.
          let mirrored = false;
          const createdRequest = await runWithSerializableRetry(async () =>
            prisma.$transaction(async (tx) => {
              mirrored = false; // reset — the callback re-runs on a P2034 retry
              if (quotaApplies && rq && rq.limit > 0) {
                const count = await tx.mediaRequest.count({
                  where: { requestedBy: dbUser.id, mediaType, createdAt: { gte: rq.since }, status: { notIn: ["DECLINED"] } },
                });
                if (count >= rq.limit) throw new Error("QUOTA_EXCEEDED");
              }
              const alreadyGreenlit = await tx.mediaRequest.findFirst({
                where: { tmdbId: selected.id, mediaType, is4k: false, status: { in: ["APPROVED", "AVAILABLE"] } },
                select: { status: true },
              });
              if (alreadyGreenlit) {
                mirrored = true;
                // Mirror availableAt when the greenlit status is AVAILABLE, matching the
                // alreadyAvailable branch — otherwise an AVAILABLE mirror row has a null
                // availableAt and looks freshly approved.
                return tx.mediaRequest.create({
                  data: {
                    ...baseData,
                    status: alreadyGreenlit.status,
                    ...(alreadyGreenlit.status === "AVAILABLE" ? { availableAt: new Date() } : {}),
                  },
                });
              }
              return tx.mediaRequest.create({ data: baseData });
            }, { isolationLevel: "Serializable" })
          );
          // Keep the admin request list live (every other creation path emits).
          emitSSE({ type: "request:new", requestId: createdRequest.id, userId: dbUser.id });
          if (mirrored) {
            note = "Added — this title is already approved, so you'll be notified when it's ready.";
            confirmEmbed.color = 0x57f287;
          } else {
            const pendingRequest = createdRequest;
            const requestedBy = dbUser.name ?? dbUser.email ?? dbUser.id;
            // Only the earliest PENDING request for a title alerts admins — a later duplicate
            // (different user requesting the same still-pending title) is nothing new to review.
            const earlierPending = await prisma.mediaRequest.findFirst({
              where: {
                tmdbId: selected.id,
                mediaType,
                is4k: false,
                status: "PENDING",
                id: { not: pendingRequest.id },
                OR: [
                  { createdAt: { lt: pendingRequest.createdAt } },
                  { createdAt: pendingRequest.createdAt, id: { lt: pendingRequest.id } },
                ],
              },
              select: { id: true },
            });
            if (!earlierPending) {
              void notifyAdminsNewRequest({ title: selected.title, mediaType, requestedBy, note: null, posterPath: selected.posterPath ?? null, tmdbId: selected.id, releaseYear: selected.releaseYear ?? null, excludeUserId: dbUser.id });
              void notifyAdminsNewRequestPush({ title: selected.title, mediaType, requestedBy, tmdbId: selected.id, excludeUserId: dbUser.id });
              void notifyAdminsNewRequestDiscord({ requestId: pendingRequest.id, title: selected.title, mediaType, requestedBy, note: null, posterPath: selected.posterPath ?? null });
            }
            note = "An admin will review your request.";
            confirmEmbed.color = 0x57f287;
          }
        }
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          confirmEmbed.color = 0xfee75c;
          confirmEmbed.description = `(${selected.releaseYear}) — Already requested.`;
          await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
          return;
        }
        if (err instanceof Error && err.message === "QUOTA_EXCEEDED") {
          confirmEmbed.color = 0xed4245;
          confirmEmbed.description = `You have reached your request quota of ${rq?.limit ?? 0} per ${rq?.windowLabel ?? "period"}.`;
          await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
          return;
        }
        throw err;
      }

      confirmEmbed.description = `(${selected.releaseYear}) — ${note}`;
      await editOriginal(appId, token, { content: "Request submitted!", embeds: [confirmEmbed], components: [] });
    }

    else if (customId.startsWith("admin_approve:") || customId.startsWith("admin_decline:")) {
      const colonIdx = customId.indexOf(":");
      const action = customId.substring(0, colonIdx);
      const requestId = customId.substring(colonIdx + 1);

      // Match the web UI gate (/api/requests/[id] PATCH → withPermission(MANAGE_REQUESTS)):
      // anyone holding the MANAGE_REQUESTS permission bit (ADMIN superbit, ISSUE_ADMIN+,
      // or a custom mask) can approve/decline — not just role=ADMIN. Look up by discordId,
      // then resolve the effective permission mask (ADMIN superbit / legacy-unseeded → role
      // preset) before checking the bit.
      const adminUser = await prisma.user.findFirst({
        where: { discordId: discordUserId },
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
          body: JSON.stringify({ content: "⛔ You don't have permission to use these buttons.", flags: 64 }),
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
            body: JSON.stringify({ content: "Service unavailable during maintenance.", flags: 64 }),
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
          body: JSON.stringify({ content: "Too many attempts — please wait.", flags: 64 }),
          timeoutMs: 15_000,
        });
        return;
      }

      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        select: { id: true, title: true, mediaType: true, tmdbId: true, posterPath: true, status: true, requestedBy: true },
      });

      if (!request || request.status !== "PENDING") {
        const embed: Record<string, unknown> = {
          color: 0x71767B,
          title: request?.title ?? "Request",
          description: "This request has already been handled.",
          timestamp: new Date().toISOString(),
        };
        await editOriginal(appId, token, { embeds: [embed], components: [] });
        return;
      }

      const adminName = adminUser.name ?? adminUser.email;

      if (action === "admin_approve") {
        // Match the /api/requests/[id] PATCH path: set pendingNotifyAt so the sync orchestrator's
        // 90s "not yet downloading" follow-up notifier fires for Discord-button approvals too.
        const claimed = await prisma.mediaRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: { status: "APPROVED", pendingNotifyAt: new Date(Date.now() + 90_000) },
        });
        if (claimed.count === 0) {
          const embed: Record<string, unknown> = {
            color: 0x71767B,
            title: request.title,
            description: "This request has already been handled.",
            timestamp: new Date().toISOString(),
          };
          await editOriginal(appId, token, { embeds: [embed], components: [] });
          return;
        }
        let arrFailed = false;
        try {
          if (request.mediaType === "MOVIE") {
            await addMovieToRadarr(request.tmdbId);
          } else {
            const tvdbId = await addSeriesToSonarr(request.tmdbId);
            await prisma.mediaRequest.update({ where: { id: requestId }, data: { tvdbId } });
          }
        } catch (err) {
          console.error("[interactions] admin_approve arr push failed:", err);
          // CAS on status: only roll back if still APPROVED — a concurrent webhook/sync
          // may have flipped this row to AVAILABLE since we claimed it.
          await prisma.mediaRequest.updateMany({ where: { id: requestId, status: "APPROVED" }, data: { status: "PENDING", pendingNotifyAt: null } });
          arrFailed = true;
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
        if (!arrFailed && request.requestedBy !== adminUser.id) {
          notifyRequestStatusChange("APPROVED", request);
        }
        const embed: Record<string, unknown> = {
          color: arrFailed ? 0xFEE75C : 0x57F287,
          title: arrFailed ? `⚠️ Approved (arr failed) — ${request.title}` : `✅ Approved — ${request.title}`,
          description: arrFailed
            ? `Approved by **${adminName}** but could not be added to arr — please add manually.`
            : `Approved by **${adminName}**`,
          timestamp: new Date().toISOString(),
        };
        if (request.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${request.posterPath}` };
        await editOriginal(appId, token, { embeds: [embed], components: [] });
      } else {
        const claimed = await prisma.mediaRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: { status: "DECLINED" },
        });
        if (claimed.count === 0) {
          const embed: Record<string, unknown> = {
            color: 0x71767B,
            title: request.title,
            description: "This request has already been handled.",
            timestamp: new Date().toISOString(),
          };
          await editOriginal(appId, token, { embeds: [embed], components: [] });
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
          notifyRequestStatusChange("DECLINED", request);
        }
        const embed: Record<string, unknown> = {
          color: 0xED4245,
          title: `❌ Declined — ${request.title}`,
          description: `Declined by **${adminName}**`,
          timestamp: new Date().toISOString(),
        };
        if (request.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${request.posterPath}` };
        await editOriginal(appId, token, { embeds: [embed], components: [] });
      }
    } else {
      await editOriginal(appId, token, { content: "This button is no longer active." }).catch(() => {});
    }
  } catch (err) {
    console.error("[interactions] handleComponent error:", err);
    await editOriginal(appId, token, { content: "An unexpected error occurred.", embeds: [], components: [] }).catch(() => {});
  }
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const body = await req.text();
  // Post-read backstop for chunked-transfer clients that omit Content-Length
  // (Discord doesn't, but a malicious proxy might rewrite headers).
  const oversize = assertBodyBytesUnderCap(new TextEncoder().encode(body), 1_048_576);
  if (oversize) return oversize;

  const publicKey = await getPublicKey();
  if (!publicKey) {
    return new NextResponse("Bot not configured — set discordPublicKey in Settings", { status: 503 });
  }

  if (!verifySignature(publicKey, signature, timestamp, body)) {
    console.warn(`[interactions] Signature verification failed sigLen=${sanitizeForLog(signature.length)} bodyLen=${sanitizeForLog(body.length)}`);
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  // Reject replayed requests: Discord requires servers to enforce a 5-second timestamp window.
  // Asymmetric tolerance — past timestamps must be < 5s old (Discord's rule); future timestamps
  // are accepted up to 2s for benign clock skew but anything beyond is rejected, since a future
  // timestamp widens the replay window.
  const requestAge = Date.now() / 1000 - Number(timestamp);
  if (Number.isNaN(requestAge) || requestAge > 5 || requestAge < -2) {
    console.warn(`[interactions] Stale or skewed timestamp rejected: age=${sanitizeForLog(requestAge.toFixed(1))}s`);
    return new NextResponse("Request timestamp too old", { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let interaction: any;
  try {
    interaction = JSON.parse(body);
  } catch {
    console.warn("[interactions] Malformed JSON body after signature verification");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // type=1 is Discord's PING to verify the endpoint is reachable; respond with PONG immediately
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
  }

  // Feature gate: the flag previously gated only the notify libs, so disabling the
  // Discord integration still left slash commands and admin buttons fully live.
  // PING stays exempt (above) so Discord's endpoint verification keeps passing while
  // the feature is off; real interactions get an ephemeral explanation (type 4 + flags 64).
  if (!(await isFeatureEnabled("feature.integration.discord"))) {
    return NextResponse.json({ type: 4, data: { content: "The Discord integration is currently disabled.", flags: 64 } });
  }

  // Replay guard (defense-in-depth beyond the 5s timestamp window above): a captured,
  // validly-signed interaction can otherwise be re-POSTed within that window. Discord
  // interaction ids are unique snowflakes — record each once and reject duplicates.
  // Best-effort: a storage hiccup must NOT drop a legitimate interaction, so only an
  // actual unique-violation (P2002) counts as a replay. PING (handled above) is exempt.
  const interactionId = typeof interaction.id === "string" ? interaction.id : null;
  if (interactionId) {
    try {
      await prisma.discordSearchCache.create({
        data: { queryKey: `nonce:${interactionId}`, data: "", expiresAt: new Date(Date.now() + 30 * 1000) },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        console.warn(`[interactions] Replayed interaction rejected: ${sanitizeForLog(interactionId)}`);
        return new NextResponse("Duplicate interaction", { status: 401 });
      }
      console.error(`[interactions] Replay-guard write failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }

  if (interaction.type === 2) {
    const cmdAppId = interaction.application_id as string;
    const cmdToken = interaction.token as string;
    // type=5 defers the response (ephemeral); the actual reply is sent via editOriginal
    withDiscordTimeout(() => handleCommand(interaction), cmdAppId, cmdToken);
    return NextResponse.json({ type: 5, data: { flags: 64 } });
  }

  if (interaction.type === 3) {
    const cmpAppId = interaction.application_id as string;
    const cmpToken = interaction.token as string;
    // type=6 acknowledges component interaction with no visible change; reply follows from editOriginal
    withDiscordTimeout(() => handleComponent(interaction), cmpAppId, cmpToken);
    return NextResponse.json({ type: 6 });
  }

  return new NextResponse(null, { status: 400 });
}
