import { prisma } from "@/lib/prisma";
import { getPlexUser, getPlexFriendEmails, checkPlexToken, type PlexServerMembers } from "@/lib/plex";
import { checkRateLimit, ipBucketKey } from "@/lib/rate-limit";
import { purposeHmacHex, signingKey } from "@/lib/signing-keys";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { sanitizeOptional } from "@/lib/sanitize";
import { normalizeEmail } from "@/lib/email-normalize";
import { type MediaInstanceKey, plexSettingKey, mediaInstanceLabel } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { getPlexConfig } from "@/lib/plex-config";
import { isReservedEmailDomain } from "@/lib/reserved-email";
import {
  hashAuditEmail,
  isAuthorizedDbUser,
  isPreSetupBootstrapBlocked,
  logBestEffortFailure,
  providerRefusalAuditReason,
  retryOnProvisionRace,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  ProviderRefusal,
  type AuthorizedDbUser,
  type ProviderLookupResult,
} from "@/lib/auth-provider";
import {
  auditLoginFailure,
  authorizedSignIn,
  MAX_SIGN_IN_TOKEN_LENGTH,
  refuseSignIn,
  secretLimiterKey,
  signInRequestContext,
  type AuthorizedSignIn,
  type SignInRequestContext,
} from "@/lib/auth-sign-in-context";

// Plex sign-in: the plex.tv token is verified (or answered from the token
// cache), the account must be shared on a configured server, and the identity
// binds on the plex.tv account id (guardrail 34).

export interface PlexUserInput {
  plexUserId: string;
  email: string;
  name?: string | null;
  image?: string | null;
  // The browser's X-Plex-Client-Identifier, when the sign-in carried a valid one.
  plexClientId?: string | null;
  // False when `email` came from the PlexTokenCache (up to 30 days old) rather than
  // a live plex.tv answer. A cached address is good enough to ADMIT a member but
  // must not overwrite notificationEmail, which would revert a newer address the
  // last live sign-in (or the user's profile) had set.
  emailIsFresh?: boolean;
}

export async function findOrCreatePlexUser(input: PlexUserInput): Promise<ProviderLookupResult> {
  return retryOnProvisionRace(() => provisionPlexUser(input));
}

async function provisionPlexUser({
  plexUserId,
  email,
  name,
  image,
  plexClientId,
  emailIsFresh = true,
}: PlexUserInput): Promise<ProviderLookupResult> {
  const normalized = normalizeEmail(email);
  // Provider-supplied display names are untrusted — strip HTML/control chars so
  // the name can't carry markup into any downstream sink (email/Discord/push),
  // mirroring the local-credentials register path.
  name = sanitizeOptional(name);

  // 1) Bind on (provider, sub) first. The external IdP's stable subject id is the
  //    only trustworthy identity anchor; email is NEVER the primary key for an
  //    external provider. Emails are reassignable and an attacker can stand up an
  //    account whose reported address matches an existing local user, so resolving
  //    identity by email would let one provider account silently take over another
  //    user's row. Matching on plexUserId avoids that entirely.
  const bySub = await prisma.user.findUnique({ where: { plexUserId } });
  if (bySub) {
    // notificationEmail is kept in lock-step with the Plex-verified email on every
    // sign-in so notifications always go to the user's current Plex address. This
    // is the ONE write per returning-user sign-in — the browser client id rides
    // along rather than costing authorizeWithPlex a second UPDATE on the same row.
    // Best-effort: the identity is already proven, so a failed refresh of these
    // columns must not refuse the sign-in.
    await prisma.user.update({
      where: { id: bySub.id },
      data: {
        ...(emailIsFresh ? { notificationEmail: normalized } : {}),
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
        ...(plexClientId ? { plexClientId } : {}),
      },
    }).catch(logBestEffortFailure("auth", "plex sign-in profile refresh"));
    return { id: bySub.id, email: bySub.email, name: name ?? bySub.name, role: bySub.role };
  }

  // 2) An existing row carrying this email but no plexUserId is the account-takeover
  //    surface: a Plex friend whose Plex-reported email happens to match a
  //    local-credentials user (potentially an admin) must NOT auto-link to that
  //    row and inherit its identity/role. Because we never reached step 1, no Plex
  //    sub is bound here yet — auto-linking on the email match alone would hand the
  //    incoming Plex account control of the existing user. Refuse and require an
  //    admin to perform an explicit, logged-in "link account" (rebind) instead.
  const byEmail = await prisma.user.findUnique({ where: { email: normalized } });
  if (byEmail) {
    // Named by the colliding row's id (what an admin needs to rebind) and the
    // email's keyed hash (to correlate with the audit row) — never the address.
    console.warn(`[auth] Refused plex sign-in: the email (hash ${hashAuditEmail(normalized)}) matches user ${byEmail.id}, which has no plexUserId. Manual rebind required.`);
    return PROVIDER_REBIND_REQUIRED;
  }

  // A plex.tv account can carry any address, a Summonarr-minted one included
  // (reserved-email.ts). Minting a row under `jellyfin-<id>@jellyfin.local`
  // would squat that Jellyfin user's address and block their provisioning.
  if (isReservedEmailDomain(normalized)) {
    console.warn("[auth] Refused plex sign-in: the account's email is in a domain Summonarr reserves for its own placeholder addresses.");
    return new ProviderRefusal("reserved_email");
  }

  // Refuse to mint the first user pre-setup — see isPreSetupBootstrapBlocked.
  if (await isPreSetupBootstrapBlocked()) {
    console.warn("[auth] Refused pre-setup plex sign-in: complete initial setup (create the first admin) first.");
    return PROVIDER_SETUP_REQUIRED;
  }

  // 3) New user — create with provider sub populated.
  return prisma.user.create({
    data: {
      email: normalized,
      name: name ?? null,
      image: image ?? null,
      role: "USER",
      permissions: defaultPermissionsForRole("USER"),
      plexUserId,
      notificationEmail: normalized,
      plexClientId: plexClientId ?? null,
    },
    select: { id: true, email: true, name: true, role: true },
  });
}

// The route has checked the token is a string; anything else (or an empty one)
// refuses here too, before any read.
export type PlexSignInInput = { plexToken?: string; plexClientId?: string; rememberMe?: string };

const PLEX_RATE_WINDOW_MS = 5 * 60 * 1000;
// A cached token answer is honoured (after a plex.tv ping) for this long.
const TOKEN_CACHE_TRUST_MS = 30 * 24 * 60 * 60 * 1000;
// A cache row lives this long past its last use — bumped on every sign-in.
const TOKEN_CACHE_ROW_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Per-IP bucket, then a per-token one so one Plex token can't be replayed from
// rotating IPs. The token is hashed, like the QuickConnect secret.
function passesPlexRateLimits(ctx: SignInRequestContext, plexToken: string): boolean {
  const tokenKey = secretLimiterKey(plexToken);
  if (
    !checkRateLimit(`plex-ip:${ipBucketKey(ctx.ip)}`, 20, PLEX_RATE_WINDOW_MS) ||
    !checkRateLimit(`plex:${tokenKey}`, 10, PLEX_RATE_WINDOW_MS)
  ) {
    auditLoginFailure(ctx, "plex", "rate_limited");
    return false;
  }
  return true;
}

// The browser's X-Plex-Client-Identifier, when it has the shape one has.
function validPlexClientId(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[a-f0-9-]{8,64}$/i.test(value) ? value : undefined;
}

type PlexSignInInstance = { slug: MediaInstanceKey; url: string; token: string; adminEmail: string | null };

// Every configured Plex server sign-in may admit a member of. Sign-in is
// refused outright when there are none: the membership gate admits a Plex
// account only if it is shared on a configured server (scoped to that
// server's machineIdentifier). Without a server URL that scoping is lost and the
// friend-list filter degrades to "anyone the admin has shared ANY server (or
// library) with on their whole Plex account," which can be a far wider,
// attacker-influenceable population than the intended instance members.
//
// An instance with a blank (trimmed) URL or token is skipped: this reproduces
// getSyncableMediaInstances' filter with findUnique-only reads (getPlexConfig +
// one AdminEmail read per instance, which getPlexConfig doesn't carry), the same
// pattern as the play-history poller (guardrail 35).
async function configuredPlexSignInInstances(): Promise<PlexSignInInstance[]> {
  const registered = await getMediaInstances("plex");
  const instances: PlexSignInInstance[] = [];
  for (const inst of registered) {
    const [cfg, adminEmailRow] = await Promise.all([
      getPlexConfig(inst.slug),
      prisma.setting.findUnique({ where: { key: plexSettingKey(inst.slug, "AdminEmail") } }),
    ]);
    const url = cfg.url?.trim() ?? "";
    const token = cfg.token?.trim() ?? "";
    if (!url || !token) continue;
    instances.push({ slug: inst.slug, url, token, adminEmail: adminEmailRow?.value ?? null });
  }
  return instances;
}

// Who a Plex token belongs to. `from` says whether the answer came from the
// token cache (which carries no name/thumb, and an email up to 30 days old) or
// from plex.tv just now.
type PlexIdentity = {
  email: string;
  sub: string;
  name: string | null;
  thumb: string;
  emailIsFresh: boolean;
  from: "cache" | "plex.tv";
};

// The token cache's answer, honoured only when plex.tv confirms the token is
// still valid AND the row carries a plex.tv account id already bound to a user —
// looking the bound user up by email would let an attacker whose Plex account
// happens to share a stale cache row's email inherit that row's identity. A
// legacy row (no plexUserId, written before the column existed) or a sub with
// no bound row yet falls through to the full lookup, which re-binds the row.
async function cachedPlexIdentity(plexToken: string, clientId: string | undefined, tokenHash: string): Promise<PlexIdentity | null> {
  const cached = await prisma.plexTokenCache.findUnique({ where: { tokenHash } });
  if (!cached || cached.verifiedAt <= new Date(Date.now() - TOKEN_CACHE_TRUST_MS) || !cached.plexUserId) return null;

  const tokenState = await checkPlexToken(plexToken, clientId);
  if (tokenState === "revoked") {
    // plex.tv refused the token (401) — purge the row so the next attempt
    // re-validates from scratch.
    await prisma.plexTokenCache.delete({ where: { tokenHash } }).catch(logBestEffortFailure("auth", "revoked plex token cache purge"));
    return null;
  }
  // "unknown" (a timeout, network failure, 429 or 5xx): plex.tv gave no
  // answer, so the row stays — but it is never honored unverified; the full
  // lookup decides this sign-in.
  if (tokenState !== "valid") return null;

  const existing = await prisma.user.findUnique({
    where: { plexUserId: cached.plexUserId },
    select: { plexUserId: true },
  });
  if (!existing?.plexUserId) return null;
  return { email: cached.email, sub: existing.plexUserId, name: null, thumb: "", emailIsFresh: false, from: "cache" };
}

async function resolvePlexIdentity(plexToken: string, clientId: string | undefined, tokenHash: string): Promise<PlexIdentity> {
  const cached = await cachedPlexIdentity(plexToken, clientId, tokenHash);
  if (cached) return cached;
  const plexUser = await getPlexUser(plexToken, clientId);
  return {
    email: normalizeEmail(plexUser.email),
    sub: plexUser.id,
    name: plexUser.username,
    thumb: plexUser.thumb,
    emailIsFresh: true,
    from: "plex.tv",
  };
}

// Caches a MEMBER's token answer (never a stranger's: their email has no
// business in the table), or bumps the lifetime of the row it was answered from.
async function rememberPlexToken(tokenHash: string, identity: PlexIdentity): Promise<void> {
  const expiresAt = new Date(Date.now() + TOKEN_CACHE_ROW_TTL_MS);
  if (identity.from === "cache") {
    // Best-effort: the row only bumps the cache's lifetime, and a concurrent
    // purge of it (P2025) must not turn a verified sign-in into a refusal.
    await prisma.plexTokenCache
      .update({ where: { tokenHash }, data: { lastUsedAt: new Date(), expiresAt } })
      .catch(logBestEffortFailure("auth", "plex token cache refresh"));
    return;
  }
  await prisma.plexTokenCache.upsert({
    where: { tokenHash },
    create: { tokenHash, email: identity.email, plexUserId: identity.sub, expiresAt },
    update: { email: identity.email, plexUserId: identity.sub, verifiedAt: new Date(), lastUsedAt: new Date(), expiresAt },
  });
}

// Membership gate — first match wins across every configured instance,
// default first. A Plex account is admitted when its plex.tv account id or
// verified email is on the friend list of ANY configured server (scoped to that
// server's machineIdentifier) or is that instance's admin email. Per-instance
// failures are isolated so one unreachable server can't block sign-in via a
// healthy one — but each instance still fails CLOSED on a plex.tv error (skip
// it; never fall back to an unscoped list).
//
// Asked live on every sign-in, never from plex-membership.ts's 30-minute
// cache: this is the authoritative gate (guardrail 35), and a cached list
// would admit someone un-shared within the window. Sign-ins are rare; the
// cache serves the frequent session re-checks.
async function findPlexMembership(
  instances: PlexSignInInstance[],
  identity: PlexIdentity,
): Promise<{ matched: boolean; fetchFailed: boolean }> {
  let fetchFailed = false;
  for (const inst of instances) {
    let allowed: PlexServerMembers;
    try {
      allowed = await getPlexFriendEmails(inst.token, inst.url);
    } catch (err) {
      console.warn(`[plex auth] membership check failed for ${mediaInstanceLabel("plex", inst.slug)}:`, err instanceof Error ? err.message : String(err));
      fetchFailed = true;
      continue;
    }
    // normalizeEmail (NFKC + lowercase + trim) — the identity's email is
    // normalized the same way, and plex-membership.ts normalizes identically, so
    // a Setting value with stray whitespace/Unicode form can't make the two
    // gates disagree. Added unconditionally after the fetch: an admin-only
    // server with an empty friend list must still admit its admin.
    if (inst.adminEmail) allowed.emails.add(normalizeEmail(inst.adminEmail));

    // Immutable plex.tv account id first (the same namespace sign-in pins to
    // User.plexUserId — same identity by construction), email as the legacy
    // fallback: an email is user-changeable on plex.tv, and a mid-window
    // change used to bounce the member off sign-in entirely.
    if (allowed.ids.has(identity.sub) || allowed.emails.has(identity.email)) return { matched: true, fetchFailed };
  }
  return { matched: false, fetchFailed };
}

// Why a Plex sign-in was refused: the AUTH_LOGIN_FAILED reason plus any extra
// detail. Each refusal is audited exactly once.
type PlexRefusal = { refused: string; extra?: Record<string, unknown> };

async function attemptPlexSignIn(
  plexToken: string,
  clientId: string | undefined,
): Promise<AuthorizedDbUser | PlexRefusal> {
  // Read up front, before identity resolution: no configured server ⇒ no
  // plex.tv call at all.
  const instances = await configuredPlexSignInInstances();
  if (instances.length === 0) {
    console.warn("[auth] Plex sign-in refused: no Plex server is configured.");
    return { refused: "plex_server_not_configured" };
  }

  // Keyed with the cache's own subkey, never the raw NEXTAUTH_SECRET
  // (guardrail 6h). Rows hashed under an older key simply miss, and the miss
  // path re-verifies the token against plex.tv and writes a fresh row.
  const tokenHash = purposeHmacHex(signingKey("plex-token-cache"), plexToken);
  const identity = await resolvePlexIdentity(plexToken, clientId, tokenHash);

  const membership = await findPlexMembership(instances, identity);
  if (!membership.matched) {
    // A refusal where some server's member list could not be read is audited
    // as that, not as a bad credential: the account may belong to the server
    // that failed to answer.
    return { refused: membership.fetchFailed ? "membership_check_failed" : "invalid_credentials" };
  }
  await rememberPlexToken(tokenHash, identity);

  // Identity is instance-independent, so the first membership match decides:
  // a refusal here would repeat identically on every other instance.
  // notificationEmail + plexClientId are written by findOrCreatePlexUser (one
  // UPDATE for a returning user, the CREATE for a new one) — no second write
  // on the same row here.
  const dbUser = await findOrCreatePlexUser({
    plexUserId: identity.sub,
    email: identity.email,
    name: identity.name,
    image: identity.thumb,
    plexClientId: clientId,
    emailIsFresh: identity.emailIsFresh,
  });
  if (!isAuthorizedDbUser(dbUser)) {
    return { refused: providerRefusalAuditReason(dbUser), extra: { emailHash: hashAuditEmail(identity.email) } };
  }
  return dbUser;
}

export async function authorizeWithPlex(
  credentials: PlexSignInInput,
  req: Request,
): Promise<AuthorizedSignIn | null> {
  const { plexToken } = credentials;
  if (typeof plexToken !== "string" || !plexToken || plexToken.length > MAX_SIGN_IN_TOKEN_LENGTH) return null;
  const ctx = signInRequestContext(req);
  if (!passesPlexRateLimits(ctx, plexToken)) return null;

  let outcome: AuthorizedDbUser | PlexRefusal;
  try {
    outcome = await attemptPlexSignIn(plexToken, validPlexClientId(credentials.plexClientId));
  } catch (err) {
    // A refused plex.tv token, an upstream failure or a DB error.
    console.error("[plex auth] error:", err);
    outcome = { refused: "invalid_credentials" };
  }
  // Every refusal is padded and audited once; the client sees the same 401.
  if ("refused" in outcome) return refuseSignIn(ctx, "plex", outcome.refused, outcome.extra);
  return authorizedSignIn(outcome, ctx, credentials.rememberMe);
}
