# syntax=docker/dockerfile:1
# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:26.3.0-alpine3.23@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS deps
WORKDIR /app

RUN apk upgrade --no-cache

COPY package*.json ./
# patch-eslint-plugin-react.mjs runs from package.json's postinstall hook
# to fix the eslint-plugin-react / ESLint 10 incompatibility. It has to
# exist on disk before `npm ci` triggers the hook, so copy it ahead of
# the rest of the source tree.
COPY scripts/patch-eslint-plugin-react.mjs ./scripts/patch-eslint-plugin-react.mjs
# BuildKit cache mount keeps ~/.npm warm across builds — repeat installs
# pull from local cache instead of re-downloading from the registry.
# --prefer-offline forces use of the cache when present; --no-audit/--no-fund
# skip the registry round-trips that npm normally adds to ci runs.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --prefer-offline --no-audit --no-fund

# ── Stage 1b: prisma-gen (runs on native builder platform) ───────────────────
# Running `prisma generate` under QEMU (when cross-building for a non-native
# target like linux/arm64 on an amd64 runner) crashes Prisma's schema-engine
# binary. The generated client is platform-independent JavaScript — we use
# @prisma/adapter-pg (Driver Adapter mode), not the native query engine — so
# it is safe and much faster to generate on $BUILDPLATFORM and copy the
# output into the target-arch builder stage.
FROM --platform=$BUILDPLATFORM node:26.3.0-alpine3.23@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS prisma-gen
WORKDIR /app

RUN apk upgrade --no-cache

COPY package.json package-lock.json ./
COPY scripts/prune-lockfile.mjs ./scripts/prune-lockfile.mjs
# `prisma generate` needs only the prisma CLI + @prisma/client (which the
# generator imports types from) — installing the full 700-package tree here
# was wasted work (~90s of duplicate downloads with the `deps` stage).
# prune-lockfile.mjs carves those packages plus their transitive closure out
# of the repo lockfile so `npm ci` installs them hash-pinned to the vetted
# resolutions instead of re-resolving transitives at build time (OpenSSF
# Scorecard: Pinned-Dependencies). Cache mount shares ~/.npm with the deps
# stage so repeat builds are near-instant.
RUN node scripts/prune-lockfile.mjs --out . prisma @prisma/client dotenv
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline

COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
# prisma.config.ts asserts DATABASE_URL is defined. `prisma generate` does not
# connect, but the assertion still fires — provide a dummy to satisfy it.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN npx prisma generate

# ── Stage 2: builder ──────────────────────────────────────────────────────────
FROM node:26.3.0-alpine3.23@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS builder
WORKDIR /app

RUN apk upgrade --no-cache

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Pull the prisma client generated on $BUILDPLATFORM into the target-arch tree.
COPY --from=prisma-gen /app/src/generated/prisma ./src/generated/prisma

# Build Next.js (standalone output)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: migrate-deps ─────────────────────────────────────────────────────
# Install ONLY prisma + dotenv using exact versions from the lockfile.
# npm resolves the full transitive dep tree (pathe, @prisma/*, jiti, etc.) automatically.
# No build tools needed — prisma has no native addons (engines are pre-compiled binaries).
FROM node:26.3.0-alpine3.23@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS migrate-deps
WORKDIR /app

RUN apk upgrade --no-cache
COPY package.json package-lock.json ./
COPY scripts/prune-lockfile.mjs ./scripts/prune-lockfile.mjs
# prisma + dotenv + pg, hash-pinned: prune-lockfile.mjs carves them plus
# their transitive closure out of the repo lockfile so `npm ci` installs the
# vetted resolutions instead of re-resolving at build time (OpenSSF
# Scorecard: Pinned-Dependencies). Overrides (hono, @hono/node-server, …)
# come from the root package.json automatically — the previous inline copy
# of that list had already drifted from it. These node_modules ship into the
# runner image, so build-time resolution here was a real supply-chain gap.
# Cache mount shares ~/.npm with deps + prisma-gen stages.
RUN node scripts/prune-lockfile.mjs --out . prisma dotenv pg
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline

# ── Stage 4: runner ───────────────────────────────────────────────────────────
FROM node:26.3.0-alpine3.23@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS runner
WORKDIR /app

# Upgrade Alpine packages (fixes libssl3/libcrypto3/busybox/musl CVEs).
# Remove npm and npx — the entrypoint uses node directly; no npm needed at runtime.
# This eliminates the entire class of npm-bundled CVEs (picomatch, brace-expansion, etc).
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cap the V8 heap so GC runs more aggressively instead of accumulating garbage.
# RSS will still exceed this (code, stack, native libs add ~50-80 MB on top).
ENV NODE_OPTIONS=--max-old-space-size=1024

# Non-root user, data dir, and cache dir in one layer
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /data /app/.next/cache && \
    chown nextjs:nodejs /data /app/.next/cache

# Standalone output — bundles its own minimal node_modules (next, react, etc.)
# Prisma 7 generates the client into src/generated/prisma (traced as source), so @prisma/* is
# not in the standalone's node_modules and does not need to come from prod deps.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma schema, migrations, and config for migrate deploy at startup
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# License compliance: Next.js standalone tracing strips LICENSE/NOTICE files
# from node_modules, so the project license (AGPL-3.0) and the third-party
# notices (MIT/BSD/ISC/Apache attribution + the LGPL libvips relink notice
# and full LGPL/GPL text) must be carried into the image explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/LICENSE ./LICENSE
COPY --from=builder --chown=nextjs:nodejs /app/THIRD_PARTY_LICENSES.txt ./THIRD_PARTY_LICENSES.txt

# Operator scripts invoked via `docker compose exec` (no runtime imports).
# Standalone-traced — only what's listed here ships. `pg` ships in node_modules
# already (migrate-deps stage), so these scripts have what they need.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/reset-password.mjs ./scripts/reset-password.mjs

# Merge prisma CLI deps on top of the standalone's node_modules.
# COPY into an existing directory adds files without removing what's already there,
# so the standalone's next, react, etc. are preserved.
COPY --from=migrate-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

# Entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Container health probe — hits the in-app /api/health endpoint. Wide start-period
# covers cold-start (Next standalone boot + Prisma migrate deploy on first run).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
