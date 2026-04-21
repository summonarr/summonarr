# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:25-alpine3.21 AS deps
WORKDIR /app

RUN apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --legacy-peer-deps

# ── Stage 1b: prisma-gen (runs on native builder platform) ───────────────────
# Running `prisma generate` under QEMU (when cross-building for a non-native
# target like linux/arm64 on an amd64 runner) crashes Prisma's schema-engine
# binary. The generated client is platform-independent JavaScript — we use
# @prisma/adapter-pg (Driver Adapter mode), not the native query engine — so
# it is safe and much faster to generate on $BUILDPLATFORM and copy the
# output into the target-arch builder stage.
FROM --platform=$BUILDPLATFORM node:25-alpine3.21 AS prisma-gen
WORKDIR /app

RUN apk upgrade --no-cache

COPY package*.json ./
# --ignore-scripts skips any target-arch postinstall hooks; we only need the
# prisma CLI and its deps to run `prisma generate` on the build host.
RUN npm ci --legacy-peer-deps --ignore-scripts

COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
# prisma.config.ts asserts DATABASE_URL is defined. `prisma generate` does not
# connect, but the assertion still fires — provide a dummy to satisfy it.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN npx prisma generate

# ── Stage 2: builder ──────────────────────────────────────────────────────────
FROM node:25-alpine3.21 AS builder
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
FROM node:25-alpine3.21 AS migrate-deps
WORKDIR /app

RUN apk upgrade --no-cache
COPY package-lock.json ./
RUN node -e " \
  const lock = JSON.parse(require('fs').readFileSync('package-lock.json', 'utf8')); \
  const v = (name) => lock.packages['node_modules/' + name].version; \
  const pkg = { \
    private: true, \
    dependencies: { prisma: v('prisma'), dotenv: v('dotenv') }, \
    overrides: { \
      '@hono/node-server': '^1.19.13', \
      'hono': '^4.12.12', \
      'picomatch': '^4.0.4', \
      'brace-expansion': '^5.0.5' \
    } \
  }; \
  require('fs').writeFileSync('package.json', JSON.stringify(pkg)); \
" && npm install --legacy-peer-deps && npm install pg

# ── Stage 4: runner ───────────────────────────────────────────────────────────
FROM node:25-alpine3.21 AS runner
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

ENTRYPOINT ["./docker-entrypoint.sh"]
