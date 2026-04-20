# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending, popular, discover, upcoming), request movies and TV, vote on requests, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. Summonarr ingests Plex and Jellyfin libraries plus play history, so users see availability, active sessions, and watch activity in one place.

> Status: early development (v0.1). Expect rough edges.

## Features

- TMDB-powered browse: trending, popular, discover, upcoming
- Movie and TV requests with voting and issue tracking
- Admin approval with automatic fulfillment through Radarr and Sonarr
- Plex and Jellyfin library + play-history ingestion
- Active-session and watch-activity dashboards
- Local, Plex OAuth, Jellyfin (standard + QuickConnect), and OIDC sign-in
- Encrypted-at-rest secrets and encrypted database backups
- Webhook support for Plex, Jellyfin, Sonarr, and Radarr

## Stack

- **Next.js 16** (App Router) + TypeScript (strict)
- **Prisma 7** with PostgreSQL 17 (schema-first, `prisma db push`)
- **NextAuth v5** with JWT sessions and a custom `AuthSession` table
- **Tailwind v4** (inline `@theme` in `src/app/globals.css`)
- **UI**: `@base-ui/react` primitives via the `shadcn` CLI
- **Package manager**: npm

## Requirements

- Node.js 22+
- PostgreSQL 17
- A TMDB API key ([get one free](https://www.themoviedb.org/settings/api))
- Optional: Radarr, Sonarr, Plex, Jellyfin, SMTP for notifications

## Getting started (local dev)

```bash
git clone https://github.com/<your-user>/Summonarr.git
cd Summonarr
npm install
cp .env.example .env
# fill in DATABASE_URL, NEXTAUTH_SECRET, AUTH_URL, CRON_SECRET, TMDB_API_KEY, TRUST_PROXY
npx prisma db push
npm run dev
```

App runs at http://localhost:3000.

## Getting started (Docker)

```bash
cp .env.example .env
# fill in the required vars (see .env.example for the full list)
docker compose up -d
```

The compose stack includes the app, Postgres, and cron workers for library sync and upcoming-title refresh.

## Scripts

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start (production)
npm run lint         # eslint
npm run audit:deps   # custom TypeScript dep audit
npx tsc --noEmit     # type-check (there is no `typecheck` script)
```

## Configuration

All configuration is via environment variables. See [`.env.example`](./.env.example) for the full, commented list. The required variables are:

- `DATABASE_URL` (or `POSTGRES_PASSWORD` when using the bundled compose stack)
- `NEXTAUTH_SECRET`
- `AUTH_URL` (public URL of the app)
- `CRON_SECRET` (≥ 32 chars)
- `TRUST_PROXY`
- `TMDB_API_KEY`

Set `TOKEN_ENCRYPTION_KEY` (32 bytes / 64 hex chars) in production to encrypt secrets at rest. Set `BACKUP_PASSWORD` to enable backup/restore.

## Project structure

```
src/app/(app)/    user-facing pages + admin subtree
src/app/api/      REST routes (sync, webhooks, auth, requests, issues, …)
src/lib/          integrations: plex, jellyfin, arr, play-history, prisma
src/components/   feature components; primitives under ui/
prisma/           schema.prisma (schema-first, no migrations folder)
public/           static assets
scripts/          build-time helpers (audit-deps, etc.)
```

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture brief.

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss substantial changes first. There is no test suite yet; run `npm run lint` and `npx tsc --noEmit` before opening a PR.

## License

Summonarr is licensed under the **GNU Affero General Public License v3.0**. See [`LICENSE`](./LICENSE) for the full text.

This means that if you run a modified version of Summonarr on a network server and let others interact with it, you must also make the modified source code available to those users.
