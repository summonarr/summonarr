import { prisma } from "@/lib/prisma";
import { assignDiscordRolesForUser, escMd } from "@/lib/discord-notify";
import { DiscordAlreadyLinkedError, DiscordCodeAlreadyUsedError, mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { hashDiscordLinkToken, isWellFormedDiscordLinkToken, normalizeDiscordLinkToken } from "@/lib/discord-link-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { editOriginal } from "../reply";
import type { CommandContext } from "../types";

export async function handleLinkCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, discordUserId, data } = ctx;

  // Rate-limit per Discord user. Token entropy makes brute-force impractical
  // (32 hex chars = 128 bits), but parity with /request + defense-in-depth
  // if entropy is ever lowered. Also caps audit-log noise and Discord
  // rate-limit budget burn from a guild member spamming /link FOOBAR.
  if (!checkRateLimit(`discord-link:${discordUserId}`, 10, 60_000)) {
    await editOriginal(appId, token, { content: t("notify.bot.link.tooMany") });
    return;
  }

  const tokenValue = normalizeDiscordLinkToken(data.options?.find((o) => o.name === "token")?.value as string ?? "");
  if (!tokenValue) {
    await editOriginal(appId, token, { content: t("notify.bot.link.missingToken") });
    return;
  }
  if (!isWellFormedDiscordLinkToken(tokenValue)) {
    await editOriginal(appId, token, { content: t("notify.bot.link.invalid") });
    return;
  }

  // Only the code's SHA-256 is stored, so the row is looked up by the hash of
  // what was typed — never by the typed value itself, which would let a
  // value read from the DB or a backup redeem the row. A code minted before
  // hashing shipped (plaintext in the column) therefore misses here and the
  // user generates a new one (discord-link-token.ts).
  const tokenHash = hashDiscordLinkToken(tokenValue);
  const row = await prisma.discordLinkToken.findUnique({
    where: { token: tokenHash },
    select: { userId: true, discordId: true, expiresAt: true, user: { select: { name: true, email: true, deactivatedAt: true } } },
  });
  if (!row) {
    await editOriginal(appId, token, { content: t("notify.bot.link.invalid") });
    return;
  }
  if (row.expiresAt < new Date()) {
    // deleteMany: the purge cron or a concurrent /link may have removed the row
    // already, and a bare delete would throw P2025 into "unexpected error".
    await prisma.discordLinkToken.deleteMany({ where: { token: tokenHash } });
    await editOriginal(appId, token, { content: t("notify.bot.link.expired") });
    return;
  }
  if (row.discordId && row.discordId !== discordUserId) {
    await editOriginal(appId, token, { content: t("notify.bot.link.otherAccount") });
    return;
  }
  // Deactivation gate, same reasoning as the /request branch below: deactivation
  // writes only deactivatedAt (guardrail 33), so a banned account keeps its role,
  // permissions AND any pending link token. Redeeming one here would bind the
  // Discord id and hand back the Summonarr-managed guild roles the admin
  // sync-roles route exists to strip — and Discord is not session-backed, so
  // nothing upstream of this refuses it.
  if (row.user.deactivatedAt) {
    await editOriginal(appId, token, { content: t("notify.bot.link.deactivated") });
    return;
  }
  const existing = await prisma.user.findUnique({ where: { discordId: discordUserId } });
  if (existing && existing.id !== row.userId && !existing.email.endsWith("@discord.local")) {
    await editOriginal(appId, token, { content: t("notify.bot.link.alreadyLinked") });
    return;
  }

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
    if (err instanceof DiscordAlreadyLinkedError) {
      // The pre-check above ran outside the transaction; another account
      // claimed this Discord id in between.
      await editOriginal(appId, token, { content: t("notify.bot.link.alreadyLinked") });
      return;
    }
    if (err instanceof DiscordCodeAlreadyUsedError) {
      // Lost the claim. The same Discord account submitting twice already
      // has its link, so tell it so; any other account gets "invalid".
      const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { discordId: true } });
      await editOriginal(appId, token, {
        content: owner?.discordId === discordUserId
          ? t("notify.bot.link.success", { name: escMd(userName), transfer: "" })
          : t("notify.bot.link.invalid"),
      });
      return;
    }
    console.error("[interactions] link account failed:", (err as Error).message);
    await editOriginal(appId, token, { content: t("notify.bot.link.failed") });
    return;
  }

  // The roles follow the account's own row: its role and how it signs in.
  void assignDiscordRolesForUser(discordUserId, row.userId);
  await editOriginal(appId, token, { content: t("notify.bot.link.success", { name: escMd(userName), transfer: transferNote }) });
}
