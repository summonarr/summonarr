// Runs once at server startup in the Node.js runtime only — safe to use Node APIs and import server-only modules here
import { isLocalHost } from "@/lib/local-only";

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

    // TRUST_PROXY governs whether X-Forwarded-* is trusted (per-IP rate limiting) and
    // whether the local-only Host guard (src/lib/local-only.ts) is active. That Host
    // guard is SPOOFABLE — footgun-prevention for a LAN deployment, NOT a boundary for
    // an internet-facing one. So: trust the proxy when told; otherwise run local-only,
    // but REFUSE to boot when AUTH_URL is a PUBLIC host (an internet-facing deployment
    // that forgot to put a trusted proxy in front — the one case the Host guard cannot
    // protect). A LAN/loopback AUTH_URL (or unset/false TRUST_PROXY) stays supported and
    // boots with a loud warning — this is the default docker deployment, so DON'T exit on
    // a blank value (that would brick it).
    if (process.env.TRUST_PROXY === "true") {
      const authUrl = process.env.AUTH_URL ?? "";
      if (authUrl.startsWith("http://") && process.env.NODE_ENV === "production") {
        console.warn(
          "[startup] TRUST_PROXY=true but AUTH_URL uses http:// — ensure the reverse proxy strips " +
          "X-Forwarded-For from untrusted clients; if the app is directly internet-exposed, " +
          "IP-based rate limiting can be bypassed via header spoofing."
        );
      }
    } else {
      const authHost = (() => {
        try { return new URL(process.env.AUTH_URL ?? "").hostname.toLowerCase(); } catch { return ""; }
      })();
      // Treat as LAN unless AUTH_URL is a dotted FQDN with a routable-looking TLD:
      // loopback/RFC1918 IPs, "localhost", bare single-label hostnames, and private
      // mDNS/internal suffixes are all local. Err toward "local" so a misjudged host
      // never bricks a legitimate LAN deployment — false negatives just keep today's
      // behaviour; only a clearly-public AUTH_URL without a trusted proxy is refused.
      // A bracketed IPv6 literal (URL.hostname keeps the brackets) is also treated as
      // a host: isLocalHost() handles loopback/link-local/ULA, so only a PUBLIC IPv6
      // literal slips past the dotted-FQDN test and is correctly flagged here.
      const PRIVATE_SUFFIXES = [".local", ".lan", ".internal", ".home", ".home.arpa", ".localhost"];
      const authIsPublic =
        !!authHost &&
        authHost !== "localhost" &&
        (authHost.includes(".") || authHost.startsWith("[")) &&
        !isLocalHost(authHost) &&
        !PRIVATE_SUFFIXES.some((s) => authHost.endsWith(s));
      if (process.env.NODE_ENV === "production" && authIsPublic) {
        console.error(
          "[startup] AUTH_URL is a public host but TRUST_PROXY is not 'true'. An internet-facing " +
            "deployment MUST run behind a trusted reverse proxy with TRUST_PROXY=true — the local-only " +
            "Host-header guard is spoofable and cannot protect a public instance. Set TRUST_PROXY=true " +
            "(and have the proxy strip client-supplied X-Forwarded-* headers). Refusing to start."
        );
        process.exit(1);
      }
      console.warn(
        "[startup] TRUST_PROXY is not 'true' — LOCAL-ONLY mode (LAN/loopback). Per-IP rate limiting is " +
          "disabled (single shared bucket) and the local-only guard trusts the (spoofable) Host header, " +
          "which is NOT a security boundary. Set TRUST_PROXY=true behind a trusted reverse proxy for any " +
          "internet-facing deployment; keep local-only instances off the public internet."
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
