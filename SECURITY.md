# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

If you believe you've found a security issue in Summonarr, report it privately through GitHub's **Private vulnerability reporting**:

1. Open [github.com/summonarr/summonarr/security/advisories/new](https://github.com/summonarr/summonarr/security/advisories/new)
2. Fill in what you found, how to reproduce it, and the impact
3. Submit — the report is visible only to the maintainers

We aim to acknowledge reports within **3 business days** and to triage within **7 days**. Critical issues (RCE, auth bypass, secret exposure) are prioritized.

## Supported versions

Summonarr is in early development. Security fixes ship on the `main` branch and the next tagged release. **Older releases are not backported** — upgrade to the latest tag to receive a fix.

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| latest tagged release | ✅ |
| older releases | ❌ (upgrade) |

## Scope

In scope:

- The Summonarr application (code in this repository)
- The bundled Docker image published from this repository
- The default Docker Compose stack shipped in this repository

Out of scope:

- Vulnerabilities in upstream dependencies (report those to the upstream project; we track them via Dependabot)
- Issues in third-party services Summonarr integrates with (Plex, Jellyfin, Radarr, Sonarr, TMDB)
- Findings that require a compromised admin account, a compromised host, or physical access
- Self-inflicted misconfiguration of settings the app does **not** enforce (e.g., terminating TLS at the application instead of upstream)

## Defenses already in place

Before reporting, check whether the issue is already mitigated. We'd rather hear about a bypass than miss one — but knowing what exists helps you write a more useful report.

**Boot guards (production refuses to start without these):**

- `NEXTAUTH_SECRET` — minimum 32 characters
- `AUTH_URL` — fixes the public origin so NextAuth can't be tricked by a forged `Host` header
- `TRUST_PROXY=true` — required so per-IP rate limiting works behind a reverse proxy
- `CRON_SECRET` — minimum 32 characters; protects `/api/sync*` and `/api/cron*`
- `TOKEN_ENCRYPTION_KEY` — exactly 64 hex characters (`openssl rand -hex 32`)

A misconfigured deployment fails closed at startup, not silently at runtime.

**CSRF:** Mutating API requests (`POST`/`PUT`/`PATCH`/`DELETE`) must carry an `Origin` or `Referer` header that matches `AUTH_URL` (plus any `AUTH_TRUSTED_ORIGIN` entries). Webhook, sync, cron, and Discord-interactions routes use their own machine auth and bypass the origin check by design.

**XSS / clickjacking:** Strict CSP with per-request nonce and `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, and a tight `img-src`/`connect-src` allowlist.

**SSRF:** All outbound HTTP goes through one of three helpers in `src/lib/safe-fetch.ts`:

- `safeFetch` — user-supplied URLs. Blocks RFC1918, loopback, link-local, CGNAT, multicast, and cloud-metadata addresses; resolves and pins the IP to defeat DNS rebinding.
- `safeFetchAdminConfigured` — URLs persisted in the `Setting` table (Radarr/Sonarr/Plex/Jellyfin servers). Allows RFC1918/ULA/loopback for LAN deployments; still blocks `0.0.0.0` and link-local.
- `safeFetchTrusted` — hardcoded hostname allowlist for fixed third-party APIs (TMDB, plex.tv, discord.com, etc).

**Webhooks:** SHA-256 + `timingSafeEqual` of the `?token=` query param against the stored secret. The query-string fallback is load-bearing — Sonarr and Radarr have no header field for the token.

**Encryption at rest:** Sensitive `Setting` rows (API keys, webhook secret, SMTP password, GitHub token) and `Account` / `PushSubscription` tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`.

**Backup encryption:** AES-256-GCM with PBKDF2-SHA256 / 600,000 iterations (NIST SP 800-132 recommends ≥210k). The password lives in the operator's environment, not the database — a compromised admin account can trigger a backup but cannot decrypt one.

**Per-device sessions:** Each session is tracked in `AuthSession` with a UA fingerprint and per-device revocation. Role demotions propagate within 10 seconds for `ADMIN`/`ISSUE_ADMIN`. Admin sessions cap at 90 days.

**Audit log:** Sensitive `Setting` keys (Radarr/Sonarr/Plex/Jellyfin/Discord tokens, SMTP password) are redacted to `[redacted]` before being written to the audit log.

## What counts as a vulnerability

Reports we want — even if a defense above exists, a working bypass is worth knowing about:

- Authentication or authorization bypass (including IDOR on admin-only routes)
- SSRF that reaches private IPs from a *user-supplied* URL path (admin-configured paths reaching LAN are intentional)
- Arbitrary file read/write or remote code execution
- SQL injection, prototype pollution, deserialization issues
- Sensitive data exposure (API keys, session tokens, user data) in responses, logs, or backups
- XSS in user-rendered content (requests, issue messages, profile fields) that bypasses the CSP
- CSRF bypass — including any way to forge a matching `Origin` / `Referer`
- Open redirect via NextAuth callback URLs or `callbackUrl` parameters
- Rate-limiting bypass or abuse vectors
- Webhook signature forgery or token-comparison timing leaks

## Hardening guidance for operators

Beyond the enforced guards above:

- Set `BACKUP_DB_PASSWORD` (≥12 chars) before using the Backup & Restore admin page. Unlike the boot-enforced vars, this one is checked per-request — both export and import endpoints return 503 until it's set, but the app boots without it.
- Run behind a reverse proxy with TLS. `TRUST_PROXY=true` is required to boot, but you must ensure the proxy strips client-supplied `X-Forwarded-For` from untrusted sources — otherwise per-IP rate limiting can be spoofed.
- Configure each Plex/Jellyfin/Radarr/Sonarr webhook URL with the `?token=<secret>` query param — Sonarr and Radarr have no header field for it.
- Rotate `CRON_SECRET` and `TOKEN_ENCRYPTION_KEY` if you suspect either has leaked. Rotating `TOKEN_ENCRYPTION_KEY` invalidates encrypted Setting rows and stored OAuth tokens — re-enter them after rotation.

## Credit

Reporters who follow this policy and the [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories) workflow will be credited in the published advisory unless they request anonymity.
