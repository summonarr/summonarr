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
// Idempotent: counts pending rows first and exits if zero, so it's a single
// cheap query when there's nothing to do.

export async function runPlexUserBackfillIfNeeded(): Promise<void> {
  try {
    const pending = await prisma.user.count({ where: { plexUserId: null } });
    if (pending === 0) return;

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

    const users = await prisma.user.findMany({
      where: { plexUserId: null },
      select: { id: true, email: true },
    });

    let bound = 0;
    let skipped = 0;
    for (const u of users) {
      const plexId = idByEmail.get(normalizeEmail(u.email));
      if (!plexId) {
        skipped++;
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

    if (bound > 0 || skipped > 0) {
      console.warn(
        `[plex-backfill] bound=${bound} skipped=${skipped}` +
          (skipped > 0 ? " (skipped users have a different email on Plex; bind manually if needed)" : ""),
      );
    }
  } catch (err) {
    // Best-effort — never block boot or throw.
    console.error("[plex-backfill] Backfill failed:", err);
  }
}
