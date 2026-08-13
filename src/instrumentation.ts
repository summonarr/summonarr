// Runs once at server startup in the Node.js runtime only — safe to use Node APIs and import server-only modules here
import { evaluateLocalOnlyStartup } from "@/lib/local-only";
import { parseAuthUrl } from "@/lib/auth-url";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail-closed crypto check FIRST — before any other init. The token-crypto module
    // itself defers validation to first call (so `next build` can evaluate server
    // modules without an env var). Here we explicitly assert the key at boot so a
    // running server refuses to serve traffic without encryption configured.
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

    const required: string[] = ["NEXTAUTH_SECRET", "DATABASE_URL"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      console.error(
        `[startup] Missing required environment variables: ${missing.join(", ")}\n` +
          "Copy .env.example to .env and fill in the values before starting the server."
      );
      if (process.env.NODE_ENV === "production") {
        process.exit(1);
      }
    }

    if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET.trim().length < 32) {
      console.error(
        "[startup] NEXTAUTH_SECRET is missing or too short (minimum 32 characters required). " +
          "Generate one with: openssl rand -base64 32"
      );
      if (process.env.NODE_ENV === "production") process.exit(1);
    }

    // Validate that it PARSES, not merely that it is set. A scheme-less value
    // ("requests.example.com" — the common typo) passes a presence check and then
    // throws inside proxy.ts's buildLoginRedirect on every logged-out request,
    // 500ing instead of redirecting, while also reading as "no host" in the
    // public-host test below and quietly disarming that refusal.
    const authUrl = parseAuthUrl(process.env.AUTH_URL);
    if (!authUrl) {
      console.error(
        process.env.AUTH_URL?.trim()
          ? `[startup] AUTH_URL is set but is not an absolute http(s) URL: ${JSON.stringify(process.env.AUTH_URL)}. ` +
              "It must include the scheme — https://requests.yourdomain.com, not requests.yourdomain.com. " +
              "Login redirects and origin checks are built from it and will fail at request time."
          : "[startup] AUTH_URL is not set. Without it, the app falls back to trusting the incoming Host " +
              "header for origin and redirect checks, which allows host-header injection attacks that redirect " +
              "users to attacker-controlled domains. " +
              "Set AUTH_URL to the public URL of this app (e.g. https://requests.yourdomain.com)."
      );
      if (process.env.NODE_ENV === "production") {
        process.exit(1);
      }
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
      // reads as "not public". That is only safe because the guard above already
      // exited on it in production.
      authHost: authUrl?.hostname.toLowerCase() ?? "",
    });
    if (proxyDecision.fatal) {
      console.error(proxyDecision.message);
      process.exit(1);
    }
    if (proxyDecision.message) console.warn(proxyDecision.message);
    if (
      proxyDecision.mode === "trusted-proxy" &&
      authUrl?.protocol === "http:" &&
      process.env.NODE_ENV === "production"
    ) {
      console.warn(
        "[startup] TRUST_PROXY=true but AUTH_URL uses http:// — ensure the reverse proxy strips " +
        "X-Forwarded-For from untrusted clients; if the app is directly internet-exposed, " +
        "IP-based rate limiting can be bypassed via header spoofing."
      );
    }

    if (!process.env.CRON_SECRET || process.env.CRON_SECRET.trim().length < 32) {
      console.error(
        "[startup] CRON_SECRET is not set or is too short (minimum 32 characters). " +
          "Sync and cron endpoints will not be protected by a machine secret. " +
          "Generate one with: openssl rand -hex 32"
      );
      if (process.env.NODE_ENV === "production") {
        process.exit(1);
      }
    }

    if (!process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY.length !== 64) {
      console.error(
        "[startup] TOKEN_ENCRYPTION_KEY is not set or is not a valid 64-character hex string. " +
        "Without it, stored API keys, OAuth tokens, and sensitive settings are plaintext in the database. " +
        "Generate one with: openssl rand -hex 32"
      );
      if (process.env.NODE_ENV === "production") process.exit(1);
    }

    if (!process.env.TMDB_READ_TOKEN) {
      console.warn(
        "[startup] WARNING: No TMDB credentials set. Movie/TV search and poster images will not work. " +
          "Set TMDB_READ_TOKEN (v4 read access token)."
      );
    }

    // AUTH_TRUSTED_ORIGIN is a comma-separated allowlist of extra browser origins
    // (proxy.ts / cron-auth.ts). Those readers silently drop unparseable entries,
    // so a typo'd origin fails open as "not trusted" with no signal — warn here so
    // a misconfigured CSRF allowlist surfaces at boot instead of as mystery 403s.
    if (process.env.AUTH_TRUSTED_ORIGIN) {
      for (const raw of process.env.AUTH_TRUSTED_ORIGIN.split(",")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          // Mirror the readers: they key off URL.origin. A bare host or a path-only
          // value parses to a different origin (or throws) and won't match.
          new URL(trimmed);
        } catch {
          console.warn(
            `[startup] AUTH_TRUSTED_ORIGIN entry "${trimmed}" is not a valid absolute URL and will be ignored. ` +
              "Use full origins, e.g. https://app.example.com."
          );
        }
      }
    }

    // TRUSTED_PROXY_HOPS is clamped to 5 in rate-limit.ts (MAX_TRUSTED_HOPS). A
    // value above 3 is unusual and means the client-IP derivation trusts that many
    // X-Forwarded-For entries — too generous a value lets a client spoof its IP.
    // Warn only; the clamp in rate-limit.ts is the hard backstop (do NOT edit it).
    {
      const hopsRaw = process.env.TRUSTED_PROXY_HOPS;
      if (hopsRaw) {
        const hops = parseInt(hopsRaw, 10);
        if (Number.isFinite(hops) && hops > 3) {
          console.warn(
            `[startup] TRUSTED_PROXY_HOPS=${hops} is unusually high (>3). Each hop is an X-Forwarded-For entry ` +
              "trusted for client-IP derivation; an over-generous value lets clients spoof their IP. " +
              "It is clamped to 5 at runtime — set it to the actual number of trusted proxies in front of the app."
          );
        }
      }
    }

    // OIDC is all-or-nothing: a partial config (issuer set, but client id/secret
    // missing) silently disables the provider. Warn loudly rather than exit — this
    // matches the file's non-fatal posture for optional integrations (TMDB above),
    // and OIDC is optional, so a broken config must not brick boot for everyone.
    if (process.env.OIDC_ISSUER) {
      const oidcMissing = (["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const).filter(
        (k) => !process.env[k],
      );
      if (oidcMissing.length > 0) {
        console.warn(
          `[startup] OIDC_ISSUER is set but ${oidcMissing.join(" and ")} ${oidcMissing.length === 1 ? "is" : "are"} missing. ` +
            "OIDC sign-in will not work until all of OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are set."
        );
      }
    }

    // SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN grants ADMIN to the first OIDC/OAuth
    // sign-in when no admin exists yet — a bootstrap convenience for fresh
    // installs. While it is on, ANY successful OIDC/OAuth sign-in into an
    // admin-less instance is promoted to ADMIN, so leaving it enabled after the
    // real admin exists is a privilege-escalation footgun (the next OAuth user to
    // sign in during a transient admin-less window could be handed full control).
    // It's easy to forget once set, so warn loudly at boot — like the other
    // dangerous flags — to keep its state visible in the logs.
    if (process.env.SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN === "true") {
      console.warn(
        "[startup] SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN=true — the FIRST OIDC/OAuth sign-in (when no admin " +
          "exists) will be promoted to ADMIN. Unset this after the initial admin account is created."
      );
    }

    // SUMMONARR_ALLOW_SETUP_RESTORE re-enables the pre-authentication first-run
    // database restore (/api/setup/import*) on an internet-facing instance
    // (TRUST_PROXY=true). That path authenticates only with BACKUP_DB_PASSWORD,
    // so it is a database-takeover surface while no admin exists. Warn loudly so
    // it isn't left enabled after the initial restore.
    if (process.env.SUMMONARR_ALLOW_SETUP_RESTORE === "true" && process.env.TRUST_PROXY === "true") {
      console.warn(
        "[startup] SUMMONARR_ALLOW_SETUP_RESTORE=true — pre-authentication first-run database restore is " +
          "ENABLED on this internet-facing instance. Anyone who knows BACKUP_DB_PASSWORD can replace the " +
          "database while no admin account exists. Unset this immediately after completing a first-run restore."
      );
    }

    try {
      const { prewarmPublicKeyCache } = await import("@/app/api/interactions/route");
      await prewarmPublicKeyCache();
    } catch (err) {
      // Don't let a DB blip at boot crash startup — the Discord public-key cache
      // re-warms lazily on the first interaction (the library prewarm below is
      // already fire-and-forget for the same reason).
      console.error("[startup] Discord public-key prewarm failed:", err instanceof Error ? err.message : err);
    }

    import("@/lib/tmdb-prewarm")
      .then(({ prewarmLibraryCache }) => prewarmLibraryCache())
      .catch((err) => console.error("[prewarm] Library cache pre-warm error:", err));

    // Plex SSO identity-binding self-heal: backfill User.plexUserId from plex.tv
    // so existing Plex users (created before sign-in switched from email-based to
    // immutable-id-based (provider, plexUserId) matching) aren't locked out on
    // their next sign-in. See src/lib/plex-user-backfill.ts for the full
    // rationale. Fire-and-forget — must never block boot.
    // Stamp `purgedAt` on accounts scrubbed before that column existed, and
    // re-disable any that were re-enabled into a zombie. Must run BEFORE the
    // Plex backfill: an un-marked, re-enabled tombstone looks exactly like a
    // Plex-only user awaiting a plexUserId, so the backfill warns about it on
    // every boot. Awaited for that ordering; it is a single indexed UPDATE.
    await import("@/lib/account-lifecycle")
      .then(({ markLegacyPurgedAccounts }) => markLegacyPurgedAccounts())
      .catch((err) => console.error("[account-lifecycle] startup error:", err));

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
    // then never read by anything, which is what left the window open.
    import("@/lib/plex-user-backfill")
      .then(async ({ runPlexUserBackfillIfNeeded }) => {
        const { prisma } = await import("@/lib/prisma");
        const ranAt = await prisma.setting.findUnique({ where: { key: "plexUserIdBackfillRanAt" } });
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
    // unchanged schema makes NO Discord API call. Fire-and-forget; never blocks
    // boot.
    import("@/lib/discord-register")
      .then(({ syncDiscordCommandsIfChanged }) => syncDiscordCommandsIfChanged())
      .catch((err) => console.error("[discord] startup command sync error:", err));
  }
}
