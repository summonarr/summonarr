# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

If you believe you've found a security issue in Summonarr, report it privately through GitHub's **Private vulnerability reporting**:

1. Open [github.com/summonarr/summonarr/security/advisories/new](https://github.com/summonarr/summonarr/security/advisories/new)
2. Fill in what you found, how to reproduce it, and the impact
3. Submit — the report is visible only to the maintainers

We aim to acknowledge reports within **3 business days** and to triage within **7 days**. Critical issues (RCE, auth bypass, secret exposure) will be prioritized.

## Supported versions

Summonarr is in early development. Only the `main` branch and the most recent tagged release receive security updates.

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| latest tagged release | ✅ |
| older releases | ❌ |

## Scope

In scope:

- The Summonarr application (code in this repository)
- The bundled Docker image published from this repository
- The default Docker Compose stack shipped in this repository

Out of scope:

- Vulnerabilities in upstream dependencies (report those to the upstream project; we'll track them via Dependabot)
- Issues in third-party services Summonarr integrates with (Plex, Jellyfin, Radarr, Sonarr, TMDB)
- Findings that require a compromised admin account, a compromised host, or physical access
- Self-inflicted misconfiguration (e.g., exposing the app to the public internet without a reverse proxy or TLS)

## What counts as a vulnerability

Examples of things we want to hear about:

- Authentication or authorization bypass
- Server-side request forgery (SSRF) in webhook or arr integration paths
- Arbitrary file read/write or remote code execution
- SQL injection, prototype pollution, deserialization issues
- Sensitive data exposure (API keys, session tokens, user data) in responses, logs, or backups
- Cross-site scripting (XSS) in user-rendered content (requests, issue messages, profile fields)
- Cross-site request forgery (CSRF) on state-changing endpoints
- Rate-limiting bypass or abuse vectors

## Hardening guidance for operators

If you run Summonarr, please:

- Set `TOKEN_ENCRYPTION_KEY` in production so Setting rows and auth tokens are encrypted at rest
- Set `BACKUP_PASSWORD` before enabling the Backup & Restore admin page
- Run behind a reverse proxy with TLS; set `TRUST_PROXY=true` only when that proxy is trusted
- Keep `CRON_SECRET` ≥ 32 characters and rotate if leaked
- Restrict webhook URLs with the `?token=` query param to the configured value

## Credit

Reporters who follow this policy and the [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories) workflow will be credited in the published advisory unless they request anonymity.
