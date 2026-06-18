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
11. [Recovery — admin locked out](#recovery--admin-locked-out)
12. [Upgrading](#upgrading)
13. [Common commands](#common-commands)

> **Production deployments should sit behind a TLS-terminating reverse proxy** (Nginx, Caddy, Traefik, …). Configure the proxy to forward `Host`, `X-Forwarded-For` / `X-Real-IP`, and `X-Forwarded-Proto`; then set `AUTH_URL=https://your.domain` and `TRUST_PROXY=true` in `.env`. Specific proxy configs are out of scope for this README — consult your proxy's documentation.

## Prerequisites

You only need two files (`docker-compose.yml` and `.env`) — there's no need to clone the source tree. Before downloading them, get the following ready:

### Tools

- **Docker** 20.10+ with the **Compose v2** plugin (`docker compose …`, not `docker-compose …`)
- A machine with outbound HTTPS so Summonarr can reach TMDB, Plex, Jellyfin, Radarr, Sonarr, MDBList/OMDB (optional), and your OIDC provider (optional)

### TMDB credential (free)

Get one at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). Use a **v4 Read Access Token** (`TMDB_READ_TOKEN`).

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
TMDB_READ_TOKEN=...          # v4 bearer token
NEXTAUTH_SECRET=...          # ≥ 32 chars
AUTH_URL=http://localhost:3001
CRON_SECRET=...              # ≥ 32 chars
POSTGRES_PASSWORD=...
TOKEN_ENCRYPTION_KEY=...     # exactly 64 hex chars (32 bytes)
TRUST_PROXY=false            # set to "true" when behind Nginx/Traefik/Caddy
```

Everything else (`BACKUP_DB_PASSWORD`, `OIDC_*`, schedule overrides, …) is optional — see [Environment variables](#environment-variables). Jellyfin is configured in-app (Admin → Settings → Media), not via env var.

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
| `TMDB_READ_TOKEN`      | v4 bearer token                            | Required TMDB credential. Sent as a header, so the key never leaks into upstream access logs.                                                                                           |
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
| `SUMMONARR_VERSION`            | image tag; default `latest`      | Pin the GHCR image tag. Example: `SUMMONARR_VERSION=v0.13.3`.                                                                                                   |
| `DELAYED_JOBS_MAX_PENDING`     | integer; default `500`           | Upper bound on queued+running jobs. Raise only if you see delayed-job drops in the logs.                                                                        |
| `DELAYED_JOBS_MAX_QUEUE`       | integer; default `100`           | Max jobs waiting to be picked up (included in pending).                                                                                                         |
| `DELAYED_JOBS_MAX_CONCURRENCY` | integer; default `4`             | Concurrent workers draining the queue.                                                                                                                          |
| `SSE_MAX_LISTENERS`            | integer; default `500`           | Concurrent real-time (SSE) connection cap; also raises the emitter listener limit so the two stay in lockstep. Raise for large/heavily multi-tabbed deployments. |
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

1. Admin → Settings → Media → Jellyfin → paste the server URL and an API key from the Jellyfin dashboard. Saving both turns on Jellyfin sign-in (standard + QuickConnect).
2. Pick libraries. Incremental sync uses a 2-hour `MinDateLastSaved` window, so a missed run is survivable.

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

## Recovery — admin locked out

If you've lost access to the only admin account (forgotten password, OIDC provider broke, Plex/Jellyfin OAuth misconfigured, etc.), Summonarr ships a recovery script in the image. It runs against the running database with **shell access to the host** as the only prerequisite — no app login required.

> **What this script can and can't do.** It resets the password (and optionally promotes to ADMIN) for a **local-credentials account** — accounts that log in with email + password against Summonarr's own user table. **It does not work for Plex / Jellyfin / OIDC users**, because their passwords live on the upstream identity provider, not in Summonarr's database. For those, you'd recover by fixing the OAuth/OIDC side and (if needed) creating a fresh local account first via the steps below.

### When to use this

- You've forgotten the password for a local admin account.
- Your OIDC IdP is misconfigured / unreachable and every admin signs in through it.
- A Plex token rotation locked out the only admin who had Plex-based access.
- You're recovering from a botched setup and want to force a fresh admin.

### What the script does

1. Generates a fresh scrypt hash for the password you provide (same parameters as the live app — see [`src/lib/password-hash.ts`](https://github.com/summonarr/summonarr/blob/main/src/lib/password-hash.ts)).
2. Updates the `User.passwordHash` column for the row matching your email (**case-insensitive**).
3. Sets `User.passwordChangedAt = NOW()` — this **invalidates every existing JWT for that user**. Every device they were signed in on gets logged out immediately.
4. Optionally promotes that user to `role = 'ADMIN'` if you pass `--admin`.

If no row matches the email, the script exits with code `2` and **no changes are made** to the database.

### Prerequisites

- The `summonarr` container is **running and healthy** (check with `docker ps`).
- You're on a Summonarr image **≥ `v0.11.1`** (the script was added in that release). Pin with `SUMMONARR_VERSION=v0.11.1` in `.env`, or run `:latest`.
- You can run `docker exec` against the container — usually means root or membership in the `docker` group.
- The new password is **at least 8 characters**. The script refuses anything shorter with exit code `1`.

### Step 1 — Confirm the email you'll reset

Open a psql session on the Postgres container and list every account so you pick the right email:

```bash
sudo docker exec -it summonarr-postgres \
  psql -U summonarr -d summonarr \
  -c 'SELECT email, role, "passwordHash" IS NOT NULL AS has_local_password FROM "User" ORDER BY "createdAt";'
```

Look for the row where `has_local_password` is `t` (true). If your row shows `f` (false), the account is OAuth-only — see the [No local password yet](#no-local-password-yet) section below.

### Step 2 — Reset the password

Run this from anywhere on the host (no compose file needed — the container is targeted by name):

```bash
sudo docker exec -w /app \
  -e PGHOST=postgres \
  -e PGUSER=summonarr \
  -e PGDATABASE=summonarr \
  summonarr \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" node scripts/reset-password.mjs YOUR_EMAIL YOUR_NEW_PASSWORD'
```

Replace **`YOUR_EMAIL`** with the email from Step 1 and **`YOUR_NEW_PASSWORD`** with the password you want to set. Wrap the password in single quotes if it contains spaces or shell metacharacters (`$`, `!`, `&`, `` ` ``, `*`, `(`, `)`).

**To promote to ADMIN at the same time**, add `--admin`:

```bash
sudo docker exec -w /app \
  -e PGHOST=postgres -e PGUSER=summonarr -e PGDATABASE=summonarr \
  summonarr \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" node scripts/reset-password.mjs YOUR_EMAIL YOUR_NEW_PASSWORD --admin'
```

On success, the script prints:

```
Password reset for you@example.com (ADMIN) [id: <cuid>]. All existing sessions invalidated.
```

The role in parentheses is the role **after** the update, so it should show `ADMIN` if you used `--admin`.

### Stdin variant (recommended for production)

Keeps the password out of your shell history, `ps`, and `docker inspect`:

```bash
echo -n 'YOUR_NEW_PASSWORD' | sudo docker exec -i -w /app \
  -e PGHOST=postgres -e PGUSER=summonarr -e PGDATABASE=summonarr \
  summonarr \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" node scripts/reset-password.mjs YOUR_EMAIL --stdin --admin'
```

The `-i` flag attaches stdin to the container. `echo -n` avoids appending a trailing newline (the script also strips one defensively, but explicit is better).

### Step 3 — Sign in

1. Open Summonarr in your browser and sign out if you're somehow still signed in (close any cached tabs).
2. Sign in with the **email** from Step 1 and the **new password** you just set.
3. The new session bumps `User.passwordChangedAt` already happened in Step 2, so **every other device that was signed in is now logged out** — you'll need to re-sign-in on phones, tablets, other browsers, etc.

### Why a docker-compose form isn't shown

`docker compose exec` only works from a directory containing your `docker-compose.yml`. The plain `docker exec` form above works from anywhere because it targets the container by name (`summonarr`, which you can see in `docker ps`). If you'd rather use compose, `cd` to your compose directory first and replace `docker exec` with `docker compose exec` — every other flag is identical.

The compose file isn't strictly required for this operation: the script needs the database, not the compose project metadata.

### Why these `-e` flags

The recovery script reads either four `PG*` environment variables **or** a `DATABASE_URL` to find the database. The live app constructs `DATABASE_URL` inside `docker-entrypoint.sh` at startup, **but that export does not propagate to `docker exec`** (exec gets a fresh shell from the docker daemon, not a child of the entrypoint). Passing the four `PG*` vars explicitly is the cleanest way to give the script what it needs:

| Flag | Value | Why |
|---|---|---|
| `PGHOST=postgres` | DNS name of the Postgres service inside the docker network | This is what the app entrypoint also points at; `localhost` from inside the app container is **not** Postgres. |
| `PGUSER=summonarr` | Database user the app uses | Created automatically by the Postgres container's init from `POSTGRES_USER`. |
| `PGDATABASE=summonarr` | Database name the app uses | Same — from `POSTGRES_DB`. |
| `PGPASSWORD="$POSTGRES_PASSWORD"` (resolved by `sh -c` inside the container) | The password the Postgres container booted with | `POSTGRES_PASSWORD` is in the container's env (from `env_file: .env` in your compose), so we resolve it **inside** the container via `sh -c` rather than leaking it on the host. |

If you've changed `POSTGRES_USER` or `POSTGRES_DB` in your `.env` away from the defaults (`summonarr` / `summonarr`), substitute the values you used.

### Troubleshooting

**`ECONNREFUSED ::1:5432 / 127.0.0.1:5432`** — The script ran without database connection info and fell through to `pg`'s localhost defaults. Either you ran the script on the host directly (run it inside the container with `docker exec`), or one of the `PG*` flags is missing. Re-check the command — all four `-e PG*` flags are required.

**`No user found with email ...`** — The email isn't in the `User` table, or it has a different case than you typed (the script normalises both sides to lowercase, so case shouldn't matter — double-check spelling). Re-run Step 1 to list every account.

**`Password must be at least 8 characters.`** — Exactly that. Use ≥ 8.

**`Cannot parse DATABASE_URL`** (only seen when overriding) — If you bypassed the `PG*` flags and passed your own `DATABASE_URL`, it doesn't match `postgres://user:pass@host:port/db`. Either fix the URL or switch back to the four `PG*` flags.

**It worked but I still can't sign in** — Hard-refresh the login page (your browser may still have an old, now-invalid session cookie). If the form rejects the password, run the reset again with a simpler password (no shell-sensitive chars) to rule out quoting issues.

### No local password yet

If your only admin account is a Plex / Jellyfin / OIDC user — that is, `passwordHash IS NULL` for every row — there's no `passwordHash` column for the script to update. You'll need to give that account a local password first by setting `passwordHash` directly via `psql` (then run the script to re-hash with proper scrypt params), or run the script with a non-existent email argument **after** manually inserting a fresh local user row. Both routes require comfort with raw SQL; if neither sounds safe, file a GitHub issue with the details of your setup before changing anything.

### Audit-log trail

Resetting a password via this script does **not** currently write an entry to `AuditLog` — the script bypasses the application layer entirely. If you want a record, note the action in your own ops journal. (Improving this is a known follow-up; the existing `SETTINGS_CHANGE` action would be the natural fit.)

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
SUMMONARR_VERSION=v0.13.3
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
