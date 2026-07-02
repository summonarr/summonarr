#!/bin/sh
set -e

# Prefer Docker secret file over env var so CRON_SECRET doesn't appear in docker inspect output.
if [ -f /run/secrets/cron_secret ]; then
  CRON_SECRET=$(cat /run/secrets/cron_secret) || { echo "[entrypoint] ERROR: failed to read cron_secret"; exit 1; }
  [ -z "$CRON_SECRET" ] && { echo "[entrypoint] ERROR: cron_secret file is empty"; exit 1; }
  export CRON_SECRET
fi

# Require a non-empty POSTGRES_PASSWORD before composing the connection string.
# Without this guard an unset value yields the literal "undefined" in the URL,
# turning a misconfiguration into a confusing wrong-password connect failure.
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[entrypoint] ERROR: POSTGRES_PASSWORD is not set."
  exit 1
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
//
// Best-effort by design: this runs BEFORE `prisma db push`, so a schema change
// that renames a referenced column would otherwise crash-loop the container
// (set -e) before db push can reconcile. Any failure logs a warning and boot
// continues.
const { default: { Client } } = await import('pg');
const client = new Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
  const exists = await client.query(`SELECT to_regclass('"PlayHistory"') AS t`);
  if (exists.rows[0].t !== null) {
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
  }
} catch (err) {
  console.error(`[entrypoint] PlayHistory dedup failed — continuing boot: ${err?.message ?? err}`);
} finally {
  await client.end().catch(() => {});
}
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
//
// Best-effort by design: this runs BEFORE `prisma db push`, so a schema change
// that renames a referenced column would otherwise crash-loop the container
// (set -e) before db push can reconcile. Any failure logs a warning and boot
// continues.
const { default: { Client } } = await import('pg');
const client = new Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
  const exists = await client.query(`SELECT to_regclass('"PlayHistory"') AS t`);
  if (exists.rows[0].t !== null) {
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
  }
} catch (err) {
  console.error(`[entrypoint] PlayHistory playDuration backfill failed — continuing boot: ${err?.message ?? err}`);
} finally {
  await client.end().catch(() => {});
}
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
# Exits non-zero when the call did not succeed (non-2xx or fetch threw) so the
# scheduler can hold the job for a short retry instead of waiting a full interval.
_cron_sync() {
  SYNC_CALL_URL="$1" SYNC_CALL_LABEL="$2" SYNC_CALL_QUIET="${3:-}" \
    node --input-type=module <<'JSEOF'
const { SYNC_CALL_URL: url, SYNC_CALL_LABEL: label, CRON_SECRET, SYNC_CALL_QUIET: quiet } = process.env;
try {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  if (!r.ok) {
    console.log(`[${label} failed: ${r.status}]`);
    process.exit(1);
  }
  if (!quiet) console.log(`[${label} ok]`);
} catch (e) {
  console.log(`[${label} failed: ${e.message}]`);
  process.exit(1);
}
JSEOF
}

# Compute the next-run timestamp for a job: full interval on success, a short
# retry window on failure so a transient outage doesn't skip the job for an
# entire (possibly 24h) interval.
_cron_next() {
  _exit="$1"; _now="$2"; _interval="$3"
  if [ "$_exit" -eq 0 ]; then
    echo $((_now + _interval))
  else
    _retry=${CRON_RETRY_INTERVAL:-300}
    [ "$_retry" -gt "$_interval" ] && _retry="$_interval"
    echo $((_now + _retry))
  fi
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
      _cron_sync "${SYNC_URL:-http://localhost:3000${BASE_PATH}/api/sync}" "sync" && rc=0 || rc=$?
      SYNC_NEXT=$(_cron_next "$rc" "$NOW" "${SYNC_INTERVAL:-3600}")
    fi
    if [ "$NOW" -ge "$UPCOMING_NEXT" ]; then
      _cron_sync "${UPCOMING_SYNC_URL:-http://localhost:3000${BASE_PATH}/api/sync/upcoming}" "upcoming" && rc=0 || rc=$?
      UPCOMING_NEXT=$(_cron_next "$rc" "$NOW" "${UPCOMING_SYNC_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$RATINGS_NEXT" ]; then
      _cron_sync "${RATINGS_SYNC_URL:-http://localhost:3000${BASE_PATH}/api/sync/ratings}" "ratings" && rc=0 || rc=$?
      RATINGS_NEXT=$(_cron_next "$rc" "$NOW" "${RATINGS_SYNC_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$PURGE_SESSIONS_NEXT" ]; then
      _cron_sync "${PURGE_SESSIONS_URL:-http://localhost:3000${BASE_PATH}/api/cron/purge-auth-sessions}" "purge-sessions" && rc=0 || rc=$?
      PURGE_SESSIONS_NEXT=$(_cron_next "$rc" "$NOW" "${PURGE_SESSIONS_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$LIST_CACHE_NEXT" ]; then
      _cron_sync "${LIST_CACHE_SYNC_URL:-http://localhost:3000${BASE_PATH}/api/cron/warm-list-cache}" "warm-list-cache" && rc=0 || rc=$?
      LIST_CACHE_NEXT=$(_cron_next "$rc" "$NOW" "${LIST_CACHE_SYNC_INTERVAL:-21600}")
    fi
    if [ "$NOW" -ge "$WARM_ACTIVITY_NEXT" ]; then
      _cron_sync "${WARM_ACTIVITY_URL:-http://localhost:3000${BASE_PATH}/api/cron/warm-activity}" "warm-activity" quiet && rc=0 || rc=$?
      WARM_ACTIVITY_NEXT=$(_cron_next "$rc" "$NOW" "${WARM_ACTIVITY_INTERVAL:-1800}")
    fi
    if [ "$NOW" -ge "$WARM_MDBLIST_NEXT" ]; then
      _cron_sync "${WARM_MDBLIST_URL:-http://localhost:3000${BASE_PATH}/api/cron/warm-mdblist}" "warm-mdblist" && rc=0 || rc=$?
      WARM_MDBLIST_NEXT=$(_cron_next "$rc" "$NOW" "${WARM_MDBLIST_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$WARM_OMDB_NEXT" ]; then
      _cron_sync "${WARM_OMDB_URL:-http://localhost:3000${BASE_PATH}/api/cron/warm-omdb}" "warm-omdb" && rc=0 || rc=$?
      WARM_OMDB_NEXT=$(_cron_next "$rc" "$NOW" "${WARM_OMDB_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$SCRUB_AUDIT_PII_NEXT" ]; then
      _cron_sync "${SCRUB_AUDIT_PII_URL:-http://localhost:3000${BASE_PATH}/api/cron/scrub-audit-pii}" "scrub-audit-pii" quiet && rc=0 || rc=$?
      SCRUB_AUDIT_PII_NEXT=$(_cron_next "$rc" "$NOW" "${SCRUB_AUDIT_PII_INTERVAL:-86400}")
    fi
    if [ "$NOW" -ge "$TRASH_SYNC_NEXT" ]; then
      _cron_sync "${TRASH_SYNC_URL:-http://localhost:3000${BASE_PATH}/api/cron/trash-sync}" "trash-sync" && rc=0 || rc=$?
      TRASH_SYNC_NEXT=$(_cron_next "$rc" "$NOW" "${TRASH_SYNC_INTERVAL:-86400}")
    fi
  done
}

# Separate fast loop for play history — runs every 5s by default for granular tracking.
# Decoupled from the main cron loop which ticks every 60s.
#
# Why the readiness check instead of a flat sleep: every poll cycle bumps
# ActiveSession.lastSeenAt; every cycle missed during boot ages it toward the
# SESSION_ABSENCE_GRACE_MS=60s threshold. With the previous blind `sleep 30`,
# a sub-30s redeploy left lastSeenAt 30-45s old by the time the first poll
# fired — close enough to the grace threshold that bootstrapReconcile (which
# fires as a side-effect of that first poll triggering reconcilePlexEventStream)
# could finalize the in-progress session as stale, ledger-lock the sessionKey,
# and make the Now Playing card permanently disappear from the user's view.
# Poll /api/health (unauthenticated, no DB hit) and proceed within ~1s of
# Node becoming reachable. 60s max is the same window the HEALTHCHECK
# start-period uses.
_play_history_loop() {
  INTERVAL=${PLAY_HISTORY_SYNC_INTERVAL:-5}
  echo "Play history polling started (every ${INTERVAL}s)"

  PORT_VALUE="${PORT:-3000}" BASE_PATH_VALUE="${BASE_PATH}" node --input-type=module <<'JSEOF'
const port = process.env.PORT_VALUE;
const url = `http://127.0.0.1:${port}${process.env.BASE_PATH_VALUE || ""}/api/health`;
const start = Date.now();
const MAX_MS = 60_000;
while (Date.now() - start < MAX_MS) {
  try {
    const r = await fetch(url);
    if (r.ok) process.exit(0);
  } catch {}
  await new Promise((res) => setTimeout(res, 500));
}
console.warn("[entrypoint] play-history readiness probe timed out after 60s; starting poll loop anyway");
process.exit(0);
JSEOF

  while true; do
    _cron_sync "${PLAY_HISTORY_SYNC_URL:-http://localhost:3000${BASE_PATH}/api/sync/play-history}" "play-history" "1"
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
