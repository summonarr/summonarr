import { DISCORD_SYNTHETIC_EMAIL_SUFFIX } from "@/lib/user-source";
import { prisma } from "@/lib/prisma";
import { assignDiscordRolesForUser, escMd } from "@/lib/discord-notify";
import { DiscordAlreadyLinkedError, DiscordCodeAlreadyUsedError, mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { hashDiscordLinkToken, isWellFormedDiscordLinkToken, normalizeDiscordLinkToken } from "@/lib/discord-link-token";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Translator } from "@/lib/i18n/translate";
import { editOriginal, optionValue } from "../reply";
import type { CommandContext } from "../types";

type LinkTokenRow = {
  userId: string;
  discordId: string | null;
  expiresAt: Date;
  user: { name: string | null; email: string; deactivatedAt: Date | null };
};

// The link code's row, when this Discord user may redeem it; otherwise the
// reply that says why not.
async function redeemableLinkToken(t: Translator, discordUserId: string, tokenHash: string): Promise<{ refusal: string } | { row: LinkTokenRow }> {
  // Only the code's SHA-256 is stored, so the row is looked up by the hash of
  // what was typed — never by the typed value itself, which would let a
  // value read from the DB or a backup redeem the row. A code minted before
  // hashing shipped (plaintext in the column) therefore misses here and the
  // user generates a new one (discord-link-token.ts).
  const row = await prisma.discordLinkToken.findUnique({
    where: { token: tokenHash },
    select: { userId: true, discordId: true, expiresAt: true, user: { select: { name: true, email: true, deactivatedAt: true } } },
  });
  if (!row) return { refusal: t("notify.bot.link.invalid") };
  if (row.expiresAt < new Date()) {
    // deleteMany: the purge cron or a concurrent /link may have removed the row
    // already, and a bare delete would throw P2025 into "unexpected error".
    await prisma.discordLinkToken.deleteMany({ where: { token: tokenHash } });
    return { refusal: t("notify.bot.link.expired") };
  }
  if (row.discordId && row.discordId !== discordUserId) return { refusal: t("notify.bot.link.otherAccount") };
  // Deactivation gate: deactivation writes only deactivatedAt (guardrail 33), so
  // a banned account keeps its role, permissions AND any pending link token.
  // Redeeming one here would bind the Discord id and hand back the
  // Summonarr-managed guild roles the admin sync-roles route exists to strip —
  // and Discord is not session-backed, so nothing upstream of this refuses it.
  if (row.user.deactivatedAt) return { refusal: t("notify.bot.link.deactivated") };
  const existing = await prisma.user.findUnique({ where: { discordId: discordUserId }, select: { id: true, email: true } });
  if (existing && existing.id !== row.userId && !existing.email.endsWith(DISCORD_SYNTHETIC_EMAIL_SUFFIX)) {
    return { refusal: t("notify.bot.link.alreadyLinked") };
  }
  return { row };
}

// The reply for a merge that threw.
async function mergeFailureReply(t: Translator, err: unknown, row: LinkTokenRow, discordUserId: string, userName: string): Promise<string> {
  // The pre-check ran outside the transaction; another account claimed this
  // Discord id in between.
  if (err instanceof DiscordAlreadyLinkedError) return t("notify.bot.link.alreadyLinked");
  if (err instanceof DiscordCodeAlreadyUsedError) {
    // Lost the claim. The same Discord account submitting twice already
    // has its link, so tell it so; any other account gets "invalid".
    const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { discordId: true } });
    return owner?.discordId === discordUserId
      ? t("notify.bot.link.success", { name: escMd(userName), transfer: "" })
      : t("notify.bot.link.invalid");
  }
  console.error("[interactions] link account failed:", err instanceof Error ? err.message : String(err));
  return t("notify.bot.link.failed");
}

export async function handleLinkCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, discordUserId, data } = ctx;
  const reply = (content: string) => editOriginal(appId, token, { content });

  // Rate-limit per Discord user. Token entropy makes brute-force impractical
  // (32 hex chars = 128 bits), but parity with /request + defense-in-depth
  // if entropy is ever lowered. Also caps audit-log noise and Discord
  // rate-limit budget burn from a guild member spamming /link FOOBAR.
  if (!checkRateLimit(`discord-link:${discordUserId}`, 10, 60_000)) return reply(t("notify.bot.link.tooMany"));

  const typed = optionValue(data.options, "token");
  const tokenValue = normalizeDiscordLinkToken(typeof typed === "string" ? typed : "");
  if (!tokenValue) return reply(t("notify.bot.link.missingToken"));
  if (!isWellFormedDiscordLinkToken(tokenValue)) return reply(t("notify.bot.link.invalid"));

  const tokenHash = hashDiscordLinkToken(tokenValue);
  const found = await redeemableLinkToken(t, discordUserId, tokenHash);
  if ("refusal" in found) return reply(found.refusal);
  const { row } = found;

  const userName = row.user.name ?? row.user.email;
  let transferNote = "";
  try {
    // The token is consumed INSIDE the merge transaction (claimCode). Two
    // redemptions of one code used to both get here and both link — an
    // unbound token typed by two Discord accounts linked the account twice,
    // the second overwriting the first. Now the loser's conditional delete
    // finds nothing and the merge rolls back; and a failed merge rolls the
    // delete back too, so the code survives for a retry.
    const { migrated } = await mergeDiscordIntoWebAccount(row.userId, discordUserId, {
      claimCode: async (tx) => {
        const { count } = await tx.discordLinkToken.deleteMany({
          where: { token: tokenHash, userId: row.userId, expiresAt: { gt: new Date() } },
        });
        return count === 1;
      },
    });
    if (migrated > 0) {
      transferNote = ` ${t("notify.bot.link.transferred", { count: migrated })}`;
    }
  } catch (err) {
    return reply(await mergeFailureReply(t, err, row, discordUserId, userName));
  }

  // The roles follow the account's own row: its role and how it signs in.
  void assignDiscordRolesForUser(discordUserId, row.userId);
  await reply(t("notify.bot.link.success", { name: escMd(userName), transfer: transferNote }));
}
