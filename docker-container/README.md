# Summonarr — Docker deployment

Deploy Summonarr from the pre-built GHCR image. Two containers: the Summonarr app (Next.js + internal cron loop) and Postgres 17. This is the **supported install path**.

Prefer building from source? See the root [`docker-compose.yml`](../docker-compose.yml) and the [Building the image yourself](../README.md#building-the-image-yourself) section of the main README.

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Quick start](#quick-start)
3. [First-run checklist](#first-run-checklist)
4. [Environment variables](#environment-variables)
5. [Sub-path deployment (`BASE_PATH`)](#sub-path-deployment-base_path)
6. [Internal cron schedule](#internal-cron-schedule)
7. [Webhooks](#webhooks)
8. [Connecting external services](#connecting-external-services)
9. [Backups & restore](#backups--restore)
10. [Health, observability, troubleshooting](#health-observability-troubleshooting)
11. [Upgrading](#upgrading)
12. [Common commands](#common-commands)

> **Production deployments should sit behind a TLS-terminating reverse proxy** (Nginx, Caddy, Traefik, …). Configure the proxy to forward `Host`, `X-Forwarded-For` / `X-Real-IP`, and `X-Forwarded-Proto`; then set `AUTH_URL=https://your.domain` and `TRUST_PROXY=true` in `.env`. Specific proxy configs are out of scope for this README — consult your proxy's documentation.

## Prerequisites

You only need two files (`docker-compose.yml` and `.env`) — there's no need to clone the source tree. Before downloading them, get the following ready:

### Tools

- **Docker** 20.10+ with the **Compose v2** plugin (`docker compose …`, not `docker-compose …`)
- A machine with outbound HTTPS so Summonarr can reach TMDB, Plex, Jellyfin, Radarr, Sonarr, MDBList/OMDB (optional), and your OIDC provider (optional)

### TMDB credential (free)

Get one at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). Use a **v4 Read Access Token** (`TMDB_READ_TOKEN`, preferred) or a **v3 API key** (`TMDB_API_KEY`, legacy).

### Secrets to generate up front

Run these now and keep the output handy — you'll paste each value into `.env` in the next step. **Generate each one independently — don't reuse a value across variables.**

```bash
# NEXTAUTH_SECRET, CRON_SECRET, POSTGRES_PASSWORD, BACKUP_DB_PASSWORD
openssl rand -base64 32

# TOKEN_ENCRYPTION_KEY (must be exactly 64 hex chars / 32 bytes)
openssl rand -hex 32
# or:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Public URL

Decide what URL the app will live at — `http://localhost:3001` for a local trial, or your real hostname (e.g. `https://requests.example.com`) for production. You'll set this as `AUTH_URL`. The app refuses to boot in production without it.

### Optional upstream services

Anything you want to wire up later: Plex, Jellyfin, Radarr, Sonarr, SMTP, an OIDC IdP (Authelia/Authentik/Keycloak/Auth0/Okta/…). None of these need to be ready before first boot — you wire them up in the running app under **Admin → Settings**.

## Quick start

```bash
# 1. Make a directory and download the two files you need
mkdir summonarr && cd summonarr
curl -fsSL -O https://raw.githubusercontent.com/summonarr/summonarr/main/docker-container/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/summonarr/summonarr/main/docker-container/.env.example

# 2. Configure
${EDITOR:-vi} .env   # paste in the values you generated above

# 3. Launch
docker compose up -d

# 4. Watch it come up
docker compose logs -f summonarr
```

Open the URL you set as `AUTH_URL` (e.g. <http://localhost:3001>). **The first user to register is auto-promoted to `ADMIN`** — create your account before exposing the app publicly.

Minimum variables you must set in `.env` before the first `docker compose up`:

```dotenv
TMDB_READ_TOKEN=...          # v4 bearer token (preferred); or TMDB_API_KEY for v3
NEXTAUTH_SECRET=...          # ≥ 32 chars
AUTH_URL=http://localhost:3001
CRON_SECRET=...              # ≥ 32 chars
POSTGRES_PASSWORD=...
TOKEN_ENCRYPTION_KEY=...     # exactly 64 hex chars (32 bytes)
TRUST_PROXY=false            # set to "true" when behind Nginx/Traefik/Caddy
```

Everything else (`BACKUP_DB_PASSWORD`, `OIDC_*`, `JELLYFIN_URL`, schedule overrides, …) is optional — see [Environment variables](#environment-variables).

## First-run checklist

1. `docker compose up -d`, then watch `docker compose logs -f summonarr` for:
   - `Syncing database schema...` (from `prisma db push`)
   - `Starting Summonarr...`
   - `Cron started. …`
   - `Play history polling started (every 5s)`
2. Browse to `AUTH_URL` (e.g. <http://localhost:3001>). **Register the first account — it is auto-promoted to `ADMIN`.**
3. Open **Admin → Settings** and wire up the services you want:
   - **Plex** — URL + token (or sign in via plex.tv), then pick libraries.
   - **Jellyfin** — paste an API key from the Jellyfin dashboard, then pick libraries.
   - **Radarr / Sonarr** — base URL, API key, default quality profile, root folder (and for Sonarr a language profile).
   - **Webhooks** — generate the shared secret; paste it into each upstream service's webhook settings.
   - **SMTP / Push** — optional email and browser push notifications.
4. Click **Resync** on Plex/Jellyfin for the first full library pull. From there the internal cron loop takes over on `SYNC_INTERVAL`.

## Environment variables

The canonical, commented list lives in [`.env.example`](./.env.example) (also viewable on GitHub). Summary table follows.

### Required

The app refuses to boot in production if any of these are missing or invalid.

| Variable               | Constraints                                | Purpose                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMDB_READ_TOKEN`      | v4 bearer token                            | Preferred TMDB credential. Sent as a header, so the key never leaks into upstream access logs. Set this **or** `TMDB_API_KEY`.                                                           |
| `TMDB_API_KEY`         | v3 API key                                 | Legacy fallback. Sent as a query-string parameter and triggers a one-time deprecation warning at boot. Use `TMDB_READ_TOKEN` instead where possible.                                     |
| `NEXTAUTH_SECRET`      | **≥ 32 chars**                             | Signs JWT session tokens. `openssl rand -base64 32`.                                                                                                                                     |
| `AUTH_URL`             | Absolute URL incl. scheme                  | Public URL of the app. Pins NextAuth's base URL and blocks Host-header injection behind a proxy.                                                                                         |
| `CRON_SECRET`          | **≥ 32 chars**                             | Bearer token for `/api/sync*` and `/api/cron*`. The internal cron loop reads this from the container environment.                                                                        |
| `POSTGRES_PASSWORD`    | any; `openssl rand -base64 32` recommended | Password for the bundled Postgres. The entrypoint URL-encodes this and derives `DATABASE_URL` from it automatically.                                                                     |
| `TOKEN_ENCRYPTION_KEY` | **exactly 64 hex chars** (32 bytes)        | AES-256-GCM key for encrypting Plex/Jellyfin/Radarr/Sonarr API keys, SMTP passwords, push-subscription tokens, and OAuth accounts at rest. `openssl rand -hex 32`.                       |
| `TRUST_PROXY`          | exactly `"true"` or unset                  | `true` when behind a trusted reverse proxy — enables per-IP rate limiting from `X-Forwarded-For`. Anything else disables per-IP rate limiting and the app refuses to boot in production. |

### Strongly recommended in production

| Variable              | Constraints         | Purpose                                                                                                                                                  |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_DB_PASSWORD`  | **≥ 12 chars**      | **Required** to enable the Backup & Restore admin page — export and import return `503` without it. Losing it makes every prior encrypted backup unrecoverable. |
| `AUTH_TRUSTED_ORIGIN` | Comma-separated URLs | Extra origins allowed to make authenticated API calls (staging URL, internal hostname, LAN IP, …).                                                       |

### Sign-in / identity (optional)

| Variable             | Constraints                                                 | Purpose                                                                                                            |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `JELLYFIN_URL`       | Absolute URL                                                | Base URL of your Jellyfin server. Enables both standard and QuickConnect Jellyfin sign-in.                         |
| `OIDC_ISSUER`        | Absolute URL; must serve `.well-known/openid-configuration` | Any OIDC provider (Authelia, Authentik, Keycloak, Auth0, Okta, …). Must be set together with the client id/secret. |
| `OIDC_CLIENT_ID`     | provider-defined                                            | Client ID registered with the IdP.                                                                                 |
| `OIDC_CLIENT_SECRET` | provider-defined                                            | Client secret from the IdP.                                                                                        |
| `OIDC_DISPLAY_NAME`  | free-form; default `SSO`                                    | Optional label shown on the login button.                                                                          |

Plex OAuth is configured inside the app (**Admin → Settings → Plex**), not through environment variables.

### Schedule tuning (optional)

All intervals are in seconds and already have sensible defaults. The compose file passes these through to the container, so you can override any of them via `.env`:

| Variable                     | Default | What it schedules                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------------ |
| `SYNC_INTERVAL`              | `3600`  | Plex + Jellyfin library sync + Radarr/Sonarr wanted refresh.       |
| `UPCOMING_SYNC_INTERVAL`     | `86400` | TMDB upcoming titles.                                              |
| `RATINGS_SYNC_INTERVAL`      | `86400` | Ratings refresh.                                                   |
| `LIST_CACHE_SYNC_INTERVAL`   | `21600` | Discover-page list cache.                                          |
| `WARM_ACTIVITY_INTERVAL`     | `1800`  | Pre-computes the 365-day activity heatmap.                         |
| `WARM_MDBLIST_INTERVAL`      | `86400` | MDBList cache warmer.                                              |
| `WARM_OMDB_INTERVAL`         | `86400` | OMDB cache warmer.                                                 |
| `PLAY_HISTORY_SYNC_INTERVAL` | `5`     | Active-session poll (fast loop, decoupled from the 60s main tick). |
| `PURGE_SESSIONS_INTERVAL`    | `86400` | Expired auth-session purge.                                        |
| `SCRUB_AUDIT_PII_INTERVAL`   | `86400` | Audit-log PII scrubber.                                            |
| `TRASH_SYNC_INTERVAL`        | `86400` | TRaSH-Guides quality profile refresh.                              |

### Advanced / rarely needed

| Variable                       | Constraints                      | Purpose                                                                                                                                                         |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_PATH`                    | starts with `/`, no trailing `/` | Serve under a subpath, e.g. `/request`.                                                                                                                         |
| `SUMMONARR_VERSION`            | image tag; default `latest`      | Pin the GHCR image tag. Example: `SUMMONARR_VERSION=v0.9.3`.                                                                                                    |
| `DATABASE_URL`                 | postgres:// URI                  | Normally overridden automatically by the entrypoint from `POSTGRES_PASSWORD`. Set manually only when pointing at an external Postgres.                          |
| `DELAYED_JOBS_MAX_PENDING`     | integer; default `500`           | Upper bound on queued+running jobs. Raise only if you see delayed-job drops in the logs.                                                                        |
| `DELAYED_JOBS_MAX_QUEUE`       | integer; default `100`           | Max jobs waiting to be picked up (included in pending).                                                                                                         |
| `DELAYED_JOBS_MAX_CONCURRENCY` | integer; default `4`             | Concurrent workers draining the queue.                                                                                                                          |
| `/run/secrets/cron_secret`     | file mount                       | If mounted (Docker/Swarm secret), the entrypoint reads `CRON_SECRET` from the file so it doesn't appear in `docker inspect`. Takes precedence over the env var. |

## Sub-path deployment (`BASE_PATH`)

Running Summonarr at `https://example.com/request` instead of a dedicated hostname:

1. Set `BASE_PATH=/request` in your `.env`.
2. Set `AUTH_URL=https://example.com/request`.
3. Configure the proxy to forward requests under `/request/` **without stripping the prefix** — Summonarr's router expects to see the full path. Example for Nginx:

   ```nginx
   location /request/ {
     proxy_pass         http://127.0.0.1:3001;
     proxy_http_version 1.1;

     proxy_set_header Host              $host;
     proxy_set_header X-Real-IP         $remote_addr;
     proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

4. `docker compose up -d --force-recreate summonarr` so the new `BASE_PATH` is picked up.

## Internal cron schedule

The container runs its own cron loop (see `docker-entrypoint.sh`). It POSTs to each sync endpoint with `Authorization: Bearer $CRON_SECRET` over `http://localhost:3000`, so the secret never leaves the container.

Jobs that run on startup to warm caches:

- `/api/sync` — library + Radarr/Sonarr wanted
- `/api/cron/warm-list-cache`
- `/api/cron/warm-activity`

Jobs staggered after startup to avoid a thundering herd:

| Job                    | First run after start |
| ---------------------- | --------------------- |
| Upcoming sync          | +120s                 |
| Ratings sync           | +180s                 |
| MDBList warmer         | +240s                 |
| OMDB warmer            | +300s                 |
| TRaSH-Guides sync      | +360s                 |
| Auth-session purge     | +600s                 |
| Audit-log PII scrubber | +900s                 |

After the initial staggered fire, each job repeats on its own interval from [Schedule tuning](#schedule-tuning-optional).

Trigger sync manually if you need to:

```bash
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"full": true}' \
  http://localhost:3001/api/sync
```

Pass `{"full": true}` for a full atomic `delete-and-replace` sync; omit it for the default `recentOnly` path (insert-only within a 2-hour window).

## Webhooks

All four webhook handlers (Plex, Jellyfin, Sonarr, Radarr) authenticate the request against a shared secret using SHA-256 + `timingSafeEqual`. Configure the secret in **Admin → Settings → Webhooks**.

Two equivalent auth modes are supported — pick whichever the upstream service allows:

```
# Header (preferred where supported)
Authorization: Bearer <WEBHOOK_SECRET>

# Query-string fallback (Sonarr and Radarr webhook UIs have no header field)
https://requests.example.com/api/webhooks/sonarr?token=<WEBHOOK_SECRET>
```

Endpoints:

| Service  | URL                                              |
| -------- | ------------------------------------------------ |
| Plex     | `${AUTH_URL}/api/webhooks/plex`                  |
| Jellyfin | `${AUTH_URL}/api/webhooks/jellyfin`              |
| Sonarr   | `${AUTH_URL}/api/webhooks/sonarr?token=<secret>` |
| Radarr   | `${AUTH_URL}/api/webhooks/radarr?token=<secret>` |

No HMAC payload signing — none of the upstream services sign their bodies.

## Connecting external services

All service wiring is done in the running app (**Admin → Settings**) and persisted to the `Setting` table. Secrets are encrypted at rest with AES-256-GCM via `TOKEN_ENCRYPTION_KEY`.

### Plex

1. Admin → Settings → Plex → paste the server URL and either sign in via plex.tv to grab a token or paste one.
2. Choose libraries to ingest.
3. Click **Resync** for the first full pull.

### Jellyfin

1. Set `JELLYFIN_URL` in `.env`.
2. Admin → Settings → Jellyfin → paste an API key from the Jellyfin dashboard.
3. Pick libraries. Incremental sync uses a 2-hour `MinDateLastSaved` window, so a missed run is survivable.

### Radarr & Sonarr

1. Admin → Settings → Radarr (or Sonarr) → paste the base URL + API key.
2. Pick a default quality profile, root folder, and (for Sonarr) a language profile.
3. Approving a request sends it to Radarr/Sonarr and the wanted-items cache refreshes on the next sync tick.

### OIDC / SSO

1. Register a new application with your IdP. Callback URL: `${AUTH_URL}/api/auth/callback/oidc`.
2. Copy the issuer, client ID, and client secret into your `.env`:

   ```dotenv
   OIDC_ISSUER=https://auth.example.com
   OIDC_CLIENT_ID=summonarr
   OIDC_CLIENT_SECRET=...
   OIDC_DISPLAY_NAME=Authentik
   ```
3. `docker compose up -d --force-recreate summonarr`. The "Sign in with SSO" button appears automatically.

## Backups & restore

With `BACKUP_DB_PASSWORD` set, **Admin → Backup & Restore** enables:

- **Export** — an AES-256-GCM + PBKDF2-SHA256-encrypted `.sql.enc` of the full database.
- **Restore** — upload an encrypted dump and import it.

The password is sourced from the environment (not the UI): a compromised admin account can still *trigger* a backup, but the resulting file is unreadable without shell/env access to the server. **Lose this password and every prior backup is unrecoverable.** Store it in a password manager alongside your other secrets.

For disaster-recovery, also back up the Postgres volume directly:

```bash
# Dump (plain text; pair with BACKUP_DB_PASSWORD-encrypted dumps for defence in depth)
docker compose exec -T postgres pg_dump -U summonarr summonarr > summonarr.sql

# Restore onto a fresh volume
docker compose exec -T postgres psql -U summonarr -d summonarr < summonarr.sql
```

## Health, observability, troubleshooting

- **Health endpoint** — `GET /api/health` returns a lightweight JSON payload. It's the Docker `healthcheck` target (10s interval, 30s start period).
  ```bash
  docker compose exec summonarr wget -qO- http://localhost:3000/api/health
  ```
- **Debug endpoint** — admin-only. `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps cache rows, `attachArrPending` output, a live Radarr/Sonarr probe, the tvdb→tmdb mapping, wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. **Start here** when a request is "stuck pending" or a badge looks wrong.
- **Audit log** — **Admin → Audit Log** surfaces every sync run, webhook delivery, admin mutation, and webhook auth failure. PII is scrubbed on `SCRUB_AUDIT_PII_INTERVAL`.
- **Logging convention** — `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Happy-path success is deliberately silent. If you see nothing in the logs, that's usually good news.

## Upgrading

```bash
cd /path/to/summonarr   # the directory containing your docker-compose.yml + .env
docker compose pull
docker compose up -d
docker compose logs -f summonarr   # watch prisma db push apply any schema changes
```

Schema changes are applied on every container start via `prisma db push` (no migrations directory, no manual step). Destructive schema changes (dropped columns, narrowed types) will **fail fast at boot** instead of silently clobbering data — apply those by hand with explicit intent when they come up.

Before upgrading across a minor version, skim the commit history for `feat`/`perf` entries under the `sync`, `plex`, `jellyfin`, or `arr` scopes — those are the changes most likely to affect external-service wiring.

Pin to a specific version instead of `latest` by setting `SUMMONARR_VERSION` in `.env`:

```dotenv
SUMMONARR_VERSION=v0.9.3
```

To pick up new variables added to `.env.example` between releases, re-fetch it side-by-side and diff:

```bash
curl -fsSL -o .env.example.new https://raw.githubusercontent.com/summonarr/summonarr/main/docker-container/.env.example
diff .env .env.example.new
```

## Common commands

```bash
# Tail app logs
docker compose logs -f summonarr

# Tail Postgres logs
docker compose logs -f postgres

# Shell into the app container
docker compose exec summonarr sh

# Open a psql session
docker compose exec postgres psql -U summonarr -d summonarr

# Force-recreate after editing .env (docker compose does NOT auto-reload env files)
docker compose up -d --force-recreate summonarr

# Full teardown, keep the data volume
docker compose down

# Full teardown, DELETE the data volume (destroys everything)
docker compose down -v

# Manually trigger a full sync from the host
curl -X POST \
  -H "Authorization: Bearer $(grep ^CRON_SECRET .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"full": true}' \
  http://localhost:3001/api/sync
```

Editing `.env` does not hot-reload inside a running container. Run `docker compose up -d --force-recreate summonarr` for env changes to take effect.
