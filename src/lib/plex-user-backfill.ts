import { prisma } from "./prisma";
import { getPlexAccounts, type PlexAccountInfo } from "./plex";
import { normalizeEmail } from "./email-normalize";
import { getMediaInstances } from "./media-instance-registry";
import { mediaInstanceLabel, plexSettingKey } from "./media-instances";

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
// EVERY configured Plex instance's admin account list (a union — plexUserId is
// the plex.tv CLOUD account id, stable across servers, so a person matched via
// any instance's list resolves to the same correct id), and backfills
// plexUserId by matching email — a safe one-time bridge using the admins'
// authoritative account lists — so the next sign-in succeeds via the new
// id-based binding.
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
//
// `deactivatedAt: null` is part of that same rule: a removed account is disabled
// (see account-lifecycle.ts) and sign-in is refused for it outright, so
// backfilling a plexUserId it can never use is pointless — and every boot warned
// "REFUSED on next Plex sign-in" for an account nobody is trying to sign into. A
// PURGED row additionally has passwordHash/plexUserId/jellyfinUserId nulled and
// its email rewritten to deleted-<id>@deleted.invalid, which matches the
// Plex-only candidate shape exactly; this same filter excludes it.

export async function runPlexUserBackfillIfNeeded(): Promise<void> {
  try {
    const candidates = await prisma.user.findMany({
      where: {
        plexUserId: null,
        jellyfinUserId: null,
        passwordHash: null,
        deactivatedAt: null,
        accounts: { none: { provider: "oidc" } },
        NOT: { email: { endsWith: "@jellyfin.local" } },
      },
      select: { id: true, email: true },
    });
    if (candidates.length === 0) return;

    // Account lists come from EVERY configured Plex instance (multi-server
    // support). The instance list is getMediaInstances (a single registry
    // findUnique on `plexInstances`, default entry always first) + direct
    // per-instance findUnique reads below — NOT getSyncableMediaInstances,
    // whose isMediaInstanceConfigured check issues a connection-keys findMany
    // (the unit harness's setting stub is findUnique+upsert-only, the same
    // constraint the play-history poller documents), and NOT getPlexConfig,
    // which reads ServerUrl unconditionally: reading the token FIRST preserves
    // "unconfigured ⇒ ServerUrl not even read, zero plex.tv traffic".
    const instances = await getMediaInstances("plex");

    // A plex.tv email is user-changeable and not guaranteed unique across the
    // accounts an admin can see. If two distinct account ids normalize to the
    // same email — within one instance's list OR across instances — binding by
    // email could attach a local record to the wrong account, so such an email
    // is marked ambiguous and skipped — those users fall into `unmatched` and
    // an admin sets plexUserId explicitly instead. The same id re-listed (an
    // admin/friend shared across instances — getPlexAccounts is account-level,
    // so that is the normal multi-server case) is a no-op, not ambiguous.
    const idByEmail = new Map<string, string>();
    const ambiguousEmails = new Set<string>();
    let accountsFetched = 0;

    for (const instance of instances) {
      const tokenRow = await prisma.setting.findUnique({ where: { key: plexSettingKey(instance.slug, "AdminToken") } });
      if (!tokenRow?.value) continue; // instance not configured — nothing to fetch from it

      // getPlexAccounts ignores its serverUrl param (owner + friends both come
      // account-level from plex.tv, not machine-scoped) — tolerate it missing.
      const serverRow = await prisma.setting.findUnique({ where: { key: plexSettingKey(instance.slug, "ServerUrl") } });
      const serverUrl = serverRow?.value ?? "";

      const label = mediaInstanceLabel("plex", instance.slug);
      let accounts: PlexAccountInfo[];
      try {
        accounts = await getPlexAccounts(serverUrl, tokenRow.value);
      } catch (err) {
        // Defensive — getPlexAccounts swallows its own hop failures today, but
        // a throw from one instance must not cost the others' contributions.
        console.warn(`[plex-backfill] Account fetch failed for ${label}; skipping this instance:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (accounts.length === 0) {
        console.warn(`[plex-backfill] ${label} returned no accounts; skipping this instance (token may be invalid).`);
        continue;
      }
      accountsFetched += accounts.length;

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
    }

    // Nothing fetched from ANY instance: either Plex is unconfigured (no
    // instance has a token — silent, same as before) or every configured
    // instance failed/returned empty (each already warned above). Return
    // WITHOUT stamping ranAt so the next boot retries.
    if (accountsFetched === 0) return;

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
