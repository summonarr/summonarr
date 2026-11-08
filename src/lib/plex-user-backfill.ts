import { prisma } from "./prisma";
import { getPlexAccountsDetailed, type PlexAccountInfo } from "./plex";
import { normalizeEmail } from "./email-normalize";
import { getMediaInstances } from "./media-instance-registry";
import { mediaInstanceLabel, plexSettingKey } from "./media-instances";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

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
// users created before the jellyfinUserId column landed sat with
// jellyfinUserId=null until the one-time backfill in jellyfin-identity.ts bound
// them — guardrail 34e; the rows it deliberately leaves unbound still carry the
// address. Treating them as Plex candidates produced spurious "REFUSED on next
// Plex sign-in" warnings every boot). These rows are the
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

// The run marker. Written here when a run completes; READ only by the boot
// caller (instrumentation.ts), which skips the backfill once it exists — this
// helper stays re-runnable. One constant for both sides: renaming it on one side
// alone would rerun the email-match backfill on every boot. The stored string
// must not change, or existing installs lose their marker.
export const PLEX_USER_BACKFILL_RAN_AT_KEY = "plexUserIdBackfillRanAt";

// Emails stay out of these logs: the unmatched list can be the whole Plex-only
// user base. The user id is what an admin needs to find the account.

type Candidate = { id: string; email: string };

function loadCandidates(): Promise<Candidate[]> {
  return prisma.user.findMany({
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
}

interface PlexAccountIndex {
  idByEmail: Map<string, string>;
  ambiguousEmails: Set<string>;
  accountsFetched: number;
  // Any configured instance that did not hand back a COMPLETE account list —
  // it threw, returned nothing, or (the quiet one) came back owner-only
  // because getPlexAccountsDetailed's friends hop failed or 401'd. A person
  // reachable only through the missing half is invisible to this run.
  incompleteFetch: boolean;
}

// One instance's account list, or null when it gave none (already warned).
async function fetchInstanceAccounts(token: string, label: string, index: PlexAccountIndex): Promise<PlexAccountInfo[] | null> {
  try {
    const result = await getPlexAccountsDetailed(token);
    if (!result.ownerOk || !result.friendsOk) {
      // Each hop is swallowed inside getPlexAccountsDetailed, so without this
      // an owner-only list from a FAILED friends hop is indistinguishable
      // from an admin who genuinely shares with nobody — and stamping the
      // never-retry marker on it strands every friend permanently.
      index.incompleteFetch = true;
      console.warn(
        `[plex-backfill] ${label} returned a partial account list (owner: ${result.ownerOk ? "ok" : "failed"}, shared users: ${result.friendsOk ? "ok" : "failed"}).`,
      );
    }
    if (result.accounts.length === 0) {
      console.warn(`[plex-backfill] ${label} returned no accounts; skipping this instance (token may be invalid).`);
      index.incompleteFetch = true;
      return null;
    }
    return result.accounts;
  } catch (err) {
    // Defensive — getPlexAccountsDetailed swallows its own hop failures, but
    // a throw from one instance must not cost the others' contributions.
    console.warn(`[plex-backfill] Account fetch failed for ${label}; skipping this instance:`, err instanceof Error ? err.message : String(err));
    index.incompleteFetch = true;
    return null;
  }
}

// Account lists come from EVERY configured Plex instance (multi-server
// support). The instance list is getMediaInstances (a single registry
// findUnique on `plexInstances`, default entry always first) + direct
// per-instance findUnique reads below — NOT getSyncableMediaInstances,
// whose isMediaInstanceConfigured check issues a connection-keys findMany
// (the unit harness's setting stub is findUnique+upsert-only, the same
// constraint the play-history poller documents), and NOT getPlexConfig,
// which reads ServerUrl unconditionally: reading the token FIRST preserves
// "unconfigured ⇒ ServerUrl not even read, zero plex.tv traffic".
//
// A plex.tv email is user-changeable and not guaranteed unique across the
// accounts an admin can see. If two distinct account ids normalize to the
// same email — within one instance's list OR across instances — binding by
// email could attach a local record to the wrong account, so such an email
// is marked ambiguous and skipped — those users fall into `unmatched` and
// an admin sets plexUserId explicitly instead. The same id re-listed (an
// admin/friend shared across instances — getPlexAccountsDetailed is
// account-level, so that is the normal multi-server case) is a no-op, not
// ambiguous.
async function indexPlexAccounts(): Promise<PlexAccountIndex> {
  const instances = await getMediaInstances("plex");
  const index: PlexAccountIndex = { idByEmail: new Map(), ambiguousEmails: new Set(), accountsFetched: 0, incompleteFetch: false };
  for (const instance of instances) {
    const tokenRow = await prisma.setting.findUnique({ where: { key: plexSettingKey(instance.slug, "AdminToken") } });
    if (!tokenRow?.value) continue; // instance not configured — nothing to fetch from it
    // No server address is needed: owner + friends both come account-level
    // from plex.tv, not machine-scoped.
    const accounts = await fetchInstanceAccounts(tokenRow.value, mediaInstanceLabel("plex", instance.slug), index);
    if (!accounts) continue;
    index.accountsFetched += accounts.length;
    for (const a of accounts) {
      if (!a.email || !a.id) continue;
      const norm = normalizeEmail(a.email);
      const existing = index.idByEmail.get(norm);
      if (existing !== undefined && existing !== a.id) {
        index.ambiguousEmails.add(norm);
        continue;
      }
      index.idByEmail.set(norm, a.id);
    }
  }
  return index;
}

interface BindOutcome {
  bound: number;
  unmatched: string[];
  // A matched user whose write failed for another reason (the DB, not the
  // email): a retry can fix it, so it holds the marker back.
  bindFailures: Array<{ id: string; reason: string }>;
}

async function bindCandidates(candidates: Candidate[], index: PlexAccountIndex): Promise<BindOutcome> {
  const outcome: BindOutcome = { bound: 0, unmatched: [], bindFailures: [] };
  for (const u of candidates) {
    const norm = normalizeEmail(u.email);
    const plexId = index.ambiguousEmails.has(norm) ? undefined : index.idByEmail.get(norm);
    if (!plexId) {
      outcome.unmatched.push(u.id);
      continue;
    }
    try {
      // Conditional on the column still being null: a Plex sign-in that bound
      // this row since the candidate read keeps its binding.
      const res = await prisma.user.updateMany({
        where: { id: u.id, plexUserId: null },
        data: { plexUserId: plexId },
      });
      if (res.count > 0) outcome.bound++;
    } catch (err) {
      // A unique violation is NOT a benign race: candidates have a null
      // plexUserId and Plex sign-in never binds an email-matched row, so a
      // P2002 means a DIFFERENT User row already owns this plex id. Retrying
      // cannot fix that, so it doesn't hold the marker back — but it must be
      // named, or the account stays unbound with no operator signal.
      if (isPrismaErrorCode(err, "P2002")) {
        console.warn(
          `[plex-backfill] Could not bind user ${u.id} to Plex account ${plexId}: another user already ` +
            "holds that plexUserId. Plex sign-in for that account resolves to the other user; merge or fix the " +
            "duplicate by hand.",
        );
        continue;
      }
      // Anything else is not an email mismatch: the user DID match, and the
      // write failed. Counted apart from `unmatched` and withheld from the
      // marker below, so the next boot binds them.
      outcome.bindFailures.push({ id: u.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcome;
}

// Withhold the never-retry marker when this run BOTH left someone unbound and
// saw an incomplete fetch: that person may be sitting in the half we failed to
// read, and stamping would strand them permanently (the read side in
// instrumentation.ts treats an absent marker as "retry next boot"). A partial
// failure that cost nobody a match still stamps — every candidate is resolved,
// so there is nothing a retry could improve. A failed write holds it back too.
function shouldStampMarker(index: PlexAccountIndex, outcome: BindOutcome): boolean {
  if (outcome.bindFailures.length > 0) {
    const affected = outcome.bindFailures.map((u) => `${u.id}: ${u.reason}`).join("; ");
    console.warn(
      `[plex-backfill] ${outcome.bindFailures.length} matched Plex user(s) could not be saved — not stamping the run ` +
        `marker so the next boot retries. ${affected}`,
    );
  }
  if (index.incompleteFetch && outcome.unmatched.length > 0) {
    console.warn(
      `[plex-backfill] ${outcome.unmatched.length} user(s) unbound after a partial account fetch — not stamping the ` +
        "run marker so the next boot retries.",
    );
    return false;
  }
  return outcome.bindFailures.length === 0;
}

export async function runPlexUserBackfillIfNeeded(): Promise<void> {
  try {
    const candidates = await loadCandidates();
    if (candidates.length === 0) return;

    const index = await indexPlexAccounts();
    // Nothing fetched from ANY instance: either Plex is unconfigured (no
    // instance has a token — silent, same as before) or every configured
    // instance failed/returned empty (each already warned). Return WITHOUT
    // stamping ranAt so the next boot retries.
    if (index.accountsFetched === 0) return;

    const outcome = await bindCandidates(candidates, index);
    if (!shouldStampMarker(index, outcome)) return;

    await prisma.setting.upsert({
      where: { key: PLEX_USER_BACKFILL_RAN_AT_KEY },
      create: { key: PLEX_USER_BACKFILL_RAN_AT_KEY, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    if (outcome.bound > 0) {
      console.warn(`[plex-backfill] bound ${outcome.bound} existing Plex user(s) to their plex.tv account id.`);
    }
    if (outcome.unmatched.length > 0) {
      console.warn(
        `[plex-backfill] ${outcome.unmatched.length} Plex-only user(s) could NOT be bound — their User.email does not ` +
          "match any email returned by plex.tv for ANY configured Plex instance's admin token. They will be " +
          "REFUSED on next Plex sign-in until an admin updates their email (or sets plexUserId manually). " +
          `Affected user ids: ${outcome.unmatched.join(", ")}`,
      );
    }
  } catch (err) {
    // Best-effort — never block boot or throw.
    console.error("[plex-backfill] Backfill failed:", err instanceof Error ? err.message : String(err));
  }
}
