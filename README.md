# Summonarr

Self-hosted media request aggregator. Browse TMDB (trending, popular, discover, upcoming), request movies and TV, vote on requests, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. Summonarr ingests Plex and Jellyfin libraries plus play history, so users see availability, active sessions, and watch activity in one place.

> **Status:** v0.11.0 beta — feature-complete for the initial release. **Beta testers wanted** — see [Beta testing](#beta-testing).

## Install

**The supported install path is Docker Compose from [`docker-container/`](./docker-container/).** It pulls the pre-built image from GHCR — no build step required.

👉 **[Deployment guide: `docker-container/README.md`](./docker-container/README.md)** (env vars, reverse proxy, webhooks, backups, upgrading, troubleshooting).

Quick taste:

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr/docker-container
cp .env.example .env
${EDITOR:-vi} .env
docker compose up -d
```

Then open <http://localhost:3001>. The first user to register is auto-promoted to `ADMIN`.

## Features

- TMDB-powered browse: trending, popular, discover, upcoming
- Movie and TV requests with voting and issue tracking
- Admin approval with automatic fulfillment through Radarr and Sonarr
- Plex and Jellyfin library + play-history ingestion (including active sessions)
- GitHub-style 365-day activity heatmap and per-user stats
- Local, Plex OAuth, Jellyfin (standard + QuickConnect), and OIDC sign-in
- Per-device session tracking, Web Push notifications, optional SMTP email
- AES-256-GCM encryption at rest for provider secrets and push/OAuth tokens
- Encrypted, password-protected database backups (export/import via the admin UI)
- Webhook support for Plex, Jellyfin, Sonarr, and Radarr
- Admin debug endpoint (`/api/admin/debug/arr-state`) for inspecting the Radarr/Sonarr pipeline end-to-end

## Architecture at a glance

The compose stack runs two containers:

| Service     | Image                                | Role                                                                                  | Port (host → container) |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------- |
| `summonarr` | `ghcr.io/summonarr/summonarr:latest` | Next.js app **plus** an internal cron loop that drives sync jobs (no sidecar needed). | `3001 → 3000`           |
| `postgres`  | `postgres:17-alpine`                 | Primary database. Persisted to the `postgres-data` named volume.                      | not exposed to host     |

Everything Summonarr needs at runtime — schema sync (`prisma db push`), library sync, TMDB refresh, play-history polling, cache warmers, audit-PII scrubbing — runs inside the `summonarr` container.

```
                   ┌───────────────────────┐
      browser ───▶ │   Reverse proxy       │ ───▶ summonarr:3000
                   │  (optional, TLS)      │       │
                   └───────────────────────┘       │
                                                   ▼
                                             postgres:5432
                                                   │
                                                   ▼
                                         postgres-data  (named volume)
```

## Building the image yourself

The root [`docker-compose.yml`](./docker-compose.yml) builds from source using the local `Dockerfile` and reads `.env.local` (not `.env`):

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr

cp .env.example .env.local
${EDITOR:-vi} .env.local

docker compose build
docker compose up -d
docker compose logs -f summonarr
```

The Dockerfile is a four-stage build (deps → builder → migrate-deps → runner), produces a Next.js standalone bundle, runs as non-root `nextjs:nodejs` (UID 1001), and strips `npm`/`npx` from the final image to eliminate npm-bundled CVEs.

The set of required env vars is the same as the GHCR deploy — see [`docker-container/README.md`](./docker-container/README.md#environment-variables) for the full reference.

## Local (non-Docker) development

Docker is the supported deployment. For development against a local Postgres:

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr
npm install

cp .env.example .env
# Set DATABASE_URL directly when running Postgres yourself, e.g.:
#   DATABASE_URL=postgresql://summonarr:password@localhost:5432/summonarr
# Then fill in NEXTAUTH_SECRET (≥32 chars), AUTH_URL, CRON_SECRET (≥32 chars),
# TMDB_READ_TOKEN (or legacy TMDB_API_KEY), TRUST_PROXY.

npx prisma db push    # apply schema (no migrations folder)
npx prisma generate   # regenerate client (outputs to src/generated/prisma)
npm run dev
```

App runs at <http://localhost:3000> in dev mode.

Available scripts:

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start (production)
npm run lint         # eslint
npm run audit:deps   # custom TypeScript dep audit
npx tsc --noEmit     # type-check — there is no `typecheck` script
```

There is no test suite yet.

## Project structure

```
src/app/(app)/       user-facing pages + admin subtree (users, activity,
                     library, backup, audit-log, stats, issues)
src/app/api/         REST routes (sync, webhooks, auth, requests, issues,
                     ratings, play-history, profile, push, discord,
                     cron, health, admin/debug/…)
src/lib/             integrations: plex, jellyfin, jellyfin-availability,
                     arr, cron-auth, play-history, prisma, tmdb-types
src/components/      feature components; primitives under ui/
src/generated/prisma generated Prisma client (never edit by hand)
prisma/              schema.prisma (schema-first, no migrations folder)
public/              static assets
scripts/             build-time helpers (audit-deps, smoke-test-security, …)
Dockerfile              multi-stage standalone Next build, non-root user
docker-compose.yml      app + Postgres 17, builds from source, reads `.env.local`
docker-container/       ready-to-deploy setup pulling the GHCR image, reads `.env`
  README.md             deployment guide (env vars, proxy, webhooks, backups)
  docker-compose.yml    pulls ghcr.io/summonarr/summonarr:latest
  .env.example          annotated env template
docker-entrypoint.sh    schema sync, dedupe, cron loops, play-history poll
```

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for the architecture brief and Next 16 / contribution conventions.

## Security

Please report security issues privately per [`SECURITY.md`](./SECURITY.md). In short:

- Provider secrets, OAuth tokens, and Web Push subscription tokens are encrypted at rest with AES-256-GCM when `TOKEN_ENCRYPTION_KEY` is set.
- Database backups are encrypted with AES-256-GCM + PBKDF2-SHA256 using `BACKUP_DB_PASSWORD`.
- Webhook payloads are authenticated with a constant-time compare against the configured secret.
- All `/api/sync*` and `/api/cron*` endpoints gate on `CRON_SECRET` (or an admin session).
- The container runs as non-root (`nextjs:nodejs`, UID 1001), with `npm`/`npx` removed from the runtime image.
- Security headers (HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`) are applied to every response; `/api/*` responses set `Cache-Control: private, no-store` + `Vary: Cookie`.

## Changelog

### v0.11.0

**Breaking**

- **Legacy bcrypt password hashes are no longer accepted.** Since v0.10.x the local-credentials provider transparently rehashed bcrypt logins to scrypt on every successful sign-in; this release removes the bcrypt verify fallback entirely. Any local account that has *not* signed in since the rehash shipped will be unable to log in after upgrading. **Before deploying**, run `node scripts/migrate-legacy-passwords.mjs` — it lists any remaining `$2`-prefixed rows and must report zero. If it does not, re-run it with `--nullify` to clear those hashes, which sends the affected users through the password-reset flow on next sign-in. Plex, Jellyfin, and OIDC accounts are unaffected.
- The unused Plex and Jellyfin webhook routes (`/api/webhooks/plex`, `/api/webhooks/jellyfin`) and their `plexWebhookSecret` / `jellyfinWebhookSecret` settings have been removed. The settings UI never surfaced these URLs, and the 5-second play-history polling sync already ingests the same sessions (with richer transcode metadata), so no shipped install relied on them. Radarr and Sonarr webhooks are unchanged. Orphan `Setting` rows for the removed keys are harmless and may be deleted manually.

**Added**

- `SSE_MAX_LISTENERS` env var makes the SSE connection cap tunable (defaults to 500).
- "Fork me on GitHub" link in the mobile navigation drawer footer.

**Changed**

- The admin API documentation page now renders through a lightweight in-tree OpenAPI viewer instead of the bundled `swagger-ui-react`.
- Dependency-surface reduction: `bcryptjs`, `tsx`, `swagger-ui-react`, `shadcn`, `@auth/prisma-adapter`, `lucide-react`, and ~10 other packages dropped in favor of in-tree implementations — smaller image and less supply-chain surface, no behavior change.
- Text columns across `MediaRequest`, `Issue`, `AuditLog`, `PlayHistory`, `ActiveSession`, and others are now length-capped (`@db.VarChar`). The Docker entrypoint's `db push` auto-retry was extended to apply the resulting text→varchar narrowing casts and cascading primary-key rebuilds without requiring `SUMMONARR_ACCEPT_DATA_LOSS`.

**Fixed**

- **Concurrency / correctness pass.** Advisory locks added to `TVEpisodeCache` rewrites and the full setup-restore transaction; the sync orchestrator gained advisory locks, batched compare-and-swap updates, and graceful fallback across stale sources.
- **Security hardening.** `safe-fetch` closes a DNS-rebind window, SSRF-checks trusted hosts, and plugs IPv6 gaps; webhook routes gained a per-IP rate limit, tolerate malformed numerics, and return a unified 401 body; per-email auth rate-limit fallback; SMTP host pinned against DNS rebinding; non-admin session count capped; the Plex token cache is now bound by `plexUserId` rather than reassignable email.
- **Hydration / accessibility.** `absTime` pinned to UTC and day labels made timezone-stable (guardrail 16); the IP-info panel is portaled so it escapes table-grid clipping; keyboard-navigable activity rows and modal a11y improvements.
- `safe-fetch` strips stale `Content-Encoding` / `Content-Length` headers when re-wrapping a decompressed response body.
- The audit-log export pre-writes its row and validates the requested date range.
- Discord approval flow audited; issue GUID allowlist tightened; remaining hydration-unstable dates fixed.

### v0.10.4

**Changed**

- Runtime container base image bumped to Node 26 (`node:26.1.0-alpine3.23`).
- CI security tooling updated (`github/codeql-action` v4.35.5, `zizmorcore/zizmor-action` v0.5.6).

**Fixed**

- Patched a `brace-expansion` denial-of-service advisory (bumped to 5.0.6) without disturbing the legacy resolver path.
- Routine dependency refresh (`swagger-ui-react`, `eslint-config-next`).

### v0.10.3

**Added**

- Appearance system: selectable theme + accent color, with a new discover hero on the home page.
- Admin Requested page gains a media-type filter and a release-year sort.
- Activity titles now link through to a per-title page at `/admin/activity/media`; requests page shows content rating and external ratings.
- Sync auto-retries `APPROVED` requests that Radarr/Sonarr never accepted, instead of leaving them stuck.
- Play history captures the real transcode reason reported by the media server.

**Changed**

- Admin Activity overview redesigned (metrics dashboard, recent plays, now-playing).
- Project relicensed/clarified as AGPL-3.0-only with bundled third-party notices and a source link in the UI.

**Fixed**

- Activity dashboard metrics corrected and filter SQL consolidated into one builder.
- Play history Top movies/TV use real cover art and exclude rewatches; user "Most watched" prefers the live cache over a stale snapshot for artwork.
- Unmapped titles in user "Most watched", Recent plays, and the user detail page now resolve via a library fallback so they link correctly.

### v0.10.2

**Changed**

- CI security hardening to clear findings raised by the v0.10.1 scan suite against `main`:
  - `docker-publish.yml` now declares a top-level least-privilege `permissions: contents: read`; the publish job keeps its wider opt-in scopes (Scorecard `TokenPermissionsID`, HIGH).
  - `persist-credentials: false` on the `actions/checkout` step in all seven workflows that don't push back to the repo, so a compromised later step can't exfiltrate the cached `GITHUB_TOKEN` (Zizmor `artipacked`).
  - Dependabot now applies per-ecosystem cooldown windows (npm patch 2d / minor 5d / major 14d; github-actions 5/7/14; docker 3/5/14) so a freshly-published malicious or broken version has time to be retracted upstream before it lands in a PR. Patch windows kept short so CVE fixes still flow fast (Zizmor `dependabot-cooldown`).

No runtime or application code changed in this release.

### v0.10.1

**Added**

- Three new GitHub Actions security workflows: **Dependency Review** (PR-time block on new vulnerable deps or restricted licenses), **OSSF Scorecard** (weekly supply-chain hygiene score, published to the public OpenSSF registry), and **Zizmor** (static analyzer for the workflow files themselves).
- Per-source webhook secrets (`plexWebhookSecret`, `jellyfinWebhookSecret`, `radarrWebhookSecret`, `sonarrWebhookSecret`) with a legacy `webhookSecret` fallback. `scripts/migrate-webhook-secrets.mjs` copies the legacy value into the four new keys on first run.
- New `EmptyState` component used across browse, upcoming, top, and popular grids. Distinguishes TMDB config errors from filtered-empty cases and offers contextual CTAs ("Clear filters", "Switch to Most Played").

**Changed**

- a11y / mobile: aria-labels on 11 icon-only buttons (issue actions, activity history, filter bars, user-list filters, fix-match, user-table close); touch targets bumped to h-9 on push-device revoke, settings cron run, and settings clear-cache / cancel buttons; "This device" badge in auth-sessions made solid indigo + checkmark.
- Native `window.confirm` replaced with inline confirmations for admin vote dismiss, session revoke, push-device removal, user delete + revoke-all-sessions, issue take-over, and TRaSH spec "Forget".
- Visual contrast: activity-calendar empty cells use `--ds-bg-3`, active cells alpha range bumped to 0.45–1.0 for dark-mode legibility (legend included). `requests` AVAILABLE chip retoned to match the admin list. media-card corner badge drops the duplicate IMDb chip and shows the TMDB community score with a star icon instead. admin section card border radius normalized.

**Fixed**

- **Concurrency / correctness pass.** Jellyfin sync no longer wipes `TVEpisodeCache` on each `recentOnly` pass — delete is now scoped to recent `tmdbId`s. Admin PATCH to AVAILABLE uses an atomic `notifiedAvailable` CAS so users can't get two "now available" notifications when the sync orchestrator races the admin button. Radarr/Sonarr cache refresh hoisted ahead of the revert pass and gated on per-source success flags — a transient ARR outage no longer mass-demotes AVAILABLE → APPROVED. Plex and Jellyfin sync stop re-stamping `availableAt` on already-notified rows every tick.
- **Security audit batch** (31 findings). Webhook + interactions handlers reject oversized bodies via `Content-Length` pre-check; async `pbkdf2` and per-IP rate limit on the unauthenticated `setup/import` path; same-origin check on the admin-session branch of `isCronAuthorized` so cookie-based cron triggers can't be CSRF'd; Prisma extension forbids `setting.updateMany` with `value`; Jellyfin history cron pins `MediaServerUser.serverMachineId`; advisory lock gains optional `AbortSignal`; per-IP rate limit on the Plex login provider; SSRF-policy check on admin-configured SMTP host before constructing the nodemailer transport. Plus hydration fixes (guardrail 16) in three components and the activity calendar, BIGINT-cast regex guards on three admin warm routes, HMAC of the Plex token cache key, consistent Discord markdown escaping, and per-user scoping of the Discord search cache.
- **Dependency advisories cleared.** Next.js → 16.2.6 (resolves 13 GHSAs incl. proxy bypass, RSC cache poisoning, image-optimization DoS), react/react-dom → 19.2.6, resend → 6.12.3, tailwind-merge → 3.6.0, `github/codeql-action` → 4.35.4.
- **Docker base image.** Pin to `node:25.9.0-alpine3.23`, clearing 15 advisories including CVE-2026-21636 (critical) and CVE-2025-55130 (critical) that the previous floating `node:25-alpine3.21` tag was resolving to.
- `global-error.tsx` imports `globals.css` and uses `--ds-*` tokens so unrecoverable error pages adapt to light mode.
- `activity-history-table` surfaces fetch errors with a red error row + Retry button instead of silently swallowing them; `AbortError` is still ignored.
- `tmdb-core-sync` `$transaction` now passes `{ timeout: BATCH_TX_TIMEOUT }`.
- `fix-match` route: 50 success-progress logs deleted; 14 wrapper logs converted to direct `console.warn/error` with `[fix-match]` prefix per guardrail 7.
- Sonarr + Radarr webhook routes no longer log the "configure Authorization header instead" warning. Per guardrail 2, those services' webhook UIs have no header field — `?token=` is the only upstream-supported option, so the warning was pure noise.

### v0.10.0

**Added**

- Plex and Jellyfin **Save & Test** under Settings → Media — saving the connection now verifies it by loading libraries from the upstream server in one click, with the picker auto-populated on success.
- Settings page surfaces a banner listing any saved Setting that fails to decrypt (e.g. after `TOKEN_ENCRYPTION_KEY` rotation), with the affected key names so operators know which rows to re-save.
- Now Playing usernames in the admin Activity dashboard link directly to the per-user activity page.
- TRaSH Guides admin page split into tabbed sub-routes; apply/refresh hardened with lock symmetry, per-spec error tracking, and stricter input validation.

**Changed**

- TMDB poster grids use `next/image` optimisation — faster page loads and lower bandwidth.
- Play-history sync batches Setting reads, prefetches lookup maps, and parallelises writes — noticeably faster on large libraries.
- `[token-crypto]` legacy-plaintext warnings now name the affected row (e.g. `Setting.jellyfinApiKey`, `Account.access_token (id=…)`); non-sensitive Setting rows (URLs, booleans, feature flags, thresholds) are stored plaintext by design and no longer trigger the warning.

**Fixed**

- Settings page no longer 500s when one Setting row can't be decrypted — affected rows return as empty and are surfaced in the on-page banner instead of crashing the render path.
- Plex/Jellyfin/Radarr/Sonarr integrations rejecting credentials with HTTP 401 after the security rollout — collapsed double-encryption of Setting + Account tokens introduced by route-level pre-encryption layered on top of the Prisma extension. Recovery: `scripts/fix-double-encrypted.mjs`.
- **Comprehensive security audit pass.** `TOKEN_ENCRYPTION_KEY` is now mandatory at boot; Plex/Jellyfin sign-in bound to `(provider, sub)` instead of email; SSO users can no longer set local passwords; sync orchestrator wrapped in an advisory lock; webhooks scoped by `serverMachineId`; SSE allowlist split per-role so `ISSUE_ADMIN` no longer sees other users' request/vote/push events; donation URLs gated to `http(s)://`; tighter SSRF detection (incl. v4-mapped IPv6); statement_timeout on the advisory-lock client; new audit actions (FIX_MATCH, AUDIT_LOG_EXPORT, PLAY_HISTORY_DELETE, BATCH_REQUEST_DECLINE, VOTE_DISMISS_ALL, SERVER_USERS_BULK); session and machine-session hardening with UA fingerprint pinning. Operator action: set `TOKEN_ENCRYPTION_KEY=<64 hex chars>` and run `prisma db push` once on first start.
- Closed IDOR, SSRF, rate-limit, and compare-and-swap gaps across issues, Discord, profile, and Discord-interactions routes.
- Backup integrity: snapshot-isolated exports, proper JSON column escaping, duplicate-row tolerance during restore.
- Sync orchestrator and webhook handlers — race-condition and idempotency fixes.
- Admin egress tightened; play-history query inputs validated; admin audit trail expanded.
- TRaSH: Sonarr episode naming applied; first-apply error log quieted.
- Mobile: respect `safe-area-inset-top` on notched iOS and Android devices.

### v0.9.5

**Added**

- Live Watch on the admin Activity page — active sessions and recent plays refresh in real time via SSE.
- Jellyfin play-history capture: a dedicated cron job (`sync-jellyfin-history`) backfills completed sessions into Summonarr's history.

**Changed**

- Plex user download-permission controls removed from the admin Users page. The Plex sharing API does not expose a working remote toggle for `allowSync`, so the previous toggle persisted to the DB but never reflected on Plex. Jellyfin download enforcement is unchanged. Manage Plex download permissions in Plex itself.

### v0.9.4

**Added**

- Download-permission management layer for Plex and Jellyfin users — per-user enable/disable, bulk operations, diagnostics endpoint, and a background sync cron job (`sync-download-policies`).
- Chunked upload for DB restore and setup-mode import — large backup files no longer time out during upload.
- Setup-mode import panel with chunked upload support.

**Changed**

- `TRUST_PROXY=false` now restricts the app to local connections instead of crashing on startup.

**Fixed**

- Server Users table back-link now lands on the Users list, not the Activity overview.
- Server Users table columns are now sortable by header click.
- Mobile layout and responsive polish across several pages.

### v0.9.3

**Added**

- `lastRunAt` tracking for cron-only jobs (warm-activity, warm-list-cache, warm-mdblist, warm-omdb, ratings sync) so they surface in **Admin → Settings**.
- Public `/.well-known/security.txt` for security-disclosure contact.

**Changed**

- Expanded `SECURITY.md` with clearer disclosure policy and contact details.

**Fixed**

- React #418 hydration errors across six components — purged `Date.now()` / `new Date()` from `"use client"` render paths in `filter-bar`, `top-filter-bar`, `activity-history-table`, `activity-recent-plays`, `trash-guides-client`, and `activity-calendar`.
- Hydration mismatch from a nested `<button>` inside `MediaCard`.
- Hydration mismatch when `user.image` is unset (skip `AvatarImage` rather than render an empty `<img>`).
- TRaSH-Guides descriptions: HTML now stripped before render, with hardened sanitization against CodeQL-flagged tag-confusion patterns.
- Audit log labels: `ISSUE_CLAIM` and previously unmapped actions now render their human-readable label.
- Profile page falls back to the login email when `notificationEmail` is unset.
- **Most Played** now dedupes by `tmdbId` across Plex + Jellyfin so the same title doesn't double-count.
- Admin requester row: widened gap so the count badge stays readable next to long usernames.

### v0.9.2

**Added**

- TRaSH integration: import Custom Format Groups directly from the TRaSH `cf-groups` catalog.
- Issue claim: admins can claim an issue to scope subsequent reply notifications to themselves.
- Admin user management: per-user issue-notification toggle, visible for all users.

**Changed**

- Issue replies now fan out via email to the reporter and to other admins (not just the responder), honoring each user's `notifyOnIssue` preference.

**Fixed**

- Media activity page renders correctly when a user has no play history.
- `notifyOnIssue` is now respected when an admin replies to a reporter.

### v0.9.1

Prior release. See `git log v0.9.1` for details.

## Beta testing

Summonarr v0.11.0 is a beta release and real-world feedback is needed before a stable 1.0. If you run Plex or Jellyfin at home and want to help:

1. **Deploy** using [`docker-container/README.md`](./docker-container/README.md).
2. **Exercise the app** — browse, request movies and TV, approve them through Radarr/Sonarr, trigger webhooks, and use the admin pages.
3. **Report what breaks** — open a GitHub issue with the details listed in [Contributing](#contributing) below.

Particularly useful feedback:

- Anything that breaks with large Plex or Jellyfin libraries (thousands of items).
- Edge cases in the Radarr/Sonarr approval pipeline (stuck requests, missing badges).
- Auth flows: Plex OAuth, Jellyfin QuickConnect, and OIDC providers other than Authentik.
- Mobile layout issues or Web Push notification failures.

There is no mailing list or Discord. GitHub Issues is the only channel.

## Contributing

**Bug reports and feature requests are welcome.** If you open an issue, please include:

- A clear description of the problem or requested feature.
- Steps to reproduce (for bugs): what you did, what you expected, what actually happened.
- Relevant environment details: Docker image tag, host OS, which external services (Plex, Jellyfin, Radarr, Sonarr) are involved.
- Log output from `docker compose logs summonarr` covering the failure window.
- For request-pipeline issues: the output of `/api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` (admin only).

Issues opened without sufficient detail to reproduce or understand the problem may be closed without action.

## License

Summonarr is licensed under the **GNU Affero General Public License v3.0**. See [`LICENSE`](./LICENSE) for the full text.

This means that if you run a modified version of Summonarr on a network server and let others interact with it, you must also make the modified source code available to those users.
