#!/bin/sh
set -e

# Prefer Docker secret file over env var so CRON_SECRET doesn't appear in docker inspect output.
if [ -f /run/secrets/cron_secret ]; then
  CRON_SECRET=$(cat /run/secrets/cron_secret) || { echo "[entrypoint] ERROR: failed to read cron_secret"; exit 1; }
  [ -z "$CRON_SECRET" ] && { echo "[entrypoint] ERROR: cron_secret file is empty"; exit 1; }
  export CRON_SECRET
fi

# URL-encode the password so special characters (/, +, =) from base64 don't break the URL
ENCODED_PASSWORD=$(node -e "process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))")
export DATABASE_URL="postgresql://summonarr:${ENCODED_PASSWORD}@postgres:5432/summonarr"

echo "Deduplicating PlayHistory before schema sync..."
node --input-type=module <<'DEDUP_EOF'
const { DATABASE_URL } = process.env;
// Remove duplicate PlayHistory rows with the same (source, sourceSessionId),
// keeping the highest id (latest write). Idempotent — safe to run every start.
// Skips cleanly on a fresh DB where the table hasn't been created yet.
const { default: { Client } } = await import('pg');
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
const exists = await client.query(`SELECT to_regclass('"PlayHistory"') AS t`);
if (exists.rows[0].t === null) {
  await client.end();
  process.exit(0);
}
const res = await client.query(`
  DELETE FROM "PlayHistory"
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY source, "sourceSessionId"
               ORDER BY id DESC
             ) AS rn
      FROM "PlayHistory"
      WHERE "sourceSessionId" IS NOT NULL
    ) t
    WHERE rn > 1
  )
`);
if (res.rowCount > 0) console.log(`Removed ${res.rowCount} duplicate PlayHistory row(s).`);
await client.end();
DEDUP_EOF

echo "Syncing database schema..."
# No --accept-data-loss: destructive migrations (dropped columns, narrowed
# types) will fail fast at boot instead of silently clobbering data. Apply
# those by hand with explicit intent when they come up.
node node_modules/prisma/build/index.js db push

echo "Starting Summonarr..."

# ── Background cron loop ───────────────────────────────────────────────────────
# Runs sync jobs inside this container so a separate cron container isn't needed.
# Uses Node's built-in fetch so the secret never appears in the process list.
_cron_sync() {
  SYNC_CALL_URL="$1" SYNC_CALL_LABEL="$2" SYNC_CALL_QUIET="${3:-}" \
    node --input-type=module <<'JSEOF'
const { SYNC_CALL_URL: url, SYNC_CALL_LABEL: label, CRON_SECRET, SYNC_CALL_QUIET: quiet } = process.env;
try {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  if (!r.ok) console.log(`[${label} failed: ${r.status}]`);
  else if (!quiet) console.log(`[${label} ok]`);
} catch (e) {
  console.log(`[${label} failed: ${e.message}]`);
}
JSEOF
}

_cron_loop() {
  # Jobs that should run on startup (warm caches for first visitors):
  SYNC_NEXT=0
  LIST_CACHE_NEXT=0
  WARM_ACTIVITY_NEXT=0

  # Jobs staggered to avoid startup stampede:
  NOW_INIT=$(date +%s)
  UPCOMING_NEXT=$((NOW_INIT + 120))
  RATINGS_NEXT=$((NOW_INIT + 180))
  WARM_MDBLIST_NEXT=$((NOW_INIT + 240))
  WARM_OMDB_NEXT=$((NOW_INIT + 300))
  PURGE_SESSIONS_NEXT=$((NOW_INIT + 600))
  SCRUB_AUDIT_PII_NEXT=$((NOW_INIT + 900))
  TRASH_SYNC_NEXT=$((NOW_INIT + 360))

  echo "Cron started. Sync: ${SYNC_INTERVAL:-3600}s  Upcoming: ${UPCOMING_SYNC_INTERVAL:-86400}s  Ratings: ${RATINGS_SYNC_INTERVAL:-86400}s  ListCache: ${LIST_CACHE_SYNC_INTERVAL:-21600}s  Activity: ${WARM_ACTIVITY_INTERVAL:-1800}s  MDBList: ${WARM_MDBLIST_INTERVAL:-86400}s  OMDB: ${WARM_OMDB_INTERVAL:-86400}s  ScrubPII: ${SCRUB_AUDIT_PII_INTERVAL:-86400}s  Trash: ${TRASH_SYNC_INTERVAL:-86400}s"
  while true; do
    sleep 60
    NOW=$(date +%s)
    if [ "$NOW" -ge "$SYNC_NEXT" ]; then
      _cron_sync "${SYNC_URL:-http://localhost:3000/api/sync}" "sync"
      SYNC_NEXT=$((NOW + ${SYNC_INTERVAL:-3600}))
    fi
    if [ "$NOW" -ge "$UPCOMING_NEXT" ]; then
      _cron_sync "${UPCOMING_SYNC_URL:-http://localhost:3000/api/sync/upcoming}" "upcoming"
      UPCOMING_NEXT=$((NOW + ${UPCOMING_SYNC_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$RATINGS_NEXT" ]; then
      _cron_sync "${RATINGS_SYNC_URL:-http://localhost:3000/api/sync/ratings}" "ratings"
      RATINGS_NEXT=$((NOW + ${RATINGS_SYNC_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$PURGE_SESSIONS_NEXT" ]; then
      _cron_sync "${PURGE_SESSIONS_URL:-http://localhost:3000/api/cron/purge-auth-sessions}" "purge-sessions"
      PURGE_SESSIONS_NEXT=$((NOW + ${PURGE_SESSIONS_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$LIST_CACHE_NEXT" ]; then
      _cron_sync "${LIST_CACHE_SYNC_URL:-http://localhost:3000/api/cron/warm-list-cache}" "warm-list-cache"
      LIST_CACHE_NEXT=$((NOW + ${LIST_CACHE_SYNC_INTERVAL:-21600}))
    fi
    if [ "$NOW" -ge "$WARM_ACTIVITY_NEXT" ]; then
      _cron_sync "${WARM_ACTIVITY_URL:-http://localhost:3000/api/cron/warm-activity}" "warm-activity" quiet
      WARM_ACTIVITY_NEXT=$((NOW + ${WARM_ACTIVITY_INTERVAL:-1800}))
    fi
    if [ "$NOW" -ge "$WARM_MDBLIST_NEXT" ]; then
      _cron_sync "${WARM_MDBLIST_URL:-http://localhost:3000/api/cron/warm-mdblist}" "warm-mdblist"
      WARM_MDBLIST_NEXT=$((NOW + ${WARM_MDBLIST_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$WARM_OMDB_NEXT" ]; then
      _cron_sync "${WARM_OMDB_URL:-http://localhost:3000/api/cron/warm-omdb}" "warm-omdb"
      WARM_OMDB_NEXT=$((NOW + ${WARM_OMDB_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$SCRUB_AUDIT_PII_NEXT" ]; then
      _cron_sync "${SCRUB_AUDIT_PII_URL:-http://localhost:3000/api/cron/scrub-audit-pii}" "scrub-audit-pii" quiet
      SCRUB_AUDIT_PII_NEXT=$((NOW + ${SCRUB_AUDIT_PII_INTERVAL:-86400}))
    fi
    if [ "$NOW" -ge "$TRASH_SYNC_NEXT" ]; then
      _cron_sync "${TRASH_SYNC_URL:-http://localhost:3000/api/cron/trash-sync}" "trash-sync"
      TRASH_SYNC_NEXT=$((NOW + ${TRASH_SYNC_INTERVAL:-86400}))
    fi
  done
}

# Separate fast loop for play history — runs every 10s by default for granular tracking.
# Decoupled from the main cron loop which ticks every 60s.
_play_history_loop() {
  INTERVAL=${PLAY_HISTORY_SYNC_INTERVAL:-5}
  echo "Play history polling started (every ${INTERVAL}s)"
  # Wait for node to start up
  sleep 30
  while true; do
    _cron_sync "${PLAY_HISTORY_SYNC_URL:-http://localhost:3000/api/sync/play-history}" "play-history" "1"
    sleep "$INTERVAL"
  done
}

_cron_loop &
CRON_PID=$!

_play_history_loop &
PH_PID=$!

node server.js &
NODE_PID=$!

# Forward SIGTERM/SIGINT so Docker can stop the container cleanly.
trap "kill $NODE_PID $CRON_PID $PH_PID 2>/dev/null" TERM INT

wait $NODE_PID
kill $CRON_PID $PH_PID 2>/dev/null
wait $CRON_PID 2>/dev/null
wait $PH_PID 2>/dev/null
