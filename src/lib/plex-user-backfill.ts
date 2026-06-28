import { prisma } from "./prisma";
import { getPlexAccounts } from "./plex";
import { normalizeEmail } from "./email-normalize";

// Boot-time self-heal for the Plex SSO identity-binding migration.
//
// Plex sign-in now matches an account on its immutable plex.tv user id
// (provider, plexUserId) rather than on email address. Binding to email was
// unsafe: a Plex email is user-changeable and not guaranteed unique across the
// accounts an admin can see, so matching on it could let one Plex account claim
// another user's local record. The trade-off is that User rows created before
// the migration carry a real email but a null plexUserId, and would now be
// REFUSED on their first post-migration sign-in (no plexUserId to match) until
// the column is populated. This helper runs once per boot, queries plex.tv for
// the admin's account list, and backfills plexUserId by matching email — a safe
// one-time bridge using the admin's authoritative account list — so the next
// sign-in succeeds via the new id-based binding.
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

    // A plex.tv email is user-changeable and not guaranteed unique across the
    // accounts an admin can see. If two distinct account ids normalize to the
    // same email, binding by email could attach a local record to the wrong
    // account, so such an email is marked ambiguous and skipped — those users
    // fall into `unmatched` and an admin sets plexUserId explicitly instead.
    const idByEmail = new Map<string, string>();
    const ambiguousEmails = new Set<string>();
    for (const a of accounts) {
      if (!a.email || !a.id) continue;
      const norm = normalizeEmail(a.email);
      const existing = idByEmail.get(norm);
      if (existing !== undefined && existing !== a.id) {
        ambiguousEmails.add(norm);
        continue;
      }
      idByEmail.set(norm, a.id);
    }

    let bound = 0;
    const unmatched: { id: string; email: string }[] = [];
    for (const u of candidates) {
      const norm = normalizeEmail(u.email);
      const plexId = ambiguousEmails.has(norm) ? undefined : idByEmail.get(norm);
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
