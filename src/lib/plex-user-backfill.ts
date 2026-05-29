import { prisma } from "./prisma";
import { getPlexAccounts } from "./plex";
import { normalizeEmail } from "./email-normalize";

// Boot-time self-heal for the C-1 / Item 4 SSO migration.
//
// After the audit, Plex sign-in is bound to (provider, plexUserId) instead of
// email — so existing Plex users (whose User row was created with a real email
// and no plexUserId) would be REFUSED on first sign-in until their plexUserId
// is backfilled. This helper runs once per boot, queries plex.tv for the
// admin's account list, and matches by email so the next sign-in succeeds.
//
// Candidate filter: only "Plex-only" users — no passwordHash, no jellyfinUserId,
// no OIDC Account row, AND no @jellyfin.local synthetic email (legacy Jellyfin
// users created before the jellyfinUserId column landed sit with
// jellyfinUserId=null until their next Jellyfin sign-in self-heals them via
// findOrCreateJellyfinUser; treating them as Plex candidates produced spurious
// "REFUSED on next Plex sign-in" warnings every boot). These rows are the
// ones that will ACTUALLY be locked out without a backfill; local/Jellyfin/
// OIDC users whose plexUserId happens to be null have another way in and
// shouldn't generate noise on every boot.

export async function runPlexUserBackfillIfNeeded(): Promise<void> {
  try {
    const candidates = await prisma.user.findMany({
      where: {
        plexUserId: null,
        jellyfinUserId: null,
        passwordHash: null,
        accounts: { none: { provider: "oidc" } },
        NOT: { email: { endsWith: "@jellyfin.local" } },
      },
      select: { id: true, email: true },
    });
    if (candidates.length === 0) return;

    const tokenRow = await prisma.setting.findUnique({ where: { key: "plexAdminToken" } });
    if (!tokenRow?.value) return; // Plex not configured — nothing to do

    const serverRow = await prisma.setting.findUnique({ where: { key: "plexServerUrl" } });
    const serverUrl = serverRow?.value ?? "";

    const accounts = await getPlexAccounts(serverUrl, tokenRow.value);
    if (accounts.length === 0) {
      console.warn("[plex-backfill] Plex returned no accounts; skipping (token may be invalid).");
      return;
    }

    const idByEmail = new Map<string, string>();
    for (const a of accounts) {
      if (a.email && a.id) idByEmail.set(normalizeEmail(a.email), a.id);
    }

    let bound = 0;
    const unmatched: { id: string; email: string }[] = [];
    for (const u of candidates) {
      const plexId = idByEmail.get(normalizeEmail(u.email));
      if (!plexId) {
        unmatched.push({ id: u.id, email: u.email });
        continue;
      }
      try {
        await prisma.user.update({
          where: { id: u.id },
          data: { plexUserId: plexId },
        });
        bound++;
      } catch {
        // Unique-violation race with a concurrent live sign-in — fine, that
        // user got bound by the auth flow first.
      }
    }

    await prisma.setting.upsert({
      where: { key: "plexUserIdBackfillRanAt" },
      create: { key: "plexUserIdBackfillRanAt", value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    if (bound > 0) {
      console.warn(`[plex-backfill] bound ${bound} existing Plex user(s) to their plex.tv account id.`);
    }
    if (unmatched.length > 0) {
      const affected = unmatched.map((u) => `${u.email} (${u.id})`).join(", ");
      console.warn(
        `[plex-backfill] ${unmatched.length} Plex-only user(s) could NOT be bound — their User.email does not ` +
          "match any email returned by plex.tv for this admin token. They will be REFUSED on next Plex sign-in " +
          `until an admin updates their email (or sets plexUserId manually). Affected: ${affected}`,
      );
    }
  } catch (err) {
    // Best-effort — never block boot or throw.
    console.error("[plex-backfill] Backfill failed:", err);
  }
}
