import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { getPlexAccountsDetailed, type PlexAccountInfo } from "./plex";
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
    // Any configured instance that did not hand back a COMPLETE account list —
    // it threw, returned nothing, or (the quiet one) came back owner-only
    // because getPlexAccountsDetailed's friends hop failed or 401'd. A person
    // reachable only through the missing half is invisible to this run.
    let incompleteFetch = false;

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
        const result = await getPlexAccountsDetailed(serverUrl, tokenRow.value);
        accounts = result.accounts;
        if (!result.ownerOk || !result.friendsOk) {
          // Each hop is swallowed inside getPlexAccountsDetailed, so without this
          // an owner-only list from a FAILED friends hop is indistinguishable
          // from an admin who genuinely shares with nobody — and stamping the
          // never-retry marker on it strands every friend permanently.
          incompleteFetch = true;
          console.warn(
            `[plex-backfill] ${label} returned a partial account list (owner: ${result.ownerOk ? "ok" : "failed"}, shared users: ${result.friendsOk ? "ok" : "failed"}).`,
          );
        }
      } catch (err) {
        // Defensive — getPlexAccountsDetailed swallows its own hop failures, but
        // a throw from one instance must not cost the others' contributions.
        console.warn(`[plex-backfill] Account fetch failed for ${label}; skipping this instance:`, err instanceof Error ? err.message : String(err));
        incompleteFetch = true;
        continue;
      }
      if (accounts.length === 0) {
        console.warn(`[plex-backfill] ${label} returned no accounts; skipping this instance (token may be invalid).`);
        incompleteFetch = true;
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
      } catch (err) {
        // A unique-violation race with a concurrent live sign-in is fine — that
        // user got bound by the auth flow first. Anything else is not: swallowing
        // it left the user in neither `bound` nor `unmatched`, so nothing warned
        // and the marker stamped over a failure nobody could see.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        console.warn(
          `[plex-backfill] Binding ${u.email} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        unmatched.push({ id: u.id, email: u.email });
      }
    }

    // Withhold the never-retry marker when this run BOTH left someone unbound and
    // saw an incomplete fetch: that person may be sitting in the half we failed to
    // read, and stamping would strand them permanently (the read side in
    // instrumentation.ts treats an absent marker as "retry next boot"). A partial
    // failure that cost nobody a match still stamps — every candidate is resolved,
    // so there is nothing a retry could improve.
    if (incompleteFetch && unmatched.length > 0) {
      console.warn(
        `[plex-backfill] ${unmatched.length} user(s) unbound after a partial account fetch — not stamping the ` +
          "run marker so the next boot retries.",
      );
      return;
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
          "match any email returned by plex.tv for ANY configured Plex instance's admin token. They will be " +
          "REFUSED on next Plex sign-in until an admin updates their email (or sets plexUserId manually). " +
          `Affected: ${affected}`,
      );
    }
  } catch (err) {
    // Best-effort — never block boot or throw.
    console.error("[plex-backfill] Backfill failed:", err);
  }
}
