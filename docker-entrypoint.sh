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

echo "Backfilling PlayHistory.playDuration where playhead-as-playtime over-inflated rows..."
node --input-type=module <<'BACKFILL_EOF'
const { DATABASE_URL } = process.env;
// One-shot best-effort fix for rows written before ActiveSession.playtimeMs landed.
// Pre-fix `playDuration` stored the playhead position at session end — so a user who
// scrubbed to the credits looked like they watched the whole runtime. New rows store
// accumulated wall-clock seconds in the "playing" state.
//
// Clamp to wall-clock elapsed: a session physically cannot have played longer than
// (stoppedAt - startedAt). Recomputes `watched` and `pausedDuration` from the clamp.
//
// Idempotent — the WHERE filters out rows that don't need clamping, so re-runs are no-ops.
// Skips cleanly on a fresh DB.
const { default: { Client } } = await import('pg');
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
const exists = await client.query(`SELECT to_regclass('"PlayHistory"') AS t`);
if (exists.rows[0].t === null) {
  await client.end();
  process.exit(0);
}
let threshold = 80;
try {
  const t = await client.query(
    `SELECT value FROM "Setting" WHERE key = 'playHistoryWatchedThreshold'`
  );
  const parsed = t.rows[0]?.value ? parseInt(t.rows[0].value, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) threshold = parsed;
} catch { /* Setting table absent on fresh DB — fall back to 80 */ }
const res = await client.query(
  `UPDATE "PlayHistory" SET
     "playDuration"   = LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int),
     "pausedDuration" = GREATEST(
       0,
       EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
         - LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)
     ),
     "watched" = CASE
       WHEN duration > 0
       THEN (LEAST("playDuration", EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int)::float / duration::float * 100) >= $1
       ELSE false
     END
   WHERE "playDuration" > EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt"))::int
     AND "stoppedAt" > "startedAt"`,
  [threshold],
);
if (res.rowCount > 0) console.log(`Clamped ${res.rowCount} PlayHistory row(s) at threshold=${threshold}.`);
await client.end();
BACKFILL_EOF

echo "Syncing database schema..."
# Schema migration policy:
#   1. Try `prisma db push` first. If it succeeds, done.
#   2. If it fails because Prisma flagged data-loss warnings, inspect them.
#      Three warning shapes are SAFE to auto-retry because the underlying
#      Postgres operation is atomic — a real conflict fails loudly at SQL
#      execution time, leaving the database untouched. Auto-retrying with
#      --accept-data-loss therefore can't silently destroy data here:
#
#        a) "unique constraint covering the columns [...]" — ALTER TABLE
#           ADD UNIQUE fails with 23505 if duplicates exist. (Prisma flags
#           this whenever ANY rows are present, even on an all-NULL new
#           column.)
#        b) "cast from `Text` to `VarChar(N)`" — ALTER COLUMN ... TYPE
#           varchar(N) fails with 22001 (value too long) if any row
#           exceeds N. No silent truncation.
#        c) "primary key for the `X` table will be changed" — fires as a
#           side-effect when a PK column gets a varchar narrowing (Postgres
#           rebuilds the PK index in the same transaction). When the only
#           other warnings are (a) and (b), this is a cascade, not a
#           standalone destructive change.
#
#      Anything else (column drop, table drop, enum value removal, etc.)
#      is genuinely destructive. Refuse and require SUMMONARR_ACCEPT_DATA_LOSS=true.
#   3. If SUMMONARR_ACCEPT_DATA_LOSS=true is set, skip the inspection and
#      apply with --accept-data-loss directly (operator-acknowledged override).

if [ "${SUMMONARR_ACCEPT_DATA_LOSS:-}" = "true" ]; then
  echo "[entrypoint] SUMMONARR_ACCEPT_DATA_LOSS=true — applying with --accept-data-loss."
  echo "[entrypoint] Unset this env var after the boot succeeds; leaving it on hides destructive changes."
  node node_modules/prisma/build/index.js db push --accept-data-loss
else
  # Disable set -e around the capture: under POSIX `sh -e`, $(...) failures
  # propagate and exit before $? can be read.
  set +e
  push_output=$(node node_modules/prisma/build/index.js db push 2>&1)
  push_exit=$?
  set -e
  echo "$push_output"

  if [ "$push_exit" -ne 0 ] && echo "$push_output" | grep -q -- "--accept-data-loss"; then
    # Extract every "•"-prefixed warning line.
    warnings=$(echo "$push_output" | grep -E "^[[:space:]]*•")
    # Strip the three auto-safe warning patterns. Anything left over is genuinely destructive.
    unsafe=$(echo "$warnings" \
      | grep -v "unique constraint covering the columns" \
      | grep -v "will be cast from .Text. to .VarChar" \
      | grep -v "primary key for the .* table will be changed" \
      || true)

    if [ -n "$warnings" ] && [ -z "$unsafe" ]; then
      echo ""
      echo "[entrypoint] All data-loss warnings are atomic Postgres operations (unique-constraint adds,"
      echo "[entrypoint] text→varchar narrowing casts, or PK rebuilds cascading from those casts) —"
      echo "[entrypoint] any real conflict would fail loudly with 23505 / 22001 and leave the DB"
      echo "[entrypoint] unchanged. Auto-retrying with --accept-data-loss."
      node node_modules/prisma/build/index.js db push --accept-data-loss
    else
      echo ""
      echo "[entrypoint] Schema sync failed with destructive warnings that are NOT auto-safe."
      echo "[entrypoint] Review the warnings above. To override for one boot, set"
      echo "[entrypoint] SUMMONARR_ACCEPT_DATA_LOSS=true in your env and restart."
      exit 1
    fi
  elif [ "$push_exit" -ne 0 ]; then
    # prisma db push failed for a non-data-loss reason (DB unreachable, etc).
    exit "$push_exit"
  fi
fi

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
  # Stagger Jellyfin history import well after startup so the library sync runs first
  JF_HISTORY_NEXT=$((NOW_INIT + 300))

  echo "Cron started. Sync: ${SYNC_INTERVAL:-3600}s  Upcoming: ${UPCOMING_SYNC_INTERVAL:-86400}s  Ratings: ${RATINGS_SYNC_INTERVAL:-86400}s  ListCache: ${LIST_CACHE_SYNC_INTERVAL:-21600}s  Activity: ${WARM_ACTIVITY_INTERVAL:-1800}s  MDBList: ${WARM_MDBLIST_INTERVAL:-86400}s  OMDB: ${WARM_OMDB_INTERVAL:-86400}s  ScrubPII: ${SCRUB_AUDIT_PII_INTERVAL:-86400}s  Trash: ${TRASH_SYNC_INTERVAL:-86400}s  JFHistory: ${JF_HISTORY_SYNC_INTERVAL:-86400}s"
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
    if [ "$NOW" -ge "$JF_HISTORY_NEXT" ]; then
      _cron_sync "${JF_HISTORY_SYNC_URL:-http://localhost:3000/api/cron/sync-jellyfin-history}" "jf-history"
      JF_HISTORY_NEXT=$((NOW + ${JF_HISTORY_SYNC_INTERVAL:-86400}))
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
