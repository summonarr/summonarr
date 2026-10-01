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
- `AUTH_URL` — fixes the public origin so the CSRF `Origin`/`Referer` check can't be tricked by a forged `Host` header
- `TRUST_PROXY=true` — required for **internet-facing** deployments: when `AUTH_URL` is a public host, production refuses to boot without it (the local-only Host guard is spoofable and can't protect a public instance)
- `SUMMONARR_ALLOW_LOCAL_ONLY=true` — required to run **local-only mode** (no trusted proxy) in production. Local-only mode is gated only by the client-supplied `Host` header, so it is **not** an internet-facing access control: production fails closed unless the operator explicitly asserts the host is private (LAN-only, loopback-bound, or firewalled). It cannot unlock a public `AUTH_URL`. Development is unaffected.
- `CRON_SECRET` — minimum 32 characters; protects `/api/sync*` and `/api/cron*`
- `TOKEN_ENCRYPTION_KEY` — exactly 64 hex characters (`openssl rand -hex 32`)

A misconfigured deployment fails closed at startup, not silently at runtime.

**CSRF:** Mutating API requests (`POST`/`PUT`/`PATCH`/`DELETE`) must carry an `Origin` or `Referer` header that matches `AUTH_URL` (plus any `AUTH_TRUSTED_ORIGIN` entries). Webhook, sync, cron, and Discord-interactions routes use their own machine auth and bypass the origin check by design.

**XSS / clickjacking:** Strict CSP with per-request nonce and `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, and a tight `img-src`/`connect-src` allowlist. `'unsafe-eval'` is granted only under `NODE_ENV=development`, where React's dev build needs it to reconstruct server-side error stacks; the production build compiles that branch out entirely.

**SSRF:** All outbound HTTP goes through one of three helpers in `src/lib/safe-fetch.ts`:

- `safeFetch` — user-supplied URLs. Blocks RFC1918, loopback, link-local, CGNAT, multicast, and cloud-metadata addresses; re-resolves the hostname per request and safety-checks every resolved address (the IP can't be pinned at the dispatcher layer) to defeat DNS rebinding.
- `safeFetchAdminConfigured` — URLs persisted in the `Setting` table (Radarr/Sonarr/Plex/Jellyfin servers). Allows RFC1918/ULA/loopback for LAN deployments; still blocks `0.0.0.0` and link-local.
- `safeFetchTrusted` — hardcoded hostname allowlist for fixed third-party APIs (TMDB, plex.tv, discord.com, etc).

**Webhooks:** SHA-256 + `timingSafeEqual` of the `?token=` query param against the stored secret. The query-string fallback is load-bearing — Sonarr and Radarr have no header field for the token.

**Encryption at rest:** Sensitive `Setting` rows (API keys, webhook secret, SMTP password, GitHub token), `Account` / `PushSubscription` tokens and two-factor authenticator (TOTP) secrets are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`.

**Two-factor authentication (local password accounts):** optional per account — an authenticator app (RFC 6238 TOTP, ±30 s, each time step accepted at most once), passkeys / security keys (WebAuthn, attestation `none`, ES256 / EdDSA / RS256), and ten single-use recovery codes stored only as SHA-256 hashes. Plex, Jellyfin and OIDC sign-ins are out of scope: their identity provider owns MFA.

- A correct password for an account with 2FA mints **no session**. It returns HTTP 401 `{ mfaRequired: true, methods, mfaToken, webauthn? }`; the `mfaToken` is a 5-minute, single-use token signed with a key derived from (not equal to) the session key, so it can never be presented as a session. It burns after 5 wrong answers, dies if the password changes, and is claimed by one request at a time before any factor is checked, so parallel requests can't spend two factors on one sign-in. At most five challenges per account are live at once (minting a sixth retires the oldest), so no account can fill the server's challenge ledger. Only `POST /api/auth/sign-in/mfa` with a valid second factor mints the session, through the same code path (cookie for browsers; bearer token in the body only for the native app) as a password-only sign-in.
- Second-factor attempts are rate-limited per account and per IP, and wrong CODES (authenticator or recovery) are also counted in the database: after 10 consecutive misses code entry for that account is locked for 15 minutes, doubling on each further lockout up to 24 hours. The lock survives restarts, refuses even a correct code, is audited, and emails the account owner (when notification email is configured). Passkeys cannot be guessed, so they neither count toward it nor are blocked by it. TOTP replay, recovery-code reuse and WebAuthn signature-counter regressions are refused with conditional database updates, so concurrent requests can't both win. WebAuthn checks the ceremony type, the single-use challenge, the exact origin (`AUTH_URL`, plus `AUTH_TRUSTED_ORIGIN` entries under the same host), the RP ID hash, user presence and the signature, and accepts only credentials registered to that account.
- Every enrollment change requires the current password and is audited. Once an account has 2FA, every change (adding or removing a factor, renaming a passkey, new recovery codes, turning 2FA off) ALSO requires a fresh second factor — a current authenticator code, an unused recovery code (spent by the change) or a passkey — so a session obtained by relaying one code through a phishing proxy cannot turn itself into lasting access. The first factor is set up with the password alone. Every change is also emailed to the account owner when notification email is configured. Turning 2FA on, turning it off, or removing the last remaining factor signs out the account's other sessions. Admins with user management can reset a user's 2FA (lost device) — audited, it clears a code lockout, and it signs that user out everywhere; resetting an admin needs the full admin permission (re-checked inside the reset's transaction). "Prompt administrators to set up two-factor" redirects password-signed-in admins without 2FA to enrollment when they open an admin page; it is a nudge, not an enforcement — it never blocks sign-in or the API — and `SUMMONARR_DISABLE_MFA_ENFORCEMENT=true` switches it off. For an admin locked out with no other admin, `scripts/reset-password.mjs --reset-mfa` is the break-glass.
- Account purge removes the 2FA credentials. Backups carry them like other secrets (the TOTP secret stays encrypted; restore it under the same `TOKEN_ENCRYPTION_KEY`).

**Backup encryption:** AES-256-GCM with PBKDF2-SHA256 / 600,000 iterations (NIST SP 800-132 recommends ≥210k). The password lives in the operator's environment, not the database — a compromised admin account can trigger a backup but cannot decrypt one.

**Per-device sessions:** Each session is tracked in `AuthSession` with a UA fingerprint and per-device revocation. Role demotions propagate within 10 seconds for `ADMIN`/`ISSUE_ADMIN`. A browser session lasts exactly its admin-configured duration (desktop / mobile / remember-me; each capped at 90 days) with no inactivity timeout; a native-app (iOS) bearer session has no time-based expiry and ends only when revoked — per-device or everywhere from the Sessions page, or by a password change / account deactivation.

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
- Open redirect via post-login / OAuth/OIDC callback or redirect-target parameters
- Rate-limiting bypass or abuse vectors
- Webhook signature forgery or token-comparison timing leaks

## Hardening guidance for operators

Beyond the enforced guards above:

- Set `BACKUP_DB_PASSWORD` (≥12 chars) before using the Backup & Restore admin page. Unlike the boot-enforced vars, this one is checked per-request — both export and import endpoints return 503 until it's set, but the app boots without it.
- Run behind a reverse proxy with TLS. `TRUST_PROXY=true` is required to boot, but you must ensure the proxy strips client-supplied `X-Forwarded-For` from untrusted sources — otherwise per-IP rate limiting can be spoofed. Forwarded client-IP headers are read **only** when `TRUST_PROXY` is exactly `"true"`; otherwise every request falls back to a single shared bucket rather than trusting a forgeable address.
- Do not treat local-only mode (`SUMMONARR_ALLOW_LOCAL_ONLY=true`) as a way to expose an instance without a proxy. It is appropriate only behind network controls or on a genuinely private host; the `Host` check it relies on is chosen by the caller, so anything that can route a packet to the port can pass it.
- Configure each Plex/Jellyfin/Radarr/Sonarr webhook URL with the `?token=<secret>` query param — Sonarr and Radarr have no header field for it.
- Rotate `CRON_SECRET` and `TOKEN_ENCRYPTION_KEY` if you suspect either has leaked. Rotating `TOKEN_ENCRYPTION_KEY` invalidates encrypted Setting rows and stored OAuth tokens — re-enter them after rotation.

## Credit

Reporters who follow this policy and the [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories) workflow will be credited in the published advisory unless they request anonymity.
