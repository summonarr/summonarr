# Summonarr

Self-hosted media request aggregator. Browse TMDB (trending, popular, discover, upcoming), request movies and TV, vote on requests, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. Summonarr ingests Plex and Jellyfin libraries plus play history, so users see availability, active sessions, and watch activity in one place.

> **Status:** v0.14.0 beta — feature-complete for the initial release. **Beta testers wanted** — see [Beta testing](#beta-testing).

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
- Radarr and Sonarr webhooks for instant request fulfillment (Plex activity via a real-time SSE stream, Jellyfin via a 5-second poller — no Plex/Jellyfin webhook needed)
- Optional Discord (bot), SMTP/Resend email, and ratings providers (OMDb, MDBList, Trakt) — all configured in-app
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

The Dockerfile is a five-stage build (deps → prisma-gen → builder → migrate-deps → runner), produces a Next.js standalone bundle, runs as non-root `nextjs:nodejs` (UID 1001), and strips `npm`/`npx` from the final image to eliminate npm-bundled CVEs.

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
# Then fill in the boot-required secrets:
#   NEXTAUTH_SECRET       (≥ 32 chars)
#   CRON_SECRET           (≥ 32 chars)
#   TOKEN_ENCRYPTION_KEY  (exactly 64 hex chars — `openssl rand -hex 32`; the app
#                          exits at boot without it)
#   AUTH_URL, TMDB_READ_TOKEN, TRUST_PROXY
# Optional sign-in: OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET (see
# docker-container/README.md → Connecting external services → OIDC / SSO).

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
- For internet-facing deployments, follow the operational hardening checklist — proxy log redaction for webhook tokens, blocking `/api/setup/*` until first-run completes, `CRON_SECRET` / machine-session handling, APNs relay trust, and file-mounted secrets — in [`docker-container/README.md`](./docker-container/README.md#security-hardening-operational).

## Privacy

Summonarr is self-hosted: the developer operates no servers and collects no data. The iOS app talks only to the server you run and to TMDB's image CDN for artwork. See [`PRIVACY.md`](./PRIVACY.md) for the full policy (also used as the App Store privacy policy URL).

## Changelog

### v0.14.0

**Added**

- Watchlist: a personal watchlist — add titles from any detail page and browse them on the new **Watchlist** page.
- "Not interested": hide titles you don't want to see and they drop off every discovery surface (home, movies, TV, search, upcoming, top). Manage them on the new **Hidden** page.
- Title blacklist: admins can blacklist a title, which then shows as unrequestable everywhere — web and Discord — instead of being silently hidden.
- Parental controls: a per-user content-rating cap that blocks requests for titles above a chosen maturity rating, enforced on both the web and Discord request paths.
- Quality profiles: users with the advanced-request permission can pick a Radarr/Sonarr quality profile at request time.
- Requester tags: Radarr/Sonarr adds are tagged with the requesting user, so admins can see who asked for a title.
- Notifications: an in-app notification inbox with a real-time bell and unread badge, a full **Notifications** page (mark-read and clear), and success toasts for actions like watchlisting, hiding, requesting in 4K, and reporting an issue.
- Email notifications: Jellyfin users can add and verify their own notification email address from their profile.

**Fixed**

- Requests: a second user can again request a title that is already queued for someone else (the web UI was incorrectly blocking it).
- Email: the notification-email preference now gates every notification send.
- API: rate-limited responses now include a `Retry-After` header so clients back off correctly.
- Hardening: bounded async fan-outs and added request-size caps, input validation, and admin-account guards across the admin, requests, and sync paths.

## Beta testing

Summonarr v0.14.0 is a beta release and real-world feedback is needed before a stable 1.0. If you run Plex or Jellyfin at home and want to help:

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
