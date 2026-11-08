import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { processSingleton } from "@/lib/process-singleton";
import { checkRateLimit } from "@/lib/rate-limit";
import { isLocale, type Locale } from "@/lib/i18n/locales";
import { instanceDefaultLocale, localeForUser, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import type { TmdbResult } from "./types";

export const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_HOSTS = ["discord.com"];

// ── Reply language ──────────────────────────────────────────────────────────
// A slash-command or button reply is written in the INVOKING user's language:
// Discord's own `interaction.locale` (the user's client language, e.g. "es-ES" →
// "es") first, then their linked Summonarr account's stored locale, then the
// instance default. An edit of the shared admin-channel message (the approve /
// decline embed every admin sees) uses the instance default instead, like every
// other shared-channel post (discord-notify.ts).
export function discordClientLocale(interaction: { locale?: unknown }): Locale | null {
  const raw = typeof interaction.locale === "string" ? interaction.locale : "";
  const primary = raw.trim().toLowerCase().split("-")[0];
  return isLocale(primary) ? primary : null;
}

// Synchronous variant for paths that must not wait on the DB (the timeout and
// the feature-disabled replies): Discord's locale, else the instance default.
export function interactionTranslatorSync(interaction: { locale?: unknown }): Translator {
  return translatorFor(discordClientLocale(interaction) ?? instanceDefaultLocale());
}

export async function interactionTranslator(interaction: { locale?: unknown }, discordUserId: string): Promise<Translator> {
  const fromDiscord = discordClientLocale(interaction);
  if (fromDiscord) return translatorFor(fromDiscord);
  // Only when Discord sent no supported language: one read for the linked
  // account's choice. A failed read falls back to the instance default.
  const linked = await prisma.user
    .findUnique({ where: { discordId: discordUserId }, select: { locale: true } })
    .catch(() => null);
  return translatorFor(localeForUser(linked));
}

// The quota window label ("week", "7 days", …) comes from quota.ts in English;
// map the known shapes onto catalog keys, anything else passes through. "<N> days"
// takes a numeric count so the plural form is picked (1 día, 2 días), as the web
// path's translateQuotaWindow does.
export function quotaWindowLabel(t: Translator, label: string | undefined): string {
  if (label === undefined) return t("notify.bot.quotaWindow.period");
  if (label === "day" || label === "week" || label === "month") return t(`notify.bot.quotaWindow.${label}`);
  const days = /^(\d+) days$/.exec(label);
  if (days) return t("notify.bot.quotaWindow.days", { count: Number(days[1]) });
  return label;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  // Lengths are UTF-16 code units: never keep the high half of a surrogate pair
  // (an emoji) without its low half, which Discord shows as a replacement mark.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

// Discord answers a message with content over 2000 characters with a 400 and
// changes nothing, which leaves the deferred "thinking…" reply up for the whole
// 15-minute token life. Titles and queries are upstream/user text, so cap the
// content at the one edit boundary.
const DISCORD_CONTENT_MAX = 2000;

// The edits of one interaction's original message, in call order. Discord
// applies each PATCH as it arrives, so two in flight at once — the timeout's
// "taking longer" line and a handler's final edit — could land in either order
// and the line could replace the result. Each edit starts only once the one
// before it on the same token has settled. Process-wide (guardrail 27a), keyed
// by the interaction token; an entry is dropped when its last edit settles.
const editChains = processSingleton("discord-interactions:editChains", () => new Map<string, Promise<void>>());

async function sendEdit(appId: string, token: string, payload: Record<string, unknown>): Promise<void> {
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

export function editOriginal(appId: string, token: string, rawPayload: Record<string, unknown>): Promise<void> {
  const payload = typeof rawPayload.content === "string" && rawPayload.content.length > DISCORD_CONTENT_MAX
    ? { ...rawPayload, content: truncateText(rawPayload.content, DISCORD_CONTENT_MAX) }
    : rawPayload;
  const run = (editChains.get(token) ?? Promise.resolve()).then(() => sendEdit(appId, token, payload));
  // A failed edit never blocks the next one; the caller still sees its own failure.
  const tail = run.catch(() => {});
  editChains.set(token, tail);
  void tail.then(() => {
    if (editChains.get(token) === tail) editChains.delete(token);
  });
  return run;
}

// Resolves once no edit of this interaction's message is queued or in flight,
// one macrotask after the last one settled (so whatever awaited it has run).
export async function editsIdle(token: string): Promise<void> {
  for (let chain = editChains.get(token); chain; chain = editChains.get(token)) {
    await chain;
    await new Promise<void>((r) => setImmediate(r));
  }
}

// A reply only the clicker sees (flags 64), posted as a follow-up to a deferred
// component interaction. The clicked message itself is left as it is.
export async function ephemeralFollowup(appId: string, token: string, content: string): Promise<void> {
  const res = await safeFetchTrusted(`${DISCORD_API}/webhooks/${appId}/${token}`, {
    allowedHosts: DISCORD_HOSTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, flags: 64 }),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    console.error("[interactions] follow-up failed:", res.status, await res.text());
  }
}

// The grey "already handled" card an admin button leaves behind when the
// request was decided elsewhere. Written in the shared channel's language.
export function handledEmbed(channelT: Translator, title: string): Record<string, unknown> {
  return {
    color: 0x71767B,
    title,
    description: channelT("notify.bot.admin.handled"),
    timestamp: new Date().toISOString(),
  };
}

// `buttons` picks what a result button does: "pick" files a request (/request),
// "wladd" adds to the watchlist, "issuepick" reports an issue. The custom_id is
// `<prefix>:<interactionId>:<discordUserId>:<index>` for every kind.
export function buildResultsPayload(
  t: Translator,
  query: string,
  results: TmdbResult[],
  interactionId: string,
  discordUserId: string,
  buttons: { prefix: string; labelKey: string } = { prefix: "pick", labelKey: "notify.bot.results.select" },
) {
  const embeds = results.map((r, i) => {
    const embed: Record<string, unknown> = {
      title: `${i + 1}. ${r.title} (${r.releaseYear})`,
      color: 0x5865f2,
    };

    const typeLine = r.mediaType === "movie" ? t("notify.bot.results.movie") : t("notify.bot.results.tv");
    const ratingLine = r.voteAverage > 0 ? `⭐ ${r.voteAverage.toFixed(1)}/10` : "";

    const statusParts: string[] = [];
    if (r.plexAvailable)                                          statusParts.push(t("notify.bot.results.onPlex"));
    if (r.jellyfinAvailable)                                      statusParts.push(t("notify.bot.results.onJellyfin"));
    if (!r.plexAvailable && !r.jellyfinAvailable && r.arrPending) statusParts.push(t("notify.bot.results.inQueue"));
    if (r.requested)                                              statusParts.push(t("notify.bot.results.requested"));

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
      label: t(buttons.labelKey, { n: i + 1 }),
      custom_id: `${buttons.prefix}:${interactionId}:${discordUserId}:${i}`,
    })),
  }];

  return {
    content: t("notify.bot.results.found", { n: results.length, query: escMd(query) }),
    embeds,
    components,
  };
}

// ── Linked site account ─────────────────────────────────────────────────────
//
// /watchlist and /issue act on a personal list and the issue tracker, both of
// which belong to a SITE account — so they need a linked one. A shadow row
// (`@discord.local`, which /request creates for an unlinked Discord user) is not
// one, and neither is a deactivated account (guardrail 33: deactivation leaves
// the discordId, role and permissions intact, and Discord is not session-backed,
// so this is the only place that refuses it). Both go through the same
// chokepoints as the web — addToWatchlist (src/lib/watchlist-add.ts) and
// createIssue (src/lib/issue-create.ts) — acting as that account via
// sessionForUser, so neither can do anything the user couldn't do on the site.

export type LinkedSiteAccount =
  | { kind: "none" }
  | { kind: "deactivated" }
  | { kind: "ok"; user: { id: string; role: string; permissions: bigint; name: string | null; email: string } };

export async function linkedSiteAccount(discordUserId: string): Promise<LinkedSiteAccount> {
  const user = await prisma.user.findUnique({
    where: { discordId: discordUserId },
    select: { id: true, role: true, permissions: true, name: true, email: true, deactivatedAt: true },
  });
  if (!user || user.email.endsWith("@discord.local")) return { kind: "none" };
  if (user.deactivatedAt) return { kind: "deactivated" };
  const { deactivatedAt: _deactivatedAt, ...rest } = user;
  return { kind: "ok", user: rest };
}

export function linkedAccountRefusal(t: Translator, linked: LinkedSiteAccount): string | null {
  if (linked.kind === "none") return t("notify.bot.linkRequired");
  if (linked.kind === "deactivated") return t("notify.bot.pick.deactivated");
  return null;
}

export type LinkedUser = Extract<LinkedSiteAccount, { kind: "ok" }>["user"];

/** The linked site account a personal-list command acts as, or the reply refusing it. */
export async function requireLinkedSiteAccount(t: Translator, discordUserId: string): Promise<{ refusal: string } | { user: LinkedUser }> {
  const linked = await linkedSiteAccount(discordUserId);
  if (linked.kind === "ok") return { user: linked.user };
  return { refusal: linkedAccountRefusal(t, linked) ?? t("notify.bot.linkRequired") };
}

// The read-command budget (/watchlist, /issue, /recent): one bucket per Discord user.
export function withinDiscordReadBudget(discordUserId: string): boolean {
  return checkRateLimit(`discord-read:${discordUserId}`, 20, 60_000);
}

// One option's value out of an interaction's (or a subcommand's) options.
export function optionValue(options: unknown, name: string): unknown {
  if (!Array.isArray(options)) return undefined;
  return (options as Array<{ name?: unknown; value?: unknown }>).find((o) => o?.name === name)?.value;
}

const PENDING_TTL_MS = 5 * 60_000;

export async function savePending(key: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  await prisma.discordSearchCache.upsert({
    where: { queryKey: key },
    create: { queryKey: key, data, expiresAt },
    update: { data, expiresAt },
  });
}

export async function loadPending<T>(key: string): Promise<T | null> {
  const row = await prisma.discordSearchCache.findUnique({ where: { queryKey: key } }).catch(() => null);
  if (!row || new Date() >= row.expiresAt) return null;
  try {
    return JSON.parse(row.data) as T;
  } catch {
    return null;
  }
}

export function mediaTypeOption(value: unknown): "movie" | "tv" | null {
  return value === "movie" || value === "tv" ? value : null;
}

// searchTmdb labels an undated title "Unknown" for display; the stored
// MediaRequest.releaseYear (and the admin notifications) must carry null, as the
// web path's verified metadata does.
export function releaseYearOf(r: { releaseYear: string }): string | null {
  return /^\d{4}$/.test(r.releaseYear) ? r.releaseYear : null;
}
