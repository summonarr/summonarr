// Runs once at server startup in the Node.js runtime only — safe to use Node APIs and import server-only modules here
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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

    if (!process.env.AUTH_URL && !process.env.NEXTAUTH_URL) {
      console.error(
        "[startup] AUTH_URL is not set. Without it, NextAuth trusts the incoming Host header, " +
          "which allows host-header injection attacks that redirect users to attacker-controlled domains. " +
          "Set AUTH_URL to the public URL of this app (e.g. https://requests.yourdomain.com)."
      );
      if (process.env.NODE_ENV === "production") {
        process.exit(1);
      }
    }

    if (process.env.TRUST_PROXY !== "true") {
      console.warn(
        "[startup] TRUST_PROXY is not 'true' — running in LOCAL-ONLY mode. The proxy will refuse " +
          "any request whose Host header is not localhost or an RFC1918 address, and per-IP rate " +
          "limiting is disabled (single shared bucket). Set TRUST_PROXY=true when running behind " +
          "a trusted reverse proxy (Nginx, Traefik, Caddy, etc.) that reliably sets X-Forwarded-For."
      );
    }

    if (process.env.TRUST_PROXY === "true") {
      const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "";
      if (authUrl.startsWith("http://") && process.env.NODE_ENV === "production") {
        console.warn(
          "[startup] TRUST_PROXY=true but AUTH_URL uses http:// — ensure the reverse proxy strips " +
          "X-Forwarded-For from untrusted clients; if the app is directly internet-exposed, " +
          "IP-based rate limiting can be bypassed via header spoofing."
        );
      }
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

    if (!process.env.TMDB_READ_TOKEN && !process.env.TMDB_API_KEY) {
      console.warn(
        "[startup] WARNING: No TMDB credentials set. Movie/TV search and poster images will not work. " +
          "Set TMDB_READ_TOKEN (v4 read access token, preferred) or TMDB_API_KEY (legacy v3 key)."
      );
    }

    const { prewarmPublicKeyCache } = await import("@/app/api/interactions/route");
    await prewarmPublicKeyCache();

    import("@/lib/tmdb-prewarm")
      .then(({ prewarmLibraryCache }) => prewarmLibraryCache())
      .catch((err) => console.error("[prewarm] Library cache pre-warm error:", err));
  }
}
