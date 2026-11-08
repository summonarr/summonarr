import { prisma } from "@/lib/prisma";
import { dummyVerify, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { authenticateWithJellyfin, authenticateWithJellyfinQuickConnect } from "@/lib/jellyfin";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { checkRateLimit, reserveRateLimit, refundHit, ipBucketKey } from "@/lib/rate-limit";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { sanitizeOptional } from "@/lib/sanitize";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, jellyfinSettingKey, mediaInstanceLabel } from "@/lib/media-instances";
import { jellyfinFirstSeenInstance } from "@/lib/jellyfin-identity";
import {
  isAuthorizedDbUser,
  isPreSetupBootstrapBlocked,
  logBestEffortFailure,
  providerRefusalAuditReason,
  retryOnProvisionRace,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  ProviderRefusal,
  type ProviderLookupResult,
} from "@/lib/auth-provider";
import {
  auditLoginFailure,
  authorizedSignIn,
  refuseSignIn,
  secretLimiterKey,
  signInRequestContext,
  type AuthorizedSignIn,
  type SignInRequestContext,
} from "@/lib/auth-sign-in-context";

// Jellyfin sign-in, by password or QuickConnect: the configured server vouches
// for the credential, the account must be a known member of this Summonarr
// instance, and the identity is bound to the server it was first seen on
// (guardrail 34e).

export async function findOrCreateJellyfinUser(
  jellyfinId: string,
  name: string,
  // The configured Jellyfin server the credential was verified against. The
  // identity is bound to it (guardrail 34e): a returning id signing in through
  // any other server is refused, and so is a new one first seen elsewhere.
  instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<ProviderLookupResult> {
  return retryOnProvisionRace(() => provisionJellyfinUser(jellyfinId, name, instance));
}

// The server the id was first seen on when that is not `instance` (registered
// now or since removed), else null. The boot backfill applies the same
// first-seen rule: a twin planted on a later server must not claim an identity
// whose owner just hasn't signed in yet (the subject-matched attribution,
// guardrail 34, would hand it their watch history and lock the owner out).
async function firstSeenElsewhere(jellyfinId: string, instance: MediaInstanceKey): Promise<string | null> {
  const firstSeen = await jellyfinFirstSeenInstance(jellyfinId);
  return firstSeen !== null && firstSeen !== instance ? firstSeen : null;
}

// The server a returning row is bound to. A row bound before the column
// existed (null) adopts `instance` unless the id was first seen on another one.
// The adoption is conditional on the column still being null, so two first
// sign-ins through different servers can't both adopt; the loser re-reads.
async function boundJellyfinInstance(
  row: { id: string; jellyfinInstance: string | null },
  jellyfinId: string,
  instance: MediaInstanceKey,
): Promise<string | null> {
  if (row.jellyfinInstance !== null) return row.jellyfinInstance;
  const elsewhere = await firstSeenElsewhere(jellyfinId, instance);
  if (elsewhere !== null) return elsewhere;
  const { count } = await prisma.user.updateMany({
    where: { id: row.id, jellyfinInstance: null },
    data: { jellyfinInstance: instance },
  });
  if (count === 1) return instance;
  const reread = await prisma.user.findUnique({ where: { id: row.id }, select: { jellyfinInstance: true } });
  return reread?.jellyfinInstance ?? null;
}

async function provisionJellyfinUser(
  jellyfinId: string,
  rawName: string,
  instance: MediaInstanceKey,
): Promise<ProviderLookupResult> {
  // Provider-supplied display name is untrusted — strip HTML/control chars so it
  // can't carry markup into any downstream sink (email/Discord/push). A name that
  // is nothing but stripped characters is NO name (null, like the Plex and OIDC
  // paths), never "" — which would override the stored one.
  const name = sanitizeOptional(rawName);
  // Jellyfin's API exposes no user email (UserDto carries none in any version),
  // so every Jellyfin account's login address is this placeholder. It is an
  // ADDRESS only — never a lookup key (see step 2).
  const syntheticEmail = `jellyfin-${jellyfinId}@jellyfin.local`;

  // 1) Provider-subject lookup, then the server binding. The id alone is not the
  //    identity: whoever runs a second registered server controls its database
  //    and could mint a user carrying another server's id.
  const bySub = await prisma.user.findUnique({ where: { jellyfinUserId: jellyfinId } });
  if (bySub) {
    if ((await boundJellyfinInstance(bySub, jellyfinId, instance)) !== instance) {
      console.warn(`[auth] Refused jellyfin sign-in through ${mediaInstanceLabel("jellyfin", instance)}: this Jellyfin id is bound to a different configured server.`);
      return new ProviderRefusal("instance_mismatch");
    }
    if (name && name !== bySub.name) {
      await prisma.user
        .updateMany({ where: { id: bySub.id }, data: { name } })
        .catch(logBestEffortFailure("auth", "jellyfin sign-in name refresh"));
    }
    return { id: bySub.id, email: bySub.email, name: name ?? bySub.name, role: bySub.role };
  }

  // 2) The synthetic address is NOT a lookup key. Sign-in used to bind to ANY
  //    row carrying it, so a delegate or an OIDC user who created
  //    `jellyfin-<id>@jellyfin.local` inherited that Jellyfin user's next
  //    sign-in. Legacy rows that relied on it were bound once by the boot
  //    backfill (jellyfin-identity.ts), and the reserved domains are refused at
  //    every account-creating path (reserved-email.ts). A row still holding the
  //    address is not this identity's: refuse rather than fail the create on
  //    the unique email.
  const squatter = await prisma.user.findUnique({ where: { email: syntheticEmail }, select: { id: true } });
  if (squatter) {
    console.warn(`[auth] Refused jellyfin sign-in for ${jellyfinId}: an account not bound to this Jellyfin id holds its placeholder address. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  // Refuse to mint the first user pre-setup — see isPreSetupBootstrapBlocked.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn(`[auth] Refused pre-setup jellyfin sign-in for ${jellyfinId}: complete initial setup (create the first admin) first.`);
    return PROVIDER_SETUP_REQUIRED;
  }

  // 3) New user, bound to the server it signed in through — unless the id was
  //    first seen on another one (the same rule as the null adoption above).
  if ((await firstSeenElsewhere(jellyfinId, instance)) !== null) {
    console.warn(`[auth] Refused jellyfin sign-in through ${mediaInstanceLabel("jellyfin", instance)}: this Jellyfin id was first seen on a different server (registered now or since removed).`);
    return new ProviderRefusal("instance_mismatch");
  }
  return prisma.user.create({
    data: {
      email: syntheticEmail,
      name: name ?? null,
      role: "USER",
      permissions: defaultPermissionsForRole("USER"),
      jellyfinUserId: jellyfinId,
      jellyfinInstance: instance,
    },
    select: { id: true, email: true, name: true, role: true },
  });
}

// Jellyfin sign-in membership gate. Mirrors Plex's friend-list gate — a valid
// Jellyfin credential alone is NOT sufficient to sign in. Without this gate, every
// account on the configured Jellyfin server (which an admin may not fully control,
// or which may have public/self-registration enabled) could authenticate into
// Summonarr, request media, and consume the request/issue surfaces. The account
// must instead be a known member of THIS Summonarr instance. The gate is
// fail-closed by default (only an explicit `jellyfinRestrictSignIn = "false"`
// setting disables it). Allowed when EITHER:
//   • an active jellyfin MediaServerUser row exists for this sourceUserId
//     (a synced member — the library sync populates this table), OR
//   • a Summonarr User is already bound to this jellyfinUserId (a returning user,
//     so an upgrade can't lock out anyone who has already signed in).
// A brand-new, unknown Jellyfin account (no MediaServerUser, no bound User) is
// refused until an admin syncs the library or allows them.
//
// Both the restrict-sign-in policy and the membership check are scoped to the
// instance the credential was verified against — a server B account must not
// be admitted by server A's MediaServerUser rows (or vice versa). So is the
// "already-bound returning user" bypass (guardrail 34e): an identity is bound
// to the server it was first seen on (User.jellyfinInstance), and a binding
// made through server A says nothing about a credential server B vouches for.
// A pre-34e row (null instance) passes here and findOrCreateJellyfinUser — the
// chokepoint that refuses a mismatched instance — decides it.
async function isJellyfinSignInAllowed(jellyfinUserId: string, instance: MediaInstanceKey): Promise<boolean> {
  const restrictRow = await prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "RestrictSignIn") } });
  const restrict = (restrictRow?.value ?? "true").trim().toLowerCase() !== "false";
  if (!restrict) return true;
  const [member, existing] = await Promise.all([
    prisma.mediaServerUser.findFirst({
      where: { source: "jellyfin", serverInstance: instance, sourceUserId: jellyfinUserId, active: true },
      select: { id: true },
    }),
    prisma.user.findUnique({ where: { jellyfinUserId }, select: { id: true, jellyfinInstance: true } }),
  ]);
  const boundHere = existing !== null && (existing.jellyfinInstance === instance || existing.jellyfinInstance === null);
  return Boolean(member || boundHere);
}

// How the two Jellyfin sign-ins differ once a credential has been checked:
// only the audit provider and the log scope. Every refusal on both is padded
// with a dummy password check and audited with the same reasons, so neither
// timing nor the audit trail tells the two paths' refusals apart.
type JellyfinSignInPath = {
  provider: "jellyfin" | "jellyfin-quickconnect";
  log: string;
};

const JELLYFIN_PASSWORD_PATH: JellyfinSignInPath = {
  provider: "jellyfin",
  log: "[jellyfin auth]",
};

const JELLYFIN_QUICKCONNECT_PATH: JellyfinSignInPath = {
  provider: "jellyfin-quickconnect",
  log: "[jellyfin quickconnect auth]",
};

const JELLYFIN_RATE_LIMIT = 10;
const JELLYFIN_RATE_WINDOW_MS = 5 * 60 * 1000;

// The configured server's URL for `instance`, or null (logged, and padded with a
// dummy password check like every refusal) when it has none.
async function jellyfinSignInUrl(instance: MediaInstanceKey, path: JellyfinSignInPath): Promise<string | null> {
  const jellyfinUrl = await getConfiguredJellyfinUrl(instance);
  if (!jellyfinUrl) {
    console.error(`${path.log} Jellyfin URL is not configured for instance "${instance}"`);
    await dummyVerify();
    return null;
  }
  return jellyfinUrl;
}

// The server refused the credential (or could not be asked).
async function refuseJellyfinCredential(err: unknown, ctx: SignInRequestContext, path: JellyfinSignInPath): Promise<null> {
  console.error(`${path.log} authentication failed:`, err);
  return refuseSignIn(ctx, path.provider, "invalid_credentials");
}

// The shared tail once the Jellyfin server has vouched for `jfUser`: the
// fail-closed membership gate, the identity lookup/provision with its 34e
// binding refusals, then this request's device payload.
async function completeJellyfinSignIn(
  jfUser: { id: string; name: string },
  instance: MediaInstanceKey,
  ctx: SignInRequestContext,
  path: JellyfinSignInPath,
  rememberMe: string | undefined,
): Promise<AuthorizedSignIn | null> {
  // A valid server credential is not enough: the account must be a known
  // member of this Summonarr instance (or the gate must be explicitly
  // disabled). See isJellyfinSignInAllowed for the membership criteria.
  if (!(await isJellyfinSignInAllowed(jfUser.id, instance))) {
    console.warn(`${path.log} sign-in refused: user is not an authorized member of this instance.`);
    return refuseSignIn(ctx, path.provider, "not_authorized");
  }
  const dbUser = await findOrCreateJellyfinUser(jfUser.id, jfUser.name, instance);
  if (!isAuthorizedDbUser(dbUser)) return refuseSignIn(ctx, path.provider, providerRefusalAuditReason(dbUser));
  return authorizedSignIn(dbUser, ctx, rememberMe);
}

// The routes have checked these are strings; anything else (or an empty value)
// refuses here too, before any read.
export type JellyfinSignInInput = { username?: string; password?: string; rememberMe?: string };
export type JellyfinQuickConnectSignInInput = { secret?: string; rememberMe?: string };

export async function authorizeWithJellyfin(
  credentials: JellyfinSignInInput,
  req: Request,
  instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<AuthorizedSignIn | null> {
  const { username, password } = credentials;
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) return null;
  if (username.length > 200 || password.length > MAX_PASSWORD_LENGTH) return null;
  const ctx = signInRequestContext(req);
  const path = JELLYFIN_PASSWORD_PATH;

  // Deliberately NOT scoped by instance — an attacker's per-IP attempt budget
  // must not multiply with the number of configured Jellyfin servers.
  if (!checkRateLimit(`jellyfin-ip:${ipBucketKey(ctx.ip)}`, JELLYFIN_RATE_LIMIT, JELLYFIN_RATE_WINDOW_MS)) {
    auditLoginFailure(ctx, path.provider, "rate_limited");
    return null;
  }

  // SECOND bucket, keyed on the credential rather than the caller — the bucket
  // above is NOT sufficient on its own. When TRUST_PROXY is not "true" (the
  // default docker deployment ships it blank), getClientIp falls back to
  // untrustedBucket, a hash of the User-Agent — a header the caller sets. An
  // attacker who rotates it per request gets a fresh bucket every time and an
  // unlimited number of guesses, and stock Jellyfin has no account lockout of
  // its own, which made this an unthrottled password-guessing proxy for the
  // media server.
  //
  // Both sibling providers already carry such a bucket — plex keys on the token
  // (`plex:${tokenKey}`) and QuickConnect on the secret
  // (`jellyfin-qc-secret:${qcKey}`). Keyed on the lowercased username so case
  // variation cannot mint new budgets, and protected from eviction (guardrail 6e).
  //
  // Like the credentials path's account bucket, the hit is RESERVED and given
  // back when the attempt turns out not to be a wrong guess (the server accepted
  // the password, or no server was asked), so only failed guesses spend the
  // budget — the owner signing in from several devices never locks themselves out.
  //
  // TRADE-OFF, accepted deliberately: a per-username bucket lets an attacker
  // spend a known user's budget with wrong passwords and lock them out for the
  // window. That is the standard cost of credential-keyed throttling, and it is
  // strictly better than unlimited guessing — the window is 5 minutes, not an
  // account disable.
  const userKey = `jellyfin-user:${username.toLowerCase()}`;
  const userHitAt = reserveRateLimit(userKey, JELLYFIN_RATE_LIMIT, JELLYFIN_RATE_WINDOW_MS);
  if (userHitAt === null) {
    auditLoginFailure(ctx, path.provider, "rate_limited_username");
    return null;
  }

  const jellyfinUrl = await jellyfinSignInUrl(instance, path);
  if (!jellyfinUrl) {
    refundHit(userKey, userHitAt);
    return null;
  }

  let jfUser;
  try {
    jfUser = await authenticateWithJellyfin(jellyfinUrl, username, password);
  } catch (err) {
    return refuseJellyfinCredential(err, ctx, path);
  }
  refundHit(userKey, userHitAt);
  return completeJellyfinSignIn(jfUser, instance, ctx, path, credentials.rememberMe);
}

export async function authorizeWithJellyfinQuickConnect(
  credentials: JellyfinQuickConnectSignInInput,
  req: Request,
  instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE,
): Promise<AuthorizedSignIn | null> {
  const { secret } = credentials;
  if (typeof secret !== "string" || !secret) return null;
  const ctx = signInRequestContext(req);
  const path = JELLYFIN_QUICKCONNECT_PATH;
  // Deliberately NOT scoped by instance — see authorizeWithJellyfin.
  if (!checkRateLimit(`jellyfin-qc-ip:${ipBucketKey(ctx.ip)}`, JELLYFIN_RATE_LIMIT, JELLYFIN_RATE_WINDOW_MS)) {
    auditLoginFailure(ctx, path.provider, "rate_limited");
    return null;
  }
  // Per-secret bucket so a QuickConnect secret can't be brute-redeemed from
  // rotating IPs (mirrors the Plex per-token limit), keyed on the secret's hash.
  const qcKey = secretLimiterKey(secret);
  if (!checkRateLimit(`jellyfin-qc-secret:${qcKey}`, JELLYFIN_RATE_LIMIT, JELLYFIN_RATE_WINDOW_MS)) {
    auditLoginFailure(ctx, path.provider, "rate_limited");
    return null;
  }
  const jellyfinUrl = await jellyfinSignInUrl(instance, path);
  if (!jellyfinUrl) return null;

  let jfUser;
  try {
    jfUser = await authenticateWithJellyfinQuickConnect(jellyfinUrl, secret);
  } catch (err) {
    return refuseJellyfinCredential(err, ctx, path);
  }
  // A valid QuickConnect secret authenticates the account but does not by
  // itself authorize sign-in — the same membership gate as the password path.
  return completeJellyfinSignIn(jfUser, instance, ctx, path, credentials.rememberMe);
}
