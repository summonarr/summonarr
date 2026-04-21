import { NextRequest, NextResponse } from "next/server";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, isMovieDownloadingInRadarr, isSeriesDownloadingInSonarr, getMovieReleaseInfo, getSeriesFirstAired } from "@/lib/arr";
import { notifyUserDownloadPending, notifyUserAwaitingRelease, assignDiscordRolesOnLink, notifyAdminsNewRequestDiscord, notifyUserRequestApproved, notifyUserRequestDeclined } from "@/lib/discord-notify";
import { notifyAdminsNewRequest } from "@/lib/email";
import { notifyAdminsNewRequestPush } from "@/lib/push";
import { Prisma } from "@/generated/prisma";
import { mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { scheduleDelayed } from "@/lib/delayed-jobs";

export const dynamic = "force-dynamic";

const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const DISCORD_API = "https://discord.com/api/v10";

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
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true } })
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
  if (!auth) throw new Error("No TMDB credentials configured (set TMDB_READ_TOKEN or TMDB_API_KEY)");

  const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("include_adult", "false");

  const res = await safeFetchTrusted(url.toString(), {
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

async function cachedSearchTmdb(query: string, type: "movie" | "tv"): Promise<TmdbResult[]> {
  const key = `q:${type}:${query.toLowerCase().trim()}`;
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
        const raw = await cachedSearchTmdb(query, type);
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
          ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: approvedMovieIds } }, select: { tmdbId: true } })
          : Promise.resolve([]),
        approvedTvIds.length > 0
          ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: approvedTvIds } }, select: { tmdbId: true } })
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

      await prisma.discordLinkToken.delete({ where: { token: tokenValue } });
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
        // Create a shadow user with a synthetic email; they can merge into a real account via /link
        dbUser = await prisma.user.upsert({
          where: { discordId: discordUserId },
          update: { name: pending.discordUsername },
          create: {
            discordId: discordUserId,
            name: pending.discordUsername,
            email: `discord_${discordUserId}@discord.local`,
          },
        });
      }

      const confirmEmbed: Record<string, unknown> = { title: selected.title };
      if (selected.posterPath) {
        confirmEmbed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
      }

      const existing = await prisma.mediaRequest.findFirst({
        where: { tmdbId: selected.id, mediaType, requestedBy: dbUser.id },
      });
      if (existing) {
        confirmEmbed.color = 0xfee75c;
        confirmEmbed.description = `(${selected.releaseYear}) — Already requested.`;
        await editOriginal(appId, token, { content: "", embeds: [confirmEmbed], components: [] });
        return;
      }

      const [quotaLimitRow, quotaPeriodRow] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "quotaLimit" } }),
        prisma.setting.findUnique({ where: { key: "quotaPeriod" } }),
      ]);
      const quotaLimit = parseInt(quotaLimitRow?.value ?? "0", 10);
      if (quotaLimit > 0 && dbUser.role !== "ADMIN") {
        const isQuotaExempt = dbUser.quotaExempt ?? false;
        if (!isQuotaExempt) {
          const period = quotaPeriodRow?.value ?? "week";
          const now = new Date();
          let since: Date;
          if (period === "day") {
            since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          } else if (period === "month") {
            since = new Date(now.getFullYear(), now.getMonth(), 1);
          } else {
            const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
            since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
          }
          const count = await prisma.mediaRequest.count({
            where: { requestedBy: dbUser.id, createdAt: { gte: since } },
          });
          if (count >= quotaLimit) {
            confirmEmbed.color = 0xed4245;
            confirmEmbed.description = `You have reached your request quota of ${quotaLimit} per ${period}.`;
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

      const canAutoApprove = dbUser.role === "ADMIN" || hasAutoApproveRole || dbUser.autoApprove;

      let note: string;
      try {
        if (alreadyAvailable) {
          await prisma.mediaRequest.create({ data: { ...baseData, status: "AVAILABLE", availableAt: new Date() } });
          note = "It's already in the library!";
          confirmEmbed.color = 0x57f287;
        } else if (canAutoApprove) {
          const request = await prisma.mediaRequest.create({ data: { ...baseData, status: "APPROVED" } });
          try {
            if (mediaType === "MOVIE") {
              await addMovieToRadarr(selected.id);
            } else {
              const tvdbId = await addSeriesToSonarr(selected.id);
              await prisma.mediaRequest.update({ where: { id: request.id }, data: { tvdbId } });
            }
          } catch (err) {
            console.error("[interactions] arr push failed:", err);
            await prisma.mediaRequest.update({ where: { id: request.id }, data: { status: "PENDING" } });
          }
          note = "Your request was auto-approved and is being downloaded. You'll get a ping when it's ready!";
          confirmEmbed.color = 0x57f287;

          scheduleDelayed(90_000, async () => {
            try {
              const current = await prisma.mediaRequest.findUnique({ where: { id: request.id }, select: { status: true } });
              if (current?.status !== "APPROVED") return;

              const downloading = mediaType === "MOVIE"
                ? await isMovieDownloadingInRadarr(selected.id)
                : await isSeriesDownloadingInSonarr(selected.id);
              if (downloading) return;

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
          const pendingRequest = await prisma.mediaRequest.create({ data: baseData });
          const requestedBy = dbUser.name ?? dbUser.email ?? dbUser.id;
          void notifyAdminsNewRequest({ title: selected.title, mediaType, requestedBy, note: null, posterPath: selected.posterPath ?? null, tmdbId: selected.id, releaseYear: selected.releaseYear ?? null });
          void notifyAdminsNewRequestPush({ title: selected.title, mediaType, requestedBy });
          void notifyAdminsNewRequestDiscord({ requestId: pendingRequest.id, title: selected.title, mediaType, requestedBy, note: null, posterPath: selected.posterPath ?? null });
          note = "An admin will review your request.";
          confirmEmbed.color = 0x57f287;
        }
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          confirmEmbed.color = 0xfee75c;
          confirmEmbed.description = `(${selected.releaseYear}) — Already requested.`;
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

      const adminUser = await prisma.user.findFirst({
        where: { discordId: discordUserId, role: "ADMIN" },
        select: { id: true, name: true, email: true },
      });
      if (!adminUser) {
        await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "⛔ Only admins can use these buttons.", flags: 64 }),
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
        await prisma.mediaRequest.update({ where: { id: requestId }, data: { status: "APPROVED" } });
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
          await prisma.mediaRequest.update({ where: { id: requestId }, data: { status: "PENDING" } });
          arrFailed = true;
        }
        void notifyUserRequestApproved(request.requestedBy, request.title, request.mediaType);
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
        await prisma.mediaRequest.update({ where: { id: requestId }, data: { status: "DECLINED" } });
        void notifyUserRequestDeclined(request.requestedBy, request.title, request.mediaType);
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
  const body = await req.text();
  const safeTs = String(parseInt(timestamp, 10) || 0);
  console.log(`[interactions] POST sigLen=${signature.length} ts=${safeTs} bodyLen=${body.length}`);

  const publicKey = await getPublicKey();
  if (!publicKey) {
    return new NextResponse("Bot not configured — set discordPublicKey in Settings", { status: 503 });
  }

  if (!verifySignature(publicKey, signature, timestamp, body)) {
    console.log(`[interactions] Signature verification FAILED pkLen=${publicKey.length} sigLen=${signature.length} bodyLen=${body.length}`);
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  // Reject replayed requests: Discord requires servers to enforce a 5-second timestamp window
  const requestAge = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(requestAge) || requestAge > 5) {
    console.log(`[interactions] Stale timestamp rejected: age=${requestAge.toFixed(1)}s`);
    return new NextResponse("Request timestamp too old", { status: 401 });
  }
  const interactionType = Number(JSON.parse(body).type);
  console.log(`[interactions] Signature OK, type=${interactionType} bodyLen=${body.length}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interaction: any = JSON.parse(body);

  // type=1 is Discord's PING to verify the endpoint is reachable; respond with PONG immediately
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
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
