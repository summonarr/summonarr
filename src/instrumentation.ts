// Next calls register() once at server startup. Everything inside is gated on
// the Node.js runtime, so it is safe to use Node APIs and server-only modules.
//
// The boot sequence, in order:
//   1. TOKEN_ENCRYPTION_KEY — checked FIRST, exits at once in every environment;
//   2. the environment checks (checkBootEnv) — every one runs and logs, then
//      the server exits once if any refuses to start here (bootRefused);
//   3. warnings about optional configuration and risky flags — never fatal;
//   4. the one-off data migrations, awaited in order, each swallowing its own
//      failure so none can block boot;
//   5. the background jobs, fire-and-forget.
import { evaluateLocalOnlyStartup, trustedProxyStartupWarnings } from "@/lib/local-only";
import { parseAuthUrl } from "@/lib/auth-url";
import { previousSecretProblem, secretReuseError } from "@/lib/boot-secrets";
import { bootRefused, type BootRefusal } from "@/lib/boot-refusal";

// The fail-closed environment checks. `refuse` logs the problem and records how
// it ends; the caller exits once, after every check has had its say, so the
// operator sees all of them in one boot instead of fixing them one restart at a
// time.
function checkBootEnv(): BootRefusal[] {
  const refusals: BootRefusal[] = [];
  const refuse = (message: string, when: BootRefusal) => {
    console.error(message);
    refusals.push(when);
  };

  // NEXTAUTH_SECRET is not listed: the length check below already reports a
  // missing value, with the same production-only refusal.
  const required: string[] = ["DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    refuse(
      `[startup] Missing required environment variables: ${missing.join(", ")}\n` +
        "Copy .env.example to .env and fill in the values before starting the server.",
      "production",
    );
  }

  if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET.trim().length < 32) {
    refuse(
      "[startup] NEXTAUTH_SECRET is missing or too short (minimum 32 characters required). " +
        "Generate one with: openssl rand -base64 32",
      "production",
    );
  }

  // Validate that it PARSES, not merely that it is set. A scheme-less value
  // ("requests.example.com" — the common typo) passes a presence check and then
  // throws inside proxy.ts's buildLoginRedirect on every logged-out request,
  // 500ing instead of redirecting, while also reading as "no host" in the
  // public-host test below and quietly disarming that refusal.
  const authUrl = parseAuthUrl(process.env.AUTH_URL);
  if (!authUrl) {
    refuse(
      process.env.AUTH_URL?.trim()
        ? `[startup] AUTH_URL is set but is not an absolute http(s) URL: ${JSON.stringify(process.env.AUTH_URL)}. ` +
            "It must include the scheme — https://requests.yourdomain.com, not requests.yourdomain.com. " +
            "Login redirects and origin checks are built from it and will fail at request time."
        : "[startup] AUTH_URL is not set. Without it, the app falls back to trusting the incoming Host " +
            "header for origin and redirect checks, which allows host-header injection attacks that redirect " +
            "users to attacker-controlled domains. " +
            "Set AUTH_URL to the public URL of this app (e.g. https://requests.yourdomain.com).",
      "production",
    );
  }

  // TRUST_PROXY governs whether X-Forwarded-* is trusted (per-IP rate limiting) and
  // whether the local-only Host guard (src/lib/local-only.ts) is active. That Host
  // guard is SPOOFABLE — footgun-prevention for a LAN deployment, NOT a boundary for
  // an internet-facing one, so PRODUCTION local-only mode must be a deliberate
  // choice: either a trusted proxy (TRUST_PROXY=true) or an explicit
  // SUMMONARR_ALLOW_LOCAL_ONLY=true. The full rule set (including the
  // non-overridable public-AUTH_URL refusal) lives in evaluateLocalOnlyStartup;
  // this is only the wiring. Development never fails.
  //
  // NOTE: a production deployment with TRUST_PROXY blank and no opt-in now REFUSES
  // to boot. That is the point — a blank value used to mean "silently rely on a
  // spoofable header". The error names the exact line to add; .env.example and the
  // docker README ship it.
  const proxyDecision = evaluateLocalOnlyStartup({
    nodeEnv: process.env.NODE_ENV,
    trustProxy: process.env.TRUST_PROXY,
    allowLocalOnly: process.env.SUMMONARR_ALLOW_LOCAL_ONLY,
    // Reuses the single parse above — a malformed AUTH_URL yields "" here, which
    // reads as "not public". That is only safe because the check above already
    // refuses it in production.
    authHost: authUrl?.hostname.toLowerCase() ?? "",
  });
  if (proxyDecision.fatal) {
    refuse(proxyDecision.message ?? "[startup] Refusing to start: local-only mode is not allowed here.", "always");
  } else if (proxyDecision.message) {
    console.warn(proxyDecision.message);
  }
  // TRUST_PROXY=true trusts X-Forwarded-For, which is only safe when the port
  // is reachable through the proxy alone and the proxy overwrites the header.
  // The rules live in trustedProxyStartupWarnings; this is only the wiring.
  for (const warning of trustedProxyStartupWarnings({
    nodeEnv: process.env.NODE_ENV,
    trustProxy: process.env.TRUST_PROXY,
    authProtocol: authUrl?.protocol ?? "",
  })) {
    console.warn(warning);
  }

  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.trim().length < 32) {
    refuse(
      "[startup] CRON_SECRET is not set or is too short (minimum 32 characters). " +
        "Sync and cron endpoints will not be protected by a machine secret. " +
        "Generate one with: openssl rand -hex 32",
      "production",
    );
  }

  // The three secrets must be independent values (guardrail 6g) — a reused
  // value lets the most exposed one (the cron bearer) forge sessions or
  // decrypt stored credentials. Same production-only refusal as the length checks.
  const reuse = secretReuseError({
    nextAuthSecret: process.env.NEXTAUTH_SECRET,
    nextAuthSecretPrevious: process.env.NEXTAUTH_SECRET_PREVIOUS,
    cronSecret: process.env.CRON_SECRET,
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  });
  if (reuse) refuse(reuse, "production");

  // The verify-only rotation key (guardrail 6h): too short is fatal in
  // production like NEXTAUTH_SECRET itself; equal to it is only a warning.
  const previous = previousSecretProblem({
    nextAuthSecret: process.env.NEXTAUTH_SECRET,
    nextAuthSecretPrevious: process.env.NEXTAUTH_SECRET_PREVIOUS,
  });
  if (previous?.fatal) {
    refuse(previous.message, "production");
  } else if (previous) {
    console.warn(previous.message);
  }

  return refusals;
}

// Optional configuration that is wrong but never fatal: each logs once here so
// a misconfiguration surfaces at boot instead of as a silent fallback.
async function warnOptionalConfig(): Promise<void> {
  if (!process.env.TMDB_READ_TOKEN) {
    console.warn(
      "[startup] WARNING: No TMDB credentials set. Movie/TV search and poster images will not work. " +
        "Set TMDB_READ_TOKEN (v4 read access token)."
    );
  }

  // SUMMONARR_DEFAULT_LOCALE is read on its primary subtag (pt-BR → pt). A
  // value naming no supported language falls back to English for every
  // notification and API message to a user with no stored language — say so
  // ONCE here rather than let it pass silently. A valid value logs nothing.
  const { instanceDefaultLocaleWarning } = await import("@/lib/i18n/server-locale");
  const defaultLocaleWarning = instanceDefaultLocaleWarning();
  if (defaultLocaleWarning) console.warn(defaultLocaleWarning);

  // AUTH_TRUSTED_ORIGIN is a comma-separated allowlist of extra browser origins
  // (proxy.ts, cron-auth.ts, the register route). Those readers silently drop
  // unparseable entries, so a typo'd origin fails open as "not trusted" with no
  // signal — warn here so a misconfigured CSRF allowlist surfaces at boot
  // instead of as mystery 403s.
  if (process.env.AUTH_TRUSTED_ORIGIN) {
    const { parseTrustedOriginEntry } = await import("@/lib/trusted-origin");
    for (const raw of process.env.AUTH_TRUSTED_ORIGIN.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // The readers' own parser (trusted-origin.ts): only an http(s) URL whose
      // origin is not "null". A bare `host:port` does NOT throw out of `new URL`
      // — it parses as scheme `host:` with path `port` and origin "null" — the
      // one mistake the docker README's "internal hostname, LAN IP" wording
      // invites.
      if (parseTrustedOriginEntry(trimmed) === null) {
        console.warn(
          `[startup] AUTH_TRUSTED_ORIGIN entry "${trimmed}" has no http(s) scheme or is not a valid absolute URL and will be ignored. ` +
            "Use full origins, e.g. https://app.example.com."
        );
      }
    }
  }

  // TRUSTED_PROXY_HOPS: a typo silently becomes 1 hop and an oversized value is
  // clamped (parseTrustedHops in rate-limit.ts, the hard backstop); a value
  // above 3 is unusual. The rule lives in trustedProxyHopsWarning; this is only
  // the wiring. Warn only.
  const { trustedProxyHopsWarning } = await import("@/lib/rate-limit");
  const hopsWarning = trustedProxyHopsWarning(process.env.TRUSTED_PROXY_HOPS);
  if (hopsWarning) console.warn(hopsWarning);

  // OIDC is all-or-nothing: a partial config (issuer set, but client id/secret
  // missing) silently disables the provider. Warn loudly rather than exit — this
  // matches the non-fatal posture for optional integrations (TMDB above), and
  // OIDC is optional, so a broken config must not brick boot for everyone.
  if (process.env.OIDC_ISSUER) {
    const oidcMissing = (["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const).filter(
      (k) => !process.env[k],
    );
    if (oidcMissing.length > 0) {
      console.warn(
        `[startup] OIDC_ISSUER is set but ${oidcMissing.join(" and ")} ${oidcMissing.length === 1 ? "is" : "are"} missing. ` +
          "OIDC sign-in will not work until all of OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are set."
      );
    } else {
      // openid-client refuses non-https requests (allowInsecureRequests is
      // deliberately never passed), so an http:// issuer can never complete a
      // sign-in. isOidcConfigured() reads it as unconfigured — the login tab
      // hides — and this once-per-boot line is the only place that says why.
      const { isOidcIssuerSecure } = await import("@/lib/oidc");
      if (!isOidcIssuerSecure(process.env.OIDC_ISSUER)) {
        console.warn(
          `[startup] OIDC_ISSUER=${process.env.OIDC_ISSUER} is not an https:// URL, so OIDC sign-in is disabled. ` +
            "The identity provider must be reachable over TLS (a LAN IdP is fine, but it needs a certificate)."
        );
      }
    }
  }
}

// The dangerous opt-in flags, kept visible in the logs while they are on.
function warnRiskyFlags(): void {
  // SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN grants ADMIN to the first OIDC/OAuth
  // sign-in while setup has not completed — a bootstrap convenience for fresh
  // installs. While it is on, ANY successful OIDC/OAuth sign-in into an
  // admin-less instance is promoted to ADMIN. Once setup has completed the flag
  // promotes nobody (auth-session-mint.ts answers on setup_completed_at first),
  // so the loud warning is only for the window where it can act; afterwards one
  // short line says to unset it. Read off the boot path: a DB that isn't up yet
  // must not hold boot, and a failed read falls back to the loud warning.
  if (process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true") {
    void import("@/lib/prisma")
      .then(({ prisma }) => prisma.setting.findUnique({ where: { key: "setup_completed_at" }, select: { key: true } }))
      .catch(() => null)
      .then((setupDone) => {
        if (setupDone) {
          console.warn(
            "[startup] SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN=true has no effect now that setup has completed. Unset it.",
          );
          return;
        }
        console.warn(
          "[startup] SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN=true — the FIRST OIDC/OAuth sign-in (when no admin " +
            "exists) will be promoted to ADMIN. Unset this after the initial admin account is created."
        );
      });
  }

  // SUMMONARR_ALLOW_SETUP_RESTORE re-enables the pre-authentication first-run
  // database restore (/api/setup/import*) on an internet-facing instance
  // (TRUST_PROXY=true). That path authenticates only with BACKUP_DB_PASSWORD,
  // so it is a database-takeover surface while no admin exists. Warn loudly so
  // it isn't left enabled after the initial restore. Without TRUST_PROXY the
  // flag changes nothing (backup-import.ts: a local-only instance always allows
  // the first-run restore), so there is nothing to warn about.
  if (process.env.SUMMONARR_ALLOW_SETUP_RESTORE === "true" && process.env.TRUST_PROXY === "true") {
    console.warn(
      "[startup] SUMMONARR_ALLOW_SETUP_RESTORE=true — pre-authentication first-run database restore is " +
        "ENABLED on this internet-facing instance. Anyone who knows BACKUP_DB_PASSWORD can replace the " +
        "database while no admin account exists. Unset this immediately after completing a first-run restore."
    );
  }
}

// One-off data work, awaited in this order. Each step swallows its own failure:
// none may block boot. They run before the background jobs so their
// transactions never wait on a pool those jobs have filled.
async function runStartupMigrations(): Promise<void> {
  try {
    // The lib, not the interactions route: boot needs only the key cache
    // (process-wide, so this warms the copy the route reads — guardrail 27a).
    const { prewarmPublicKeyCache } = await import("@/lib/discord-interactions/signature");
    await prewarmPublicKeyCache();
  } catch (err) {
    // Don't let a DB blip at boot crash startup — the Discord public-key cache
    // re-warms lazily on the first interaction.
    console.error("[startup] Discord public-key prewarm failed:", err instanceof Error ? err.message : err);
  }

  // Stamp MediaRequest.approvedAt on requests that were approved or available
  // before the column existed. Once ever (request-approval.ts): afterwards a
  // null approvedAt on an AVAILABLE row means nobody approved its title, and the
  // watch grade skips it. Awaited because register() finishes before the server
  // takes requests, so no sync can mark a pending request available first.
  await import("@/lib/request-approval")
    .then(({ backfillRequestApprovals }) => backfillRequestApprovals())
    .catch((err) => console.error("[request-approval] startup error:", err));

  // Stamp `purgedAt` on accounts scrubbed before that column existed, and
  // re-disable any that were re-enabled into a zombie. Must run BEFORE the
  // Plex backfill: an un-marked, re-enabled tombstone looks exactly like a
  // Plex-only user awaiting a plexUserId, so the backfill warns about it on
  // every boot. Awaited for that ordering; it is a single indexed UPDATE.
  await import("@/lib/account-lifecycle")
    .then(({ markLegacyPurgedAccounts }) => markLegacyPurgedAccounts())
    .catch((err) => console.error("[account-lifecycle] startup error:", err));

  // Jellyfin identity binding (guardrail 34e): bind rows that still identify
  // as Jellyfin only by their jellyfin-<id>@jellyfin.local address (once
  // ever — sign-in no longer falls back to the address), then give every
  // bound row with no server binding the instance its id was first seen on.
  // Awaited so the first sign-ins after an upgrade already see the bindings;
  // a few indexed queries, and a no-op once both steps have run.
  await import("@/lib/jellyfin-identity")
    .then(({ backfillJellyfinIdentities }) => backfillJellyfinIdentities())
    .catch((err) => console.error("[jellyfin-identity] startup error:", err));

  // iOS push rows registered before the endpoint handle became a hash still
  // carry the raw APNs device token in plaintext (`apns:<token>`) beside the
  // encrypted copy (apns-endpoint.ts). Rewrite them once per boot — a no-op
  // once none are left. Awaited so it finishes before the first register;
  // the route handles a leftover legacy row anyway, so a failure here only
  // delays the cleanup to the next boot or the device's next launch.
  await import("@/lib/apns-endpoint")
    .then(({ migrateLegacyApnsEndpoints }) => migrateLegacyApnsEndpoints())
    .catch((err) => console.error("[push] APNs endpoint migration error:", err));
}

// Long-running or network-bound startup work. Fire-and-forget: none of it may
// block boot, and each logs its own failure.
function startBackgroundJobs(): void {
  // Derive the dummy password hash now, so the first unknown-account sign-in
  // doesn't pay its one-time cost on top of its own verify (guardrail 6i's
  // equal-work rule). It runs through the shared hash slot and never throws.
  import("@/lib/password-hash")
    .then(({ warmPasswordHashing }) => warmPasswordHashing())
    .catch((err) => console.error("[auth] Password hashing warm-up error:", err));

  // Under the warm-library cron's advisory lock (and observing its abort
  // signal, guardrail 41): on a large, cold library this walk can still be
  // running when the entrypoint's first warm-library cron fires, and without
  // the lock that cron would start a second full walk beside it. If the cron
  // (or an admin warm) already holds the lock, the boot walk simply skips.
  Promise.all([import("@/lib/tmdb-prewarm"), import("@/lib/advisory-lock")])
    .then(([{ prewarmLibraryCache }, { withAdvisoryLock, WARM_LIBRARY_LOCK_ID }]) =>
      withAdvisoryLock(
        WARM_LIBRARY_LOCK_ID,
        (signal) => prewarmLibraryCache({ signal }),
        () => undefined,
      ),
    )
    .catch((err) => console.error("[prewarm] Library cache pre-warm error:", err));

  // Plex SSO identity-binding self-heal: backfill User.plexUserId from plex.tv
  // so existing Plex users (created before sign-in switched from email-based to
  // immutable-id-based (provider, plexUserId) matching) aren't locked out on
  // their next sign-in. See src/lib/plex-user-backfill.ts for the full
  // rationale. Fire-and-forget — it calls plex.tv once per instance and must
  // never block boot. A legacy user who signs in with Plex in the seconds
  // before it lands is refused once and gets in on a retry.
  //
  // RUN ONCE EVER, not once per boot. The backfill binds User.plexUserId on an
  // EMAIL match — precisely the link authorizeWithPlex deliberately refuses,
  // calling it "the account-takeover surface" and demanding an explicit admin
  // link, because a plex.tv email is user-changeable. As a one-shot bridge for
  // rows predating plexUserId that trade is defensible; re-running it on every
  // boot forever is not, because unmatched candidates stay candidates and the
  // window never closes.
  //
  // The guard lives HERE, in the caller, not in the helper: the helper is
  // documented and tested as re-runnable, and its own test states the
  // once-guarantee belongs in instrumentation.ts. It already stamps
  // plexUserIdBackfillRanAt when it completes — that marker was written and
  // then never read by anything, which is what left the window open. Both
  // sides use the one exported key, so a rename can't split them.
  import("@/lib/plex-user-backfill")
    .then(async ({ runPlexUserBackfillIfNeeded, PLEX_USER_BACKFILL_RAN_AT_KEY }) => {
      const { prisma } = await import("@/lib/prisma");
      const ranAt = await prisma.setting.findUnique({ where: { key: PLEX_USER_BACKFILL_RAN_AT_KEY } });
      if (ranAt?.value) return;
      await runPlexUserBackfillIfNeeded();
    })
    .catch((err) => console.error("[plex-backfill] startup error:", err));

  // Open the Plex SSE notifications stream so we get real-time "session
  // stopped" events instead of waiting on the 5s poller's stale-detection.
  // Idempotent and self-healing — the sync route also calls reconcile() so
  // settings edits propagate even if this initial attempt fails.
  import("@/lib/plex-events")
    .then(({ reconcilePlexEventStream }) => reconcilePlexEventStream())
    .catch((err) => console.error("[plex-events] startup error:", err));

  // Discord slash-command self-heal: re-register the commands when their
  // schema (or guild/global scope) changed since the last successful
  // registration — so an upgrade that alters a command option (e.g. the
  // /link token's max_length 20 -> 32) republishes automatically instead of
  // requiring a manual "Register commands" click. Hash-guarded so an
  // unchanged schema makes NO Discord API call.
  import("@/lib/discord-register")
    .then(({ syncDiscordCommandsIfChanged }) => syncDiscordCommandsIfChanged())
    .catch((err) => console.error("[discord] startup command sync error:", err));
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fail-closed crypto check FIRST — before any other init. The token-crypto module
  // itself defers validation to first call (so `next build` can evaluate server
  // modules without an env var). Here we explicitly assert the key at boot so a
  // running server refuses to serve traffic without encryption configured.
  // This is the SOLE TOKEN_ENCRYPTION_KEY check: it exits in EVERY environment,
  // so no later (production-gated) re-check of the same var can ever be reached.
  try {
    const { assertTokenEncryptionKey } = await import("@/lib/token-crypto");
    assertTokenEncryptionKey();
  } catch (err) {
    console.error(
      "[boot] TOKEN_ENCRYPTION_KEY is required and must be a 64-character hex string. Refusing to start.",
      err,
    );
    process.exit(1);
  }

  if (bootRefused(checkBootEnv(), process.env.NODE_ENV)) process.exit(1);

  await warnOptionalConfig();
  warnRiskyFlags();
  await runStartupMigrations();
  startBackgroundJobs();
}
