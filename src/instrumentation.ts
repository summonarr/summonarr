// Runs once at server startup in the Node.js runtime only — safe to use Node APIs and import server-only modules here
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

    if (!process.env.AUTH_URL) {
      console.error(
        "[startup] AUTH_URL is not set. Without it, the app falls back to trusting the incoming Host " +
          "header for origin and redirect checks, which allows host-header injection attacks that redirect " +
          "users to attacker-controlled domains. " +
          "Set AUTH_URL to the public URL of this app (e.g. https://requests.yourdomain.com)."
      );
      if (process.env.NODE_ENV === "production") {
        process.exit(1);
      }
    }

    // TRUST_PROXY is REQUIRED (see CLAUDE.md env list). It must be an EXPLICIT
    // "true" or "false" in production — an unset value used to silently default
    // to local-only mode, whose Host-header guard is spoofable (src/lib/local-only.ts).
    // A deployment that forgot the flag and got exposed to the internet would
    // then serve the public via a forged `Host: 127.0.0.1`. Force the operator to
    // choose so the local-only fail-open footgun can't be hit by omission.
    const trustProxyValue = process.env.TRUST_PROXY;
    if (trustProxyValue === "true") {
      const authUrl = process.env.AUTH_URL ?? "";
      if (authUrl.startsWith("http://") && process.env.NODE_ENV === "production") {
        console.warn(
          "[startup] TRUST_PROXY=true but AUTH_URL uses http:// — ensure the reverse proxy strips " +
          "X-Forwarded-For from untrusted clients; if the app is directly internet-exposed, " +
          "IP-based rate limiting can be bypassed via header spoofing."
        );
      }
    } else if (trustProxyValue === "false") {
      // Deliberate local-only / LAN deployment. The proxy refuses any request whose
      // Host header is not loopback/RFC1918, but Host is SPOOFABLE — footgun-prevention,
      // not a hard boundary. An instance accidentally exposed to the internet can still
      // be reached with a forged Host. Keep it off the public internet (bind loopback/LAN);
      // use TRUST_PROXY=true behind a reverse proxy.
      console.warn(
        "[startup] TRUST_PROXY=false — LOCAL-ONLY mode. Per-IP rate limiting is disabled " +
          "(single shared bucket) and the local-only guard trusts the (spoofable) Host header. " +
          "Do NOT expose this instance directly to the public internet."
      );
    } else if (process.env.NODE_ENV === "production") {
      console.error(
        "[startup] TRUST_PROXY is required in production and was not set to 'true' or 'false'. " +
          "Set TRUST_PROXY=true behind a trusted reverse proxy (Nginx/Traefik/Caddy that sets " +
          "X-Forwarded-For), or TRUST_PROXY=false to explicitly run in local-only/LAN mode " +
          "(and keep the instance off the public internet). Refusing to start."
      );
      process.exit(1);
    } else {
      console.warn(
        "[startup] TRUST_PROXY is not set — LOCAL-ONLY mode (dev only). Set TRUST_PROXY=true " +
          "behind a reverse proxy, or TRUST_PROXY=false to explicitly run local-only."
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

    // Item 4 / C-1 self-heal: backfill User.plexUserId from plex.tv so
    // existing Plex users aren't locked out by the new (provider, sub) binding.
    // Fire-and-forget — must never block boot.
    import("@/lib/plex-user-backfill")
      .then(({ runPlexUserBackfillIfNeeded }) => runPlexUserBackfillIfNeeded())
      .catch((err) => console.error("[plex-backfill] startup error:", err));

    // Open the Plex SSE notifications stream so we get real-time "session
    // stopped" events instead of waiting on the 5s poller's stale-detection.
    // Idempotent and self-healing — the sync route also calls reconcile() so
    // settings edits propagate even if this initial attempt fails.
    import("@/lib/plex-events")
      .then(({ reconcilePlexEventStream }) => reconcilePlexEventStream())
      .catch((err) => console.error("[plex-events] startup error:", err));
  }
}
