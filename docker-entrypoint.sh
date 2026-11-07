#!/bin/sh
set -e

# Boot phase: a stop request (docker stop → SIGTERM, forwarded by tini) ends
# boot at the next step instead of carrying on into db push and the server
# start. sh runs a trap only once the foreground command returns, so a step
# already running (db push, a pre-upgrade dump) finishes first — this script
# never cuts one off. The run-phase trap near the end replaces these.
trap 'echo "[entrypoint] Stop requested during boot — exiting."; exit 143' TERM
trap 'echo "[entrypoint] Stop requested during boot — exiting."; exit 130' INT

# Prefer Docker secret file over env var so CRON_SECRET doesn't appear in docker inspect output.
if [ -f /run/secrets/cron_secret ]; then
  CRON_SECRET=$(cat /run/secrets/cron_secret) || { echo "[entrypoint] ERROR: failed to read cron_secret"; exit 1; }
  [ -z "$CRON_SECRET" ] && { echo "[entrypoint] ERROR: cron_secret file is empty"; exit 1; }
  export CRON_SECRET
fi

# Same for the database password: it ends up in DATABASE_URL and PGPASSWORD, so
# the env var shows in docker inspect. The postgres sidecar reads the same file
# as POSTGRES_PASSWORD_FILE. scripts/*.mjs read it too — a `docker compose exec`
# shell never inherits this export.
if [ -f /run/secrets/postgres_password ]; then
  POSTGRES_PASSWORD=$(cat /run/secrets/postgres_password) || { echo "[entrypoint] ERROR: failed to read postgres_password"; exit 1; }
  [ -z "$POSTGRES_PASSWORD" ] && { echo "[entrypoint] ERROR: postgres_password file is empty"; exit 1; }
  export POSTGRES_PASSWORD
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

# Digits-only, no leading zero, or the supplied default. The interval knobs are
# free-form env vars (SYNC_INTERVAL, RATINGS_SYNC_INTERVAL, CRON_RETRY_INTERVAL,
# SUMMONARR_DB_WAIT_SECONDS, …); a typo like "1h" or "3600s" makes $(( ))
# arithmetic a fatal shell error, and with `set -e` that kills a cron loop
# subshell for the container's lifetime — every cron silently stops while the
# healthcheck keeps reporting healthy. A plain digits-only check isn't enough on
# its own: shell arithmetic treats a leading zero as OCTAL, so "009"/"018"
# (all-digits, but invalid octal since octal digits stop at 7) hits the exact
# same fatal $(( )) error, and "010" doesn't error but silently becomes decimal
# 8. Reject any all-digit value that isn't exactly "0" or free of a leading zero.
_cron_int() {
  case "$1" in
    ''|*[!0-9]*) echo "$2" ;;
    0|[1-9]*)    echo "$1" ;;
    *)           echo "$2" ;; # all-digits but leading-zero (e.g. "009") — octal-ambiguous
  esac
}

# ── Wait for Postgres (bounded) ───────────────────────────────────────────────
# compose's `depends_on: service_healthy` holds back only `docker compose up`;
# when the daemon restarts both containers after a host reboot they start
# together. Without a wait, every step below runs against a database that is
# still starting: the opt-in dump reads it as "skip" (so the upgrade can run
# without one), db push exits, and the container restart-loops.
# SUMMONARR_DB_WAIT_SECONDS (default 60) bounds the wait; on timeout boot
# carries on and db push fails loudly as it always did. "Up" means Postgres
# ANSWERED — a wrong password or a missing database ends the wait too, and db
# push then reports it. Same host, user and database as DATABASE_URL above.
_db_wait=$(_cron_int "${SUMMONARR_DB_WAIT_SECONDS:-60}" 60)
_db_deadline=$(( $(date +%s) + _db_wait ))
_db_waiting=""
while :; do
  node --input-type=module <<'DBWAIT_EOF' && break
// Exit 0 = go on (connected, Postgres answered with an error, or no way to
// probe); 1 = not answering yet. A server error carries `severity`; 57P03 is
// Postgres saying it is still starting up or recovering.
let code = 0;
let client;
try {
  const { default: { Client } } = await import('pg');
  client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('SELECT 1');
  await client.end();
} catch (err) {
  if (client && (typeof err?.severity !== 'string' || err.code === '57P03')) code = 1;
}
process.exit(code);
DBWAIT_EOF
  if [ "$(date +%s)" -ge "$_db_deadline" ]; then
    echo "[entrypoint] WARNING: the database did not answer within ${_db_wait}s — continuing boot."
    break
  fi
  if [ -z "$_db_waiting" ]; then
    echo "Waiting for the database..."
    _db_waiting=1
  fi
  sleep 2
done

# ── Pre-upgrade safety dump (opt-in, best-effort) ─────────────────────────────
# `prisma db push` below is the ONLY upgrade mechanism: no migration history, no
# rollback. When SUMMONARR_PRE_UPGRADE_DUMP_DIR names a writable directory (mount
# a volume there — /data is NOT a volume by default) and a push is about to
# change the schema, take a pg_dump first so a bad upgrade can be rolled back
# (docker-container/README.md → "Rolling back an upgrade").
#
#   SUMMONARR_PRE_UPGRADE_DUMP_DIR      unset/empty = OFF (the default)
#   SUMMONARR_PRE_UPGRADE_DUMP_KEEP     newest dumps to keep (default 3)
#   SUMMONARR_PRE_UPGRADE_DUMP_TIMEOUT  seconds before the dump is abandoned (default 900)
#
# "A push is about to change the schema" = `prisma migrate diff` (live DB →
# schema.prisma) has statements other than the TmdbCache_key_idx drop/create
# pair, which Prisma reports on EVERY run (the text_pattern_ops index never
# round-trips through introspection) and which `db push` itself ignores. A fresh
# database (no "User" table) has nothing to protect and is skipped.
#
# NEVER blocks boot: every failure is a warning and the function returns 0.
_pre_upgrade_dump() {
  _dir="${SUMMONARR_PRE_UPGRADE_DUMP_DIR:-}"
  [ -z "$_dir" ] && return 0
  if ! command -v pg_dump >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: SUMMONARR_PRE_UPGRADE_DUMP_DIR is set but pg_dump/psql are not in this image — no pre-upgrade dump taken."
    return 0
  fi
  if [ ! -d "$_dir" ] || [ ! -w "$_dir" ]; then
    echo "[entrypoint] WARNING: SUMMONARR_PRE_UPGRADE_DUMP_DIR=$_dir is not a writable directory — no pre-upgrade dump taken."
    return 0
  fi
  # A dump cut off by a stop or a crash leaves its .partial behind, and the
  # retention below only counts finished dumps — so clear those here.
  rm -f "$_dir"/summonarr-pre-upgrade-*.dump.partial 2>/dev/null || true
  _keep="${SUMMONARR_PRE_UPGRADE_DUMP_KEEP:-3}"
  case "$_keep" in ''|*[!0-9]*) _keep=3 ;; esac
  [ "$_keep" -lt 1 ] && _keep=1
  _tmo="${SUMMONARR_PRE_UPGRADE_DUMP_TIMEOUT:-900}"
  case "$_tmo" in ''|*[!0-9]*) _tmo=900 ;; esac
  [ "$_tmo" -lt 1 ] && _tmo=900

  _has_user=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U summonarr -d summonarr -tAqc "SELECT to_regclass('\"User\"') IS NOT NULL" 2>/dev/null) || _has_user=""
  if [ "$_has_user" = "f" ]; then
    return 0
  elif [ "$_has_user" != "t" ]; then
    echo "[entrypoint] WARNING: pre-upgrade dump skipped — could not query the database."
    return 0
  fi

  _diff=$(node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>/dev/null) || {
    echo "[entrypoint] WARNING: pre-upgrade dump skipped — could not compute the schema diff."
    return 0
  }
  _pending=$(printf '%s\n' "$_diff" | grep -v '^--' | grep -v '^[[:space:]]*$' | grep -v 'TmdbCache_key_idx' || true)
  [ -z "$_pending" ] && return 0

  _stamp=$(date -u +%Y%m%dT%H%M%SZ)
  _out="$_dir/summonarr-pre-upgrade-$_stamp.dump"
  echo "[entrypoint] Schema changes pending — writing pre-upgrade dump to $_out"
  if (umask 077; PGPASSWORD="$POSTGRES_PASSWORD" timeout "$_tmo" pg_dump -h postgres -U summonarr -d summonarr -Fc -f "$_out.partial") 2>&1; then
    mv "$_out.partial" "$_out" || { rm -f "$_out.partial"; echo "[entrypoint] WARNING: could not finalize the pre-upgrade dump."; return 0; }
    echo "[entrypoint] Pre-upgrade dump written."
    # Newest first (names sort by UTC timestamp); drop everything past KEEP.
    ls -1 "$_dir"/summonarr-pre-upgrade-*.dump 2>/dev/null | sort -r | tail -n +$((_keep + 1)) | while IFS= read -r _old; do
      rm -f "$_old"
    done
  else
    rm -f "$_out.partial"
    echo "[entrypoint] WARNING: pre-upgrade dump FAILED (or timed out after ${_tmo}s) — continuing boot without it."
  fi
  return 0
}
_pre_upgrade_dump || echo "[entrypoint] WARNING: pre-upgrade dump step errored — continuing boot."

echo "Deduplicating PlayHistory before schema sync..."
node --input-type=module <<'DEDUP_EOF'
const { DATABASE_URL } = process.env;
// Remove duplicate PlayHistory rows that share the table's unique key (worked
// out below), keeping the most recently written one. Ordered by createdAt: `id` is a cuid2
// (random letter + hash), so it is NOT time-sortable and only breaks ties
// deterministically. Idempotent — safe to run every start.
// Skips cleanly on a fresh DB where the table hasn't been created yet.
//
// Best-effort by design: this runs BEFORE `prisma db push`, so a schema change
// that renames a referenced column would otherwise crash-loop the container
// (set -e) before db push can reconcile. Any failure logs a warning and boot
// continues — a missing pg module included, so the import sits inside the try.
let client;
try {
  const { default: { Client } } = await import('pg');
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const exists = await client.query(`SELECT to_regclass('"PlayHistory"') AS t`);
  if (exists.rows[0].t !== null) {
    // The partition MUST match PlayHistory's real unique key,
    // [source, serverInstance, sourceSessionId]. It used to be the 2-column
    // [source, sourceSessionId] — NARROWER than the constraint — so on a
    // multi-server install this deleted rows Postgres considers legitimately
    // distinct. recordCompletedSession depends on exactly that distinction
    // ("the same raw sessionKey on two instances can never collide", see
    // play-history.ts), so this ran on EVERY container boot and destroyed real
    // watch history, which the live poller is the sole writer of and cannot
    // rebuild.
    //
    // This runs BEFORE `prisma db push`, so a deployment upgrading from a
    // pre-multi-server schema has no such column yet. Detect rather than
    // assume: absent column ⇒ single-server data ⇒ the 2-column key is the
    // correct one for that database.
    const col = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'PlayHistory' AND column_name = 'serverInstance'
    `);
    const partition = col.rowCount > 0
      ? `source, "serverInstance", "sourceSessionId"`
      : `source, "sourceSessionId"`;
    const res = await client.query(`
      DELETE FROM "PlayHistory"
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY ${partition}
                   ORDER BY "createdAt" DESC, id DESC
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
  await client?.end().catch(() => {});
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
// continues — a missing pg module included, so the import sits inside the try.
let client;
try {
  const { default: { Client } } = await import('pg');
  client = new Client({ connectionString: DATABASE_URL });
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
  await client?.end().catch(() => {});
}
BACKFILL_EOF

echo "Backfilling arrInstance from the legacy is4k discriminator (multi-instance Radarr/Sonarr)..."
node --input-type=module <<'ARRINSTANCE_EOF'
const { DATABASE_URL } = process.env;
// Non-destructive migration for the is4k→arrInstance change (N named Radarr/Sonarr
// instances). Adds the `arrInstance` column (matching the schema default) and
// backfills it from the legacy `is4k` boolean (false→'', true→'4k') on the six
// affected tables, so the subsequent `prisma db push` only has to swap the
// PK/unique keys onto an already-populated column — which lands as the entrypoint's
// auto-safe "unique constraint" / "primary key will be changed" warnings, never a
// destructive column drop (is4k is RETAINED in the schema, deprecated).
//
// Idempotent — ADD COLUMN IF NOT EXISTS + a WHERE that skips already-backfilled
// rows. Best-effort: runs BEFORE db push and continues boot on failure (a real
// key collision then fails db push loudly, leaving the DB untouched — never a
// silent merge of 4K into the default instance). Skips cleanly on a fresh DB.
const TABLES = [
  "MediaRequest", "RadarrWantedItem", "RadarrAvailableItem",
  "SonarrWantedItem", "SonarrAvailableItem", "TrashApplication",
];
let client;
try {
  const { default: { Client } } = await import('pg');
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  for (const table of TABLES) {
    const t = await client.query(`SELECT to_regclass('"${table}"') AS t`);
    if (t.rows[0].t === null) continue; // fresh DB — db push will create it
    // Only migrate while the legacy column is still present; once a future release
    // drops is4k this whole block is a no-op.
    const hasIs4k = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'is4k'`,
      [table],
    );
    if (hasIs4k.rowCount === 0) continue;
    await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "arrInstance" TEXT NOT NULL DEFAULT ''`);
    const res = await client.query(
      `UPDATE "${table}" SET "arrInstance" = '4k' WHERE "is4k" = true AND "arrInstance" = ''`,
    );
    if (res.rowCount > 0) console.log(`[entrypoint] ${table}: backfilled ${res.rowCount} row(s) to arrInstance='4k'.`);
  }
} catch (err) {
  console.error(`[entrypoint] arrInstance backfill failed — continuing boot: ${err?.message ?? err}`);
} finally {
  await client?.end().catch(() => {});
}
ARRINSTANCE_EOF

echo "Adding serverInstance for multi-server Plex/Jellyfin support..."
node --input-type=module <<'MEDIAINSTANCE_EOF'
const { DATABASE_URL } = process.env;
// Non-destructive additive migration for multi-server Plex/Jellyfin support.
// Adds the `serverInstance` column (matching the schema default "") to every
// affected table so the subsequent `prisma db push` only has to swap the
// PK/unique keys onto an already-populated column — the entrypoint's auto-safe
// "unique constraint" / "primary key will be changed" warnings, never a
// destructive drop. Unlike the is4k→arrInstance migration there is no legacy
// discriminator to interpret — every existing row unambiguously belongs to the
// single server that existed before this feature, so a plain ADD COLUMN with
// its default is the whole migration (no UPDATE backfill pass needed).
//
// Idempotent — ADD COLUMN IF NOT EXISTS. Best-effort: runs BEFORE db push and
// continues boot on failure (a real key collision then fails db push loudly,
// leaving the DB untouched). Skips cleanly on a fresh DB.
const TABLES = [
  "PlexLibraryItem", "JellyfinLibraryItem", "MediaServerUser",
  "PlayHistory", "ActiveSession",
];
let client;
try {
  const { default: { Client } } = await import('pg');
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  for (const table of TABLES) {
    const t = await client.query(`SELECT to_regclass('"${table}"') AS t`);
    if (t.rows[0].t === null) continue; // fresh DB — db push will create it
    const hasServerInstance = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'serverInstance'`,
      [table],
    );
    if (hasServerInstance.rowCount > 0) continue; // already migrated
    await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "serverInstance" TEXT NOT NULL DEFAULT ''`);
    console.log(`[entrypoint] ${table}: added serverInstance column (default server, backward-compatible).`);
  }
} catch (err) {
  console.error(`[entrypoint] serverInstance backfill failed — continuing boot: ${err?.message ?? err}`);
} finally {
  await client?.end().catch(() => {});
}
MEDIAINSTANCE_EOF

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
  echo "[entrypoint] WARNING: SUMMONARR_ACCEPT_DATA_LOSS=true is set — EVERY boot applies schema changes with --accept-data-loss, including column and table drops. Unset it once this boot succeeds."
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
    # Extract every "•"-prefixed warning line. `|| true`: if a future Prisma
    # changes the bullet glyph, grep exits 1 and set -e would abort here with no
    # message — an empty $warnings instead routes to the explicit not-auto-safe
    # branch below (still fail-closed, but with the operator-facing explanation).
    warnings=$(echo "$push_output" | grep -E "^[[:space:]]*•" || true)
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
# The call is made from a small Node script (not curl) so the secret travels in
# an env var and never appears in the process list.
# Exits non-zero when the call did not succeed (non-2xx or the request threw) so
# the scheduler can hold the job for a short retry instead of waiting a full interval.
# NOTE: node:http, NOT fetch — deliberately.
#
# `fetch` is undici, whose default `headersTimeout` is 300s. Response headers
# are not sent until the route handler RETURNS, so any cron job that runs
# longer than five minutes made fetch throw. _cron_next then scored the job as
# failed and rescheduled it at CRON_RETRY_INTERVAL (300s) instead of its real
# interval — so a full library sync that legitimately takes >5min on a large
# library could never report success, and the hourly sync silently became a
# permanent every-5-minutes full library delete-and-repopulate loop.
#
# A per-request AbortSignal cannot fix this: headersTimeout is a dispatcher
# setting, and raising it needs undici's Agent, which is not importable from
# the runtime image. node:http imposes no implicit cap, so the deadline is
# explicit and generous here.
#
# The default (2100s = 35min) sits just ABOVE the orchestrator's own bound
# (advisory-lock DEFAULT_WORK_TIMEOUT_MS = 30min) so the SERVER decides when a
# run has gone wrong — it aborts, returns non-2xx, and the retry is then a real
# retry. Override with CRON_CALL_TIMEOUT (seconds).
_cron_sync() {
  SYNC_CALL_URL="$1" SYNC_CALL_LABEL="$2" SYNC_CALL_QUIET="${3:-}" \
  SYNC_CALL_TIMEOUT_MS="$(( $(_cron_int "${CRON_CALL_TIMEOUT:-2100}" 2100) * 1000 ))" \
    node --input-type=module <<'JSEOF'
import http from 'node:http';
const {
  SYNC_CALL_URL: url,
  SYNC_CALL_LABEL: label,
  CRON_SECRET,
  SYNC_CALL_QUIET: quiet,
  SYNC_CALL_TIMEOUT_MS: timeoutRaw,
} = process.env;
const timeoutMs = Number(timeoutRaw) > 0 ? Number(timeoutRaw) : 2100000;
try {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { Authorization: `Bearer ${CRON_SECRET}` } },
      (res) => {
        res.resume();                                   // drain and discard the body
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      },
    );
    // Inactivity timeout. These endpoints send nothing until the handler
    // returns, so for this caller inactivity is the same as total elapsed.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`no response after ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', reject);
    req.end();
  });
  if (status < 200 || status >= 300) {
    console.log(`[${label} failed: ${status}]`);
    process.exit(1);
  }
  if (!quiet) console.log(`[${label} ok]`);
} catch (e) {
  console.log(`[${label} failed: ${e.message}]`);
  process.exit(1);
}
JSEOF
}

# Internal loopback base for every cron POST. Honours PORT exactly like the
# readiness probe below and the Dockerfile HEALTHCHECK already do — the URLs
# hardcoded :3000, so running with a custom PORT pointed every cron at a
# dead port while both health probes kept reporting healthy.
CRON_BASE="http://localhost:${PORT:-3000}${BASE_PATH}"

# Compute the next-run timestamp for a job: full interval on success, a short
# retry window on failure so a transient outage doesn't skip the job for an
# entire (possibly 24h) interval.
#
# $4 is the JOB'S OWN default and every caller must pass it (_cron_loop passes
# the schedule table's). A single hardcoded fallback here would substitute an
# hour for a set-but-invalid value ("86400s", "1d", "086400"), so a daily job
# would silently reschedule itself 24x/day.
_cron_next() {
  _exit="$1"; _now="$2"; _interval=$(_cron_int "$3" "${4:-3600}")
  if [ "$_exit" -eq 0 ]; then
    echo $((_now + _interval))
  else
    _retry=$(_cron_int "${CRON_RETRY_INTERVAL:-300}" 300)
    [ "$_retry" -gt "$_interval" ] && _retry="$_interval"
    echo $((_now + _retry))
  fi
}

# The schedule: one row per job, and the only place a job's interval default
# and first run live — the banner below is built from it.
#
#   label|URL override var|path under CRON_BASE|interval var|default (s)|quiet|first run (s)|loop
#
#   label      names the job in its log lines ("[sync ok]").
#   quiet      "quiet" logs failures only: the job runs often, or is a no-op
#              until its feature is on or configured.
#   first run  seconds after start. Staggered so the jobs don't all hit the
#              app at once; a loop also sleeps 60s before its first tick.
#   loop       "main" runs the long jobs (full sync, warm-ups) one after
#              another. "fast" holds the short-cadence jobs, so a full sync or a
#              warm-up that runs for many minutes (a call may wait up to
#              CRON_CALL_TIMEOUT) doesn't hold them back. Not one loop per job:
#              the app's database pool is five connections, and the server's
#              advisory locks already stop a job overlapping itself.
#
# Keep the defaults in step with docker-container/docker-compose.yml and the
# Settings page (tests/entrypoint.test.mts checks both).
_CRON_JOBS='
sync|SYNC_URL|/api/sync|SYNC_INTERVAL|3600||0|main
upcoming|UPCOMING_SYNC_URL|/api/sync/upcoming|UPCOMING_SYNC_INTERVAL|86400||120|main
ratings|RATINGS_SYNC_URL|/api/sync/ratings|RATINGS_SYNC_INTERVAL|86400||180|main
purge-sessions|PURGE_SESSIONS_URL|/api/cron/purge-auth-sessions|PURGE_SESSIONS_INTERVAL|86400||600|main
purge-notifications|PURGE_NOTIFICATIONS_URL|/api/cron/purge-notifications|PURGE_NOTIFICATIONS_INTERVAL|86400||840|main
warm-list-cache|LIST_CACHE_SYNC_URL|/api/cron/warm-list-cache|LIST_CACHE_SYNC_INTERVAL|21600||0|main
warm-activity|WARM_ACTIVITY_URL|/api/cron/warm-activity|WARM_ACTIVITY_INTERVAL|1800|quiet|0|main
warm-mdblist|WARM_MDBLIST_URL|/api/cron/warm-mdblist|WARM_MDBLIST_INTERVAL|86400||240|main
warm-omdb|WARM_OMDB_URL|/api/cron/warm-omdb|WARM_OMDB_INTERVAL|86400||300|main
warm-recommendations|WARM_RECOMMENDATIONS_URL|/api/cron/warm-recommendations|WARM_RECOMMENDATIONS_INTERVAL|43200||480|main
warm-library|WARM_LIBRARY_URL|/api/cron/warm-library|WARM_LIBRARY_INTERVAL|86400||720|main
scrub-audit-pii|SCRUB_AUDIT_PII_URL|/api/cron/scrub-audit-pii|SCRUB_AUDIT_PII_INTERVAL|86400|quiet|900|main
trash-sync|TRASH_SYNC_URL|/api/cron/trash-sync|TRASH_SYNC_INTERVAL|86400||360|main
sync-plex-watchlists|PLEX_WATCHLIST_SYNC_URL|/api/cron/sync-plex-watchlists|PLEX_WATCHLIST_SYNC_INTERVAL|1800|quiet|420|main
sync-trakt|TRAKT_SYNC_URL|/api/cron/sync-trakt|TRAKT_SYNC_INTERVAL|1800|quiet|540|main
refresh-upstream-watch|UPSTREAM_WATCH_SYNC_URL|/api/cron/refresh-upstream-watch|UPSTREAM_WATCH_SYNC_INTERVAL|86400|quiet|1020|main
watch-sync|WATCH_SYNC_URL|/api/cron/watch-sync|WATCH_SYNC_INTERVAL|300|quiet|780|fast
arr-watch|ARR_WATCH_URL|/api/cron/arr-watch|ARR_WATCH_INTERVAL|900|quiet|660|fast
arr-snapshots|ARR_SNAPSHOT_URL|/api/cron/refresh-arr-snapshots|ARR_SNAPSHOT_INTERVAL|300|quiet|300|fast
'

# "Cron started." plus each job's interval as _cron_next will actually use it.
# It used to echo the raw env value, so SYNC_INTERVAL=1h printed "1hs" while the
# job ran hourly on its default; a value _cron_int can't use now gets a warning.
_cron_banner() {
  _banner="Cron started."
  while IFS='|' read -r _label _urlvar _path _ivar _def _quiet _delay _loop; do
    [ -n "$_label" ] || continue
    eval "_raw=\${${_ivar}:-}"
    _used=$(_cron_int "$_raw" "$_def")
    if [ -n "$_raw" ] && [ "$_raw" != "$_used" ]; then
      echo "[entrypoint] WARNING: ${_ivar}=${_raw} is not a whole number of seconds — using ${_used}."
    fi
    _banner="$_banner  $_label: ${_used}s"
  done <<EOF
$_CRON_JOBS
EOF
  echo "$_banner"
}

# One scheduler loop: every 60s, run the jobs of loop $1 that are due, one after
# another. A job's next run is kept in _next_<its interval var>. Each call is
# `&& rc=0 || rc=$?` so a failed job never trips set -e and kills the loop.
_cron_loop() {
  _this_loop="$1"
  _start=$(date +%s)
  while IFS='|' read -r _label _urlvar _path _ivar _def _quiet _delay _loop; do
    [ "$_loop" = "$_this_loop" ] || continue
    eval "_next_${_ivar}=\$((_start + _delay))"
  done <<EOF
$_CRON_JOBS
EOF
  while true; do
    sleep 60
    NOW=$(date +%s)
    while IFS='|' read -r _label _urlvar _path _ivar _def _quiet _delay _loop; do
      [ "$_loop" = "$_this_loop" ] || continue
      eval "_due=\$_next_${_ivar}"
      [ "$NOW" -ge "$_due" ] || continue
      eval "_url=\${${_urlvar}:-\${CRON_BASE}\${_path}}"
      eval "_raw=\${${_ivar}:-}"
      _cron_sync "$_url" "$_label" "$_quiet" && rc=0 || rc=$?
      eval "_next_${_ivar}=\$(_cron_next \"\$rc\" \"\$NOW\" \"\$_raw\" \"\$_def\")"
    done <<EOF
$_CRON_JOBS
EOF
  done
}

# Separate fast loop for play history — every PLAY_HISTORY_SYNC_INTERVAL (5s by
# default) for granular tracking, decoupled from the cron loops' 60s tick.
#
# ONE long-lived node process polls. A node per poll (as _cron_sync starts) was
# ~17k process starts a day at the 5s default — constant CPU and memory churn on
# a small host. It stays strictly serial (POST, wait for the answer, then sleep
# the interval): play-history.ts relies on ticks never overlapping. A failed poll
# (a routine 500/429, or no answer) is logged and polling carries on; if node
# itself dies, the loop below starts a new one. CRON_SECRET reaches it through
# the environment only, never argv.
#
# Why the readiness check instead of a flat sleep: every poll cycle bumps
# ActiveSession.lastSeenAt; every cycle missed during boot ages it toward the
# SESSION_ABSENCE_GRACE_MS=60s threshold. With the previous blind `sleep 30`,
# a sub-30s redeploy left lastSeenAt 30-45s old by the time the first poll
# fired — close enough to the grace threshold that bootstrapReconcile (which
# fires as a side-effect of that first poll triggering reconcilePlexEventStream)
# could finalize the in-progress session as stale, ledger-lock the sessionKey,
# and make the Now Playing card permanently disappear from the user's view.
# Poll /api/health (unauthenticated, no DB hit) and start polling within ~1s of
# Node becoming reachable; after 60s, poll anyway.
_play_history_loop() {
  # Routed through _cron_int like every other interval knob (see its comment): a
  # bad value must not stop play-history/Now Playing polling. At least 1s — "0"
  # would poll the server back to back.
  INTERVAL=$(_cron_int "${PLAY_HISTORY_SYNC_INTERVAL:-5}" 5)
  if [ "$INTERVAL" -lt 1 ]; then INTERVAL=1; fi
  echo "Play history polling started (every ${INTERVAL}s)"

  while true; do
    PH_URL="${PLAY_HISTORY_SYNC_URL:-${CRON_BASE}/api/sync/play-history}" \
    PH_HEALTH_URL="http://127.0.0.1:${PORT:-3000}${BASE_PATH}/api/health" \
    PH_INTERVAL_MS="$((INTERVAL * 1000))" \
    PH_TIMEOUT_MS="$(( $(_cron_int "${CRON_CALL_TIMEOUT:-2100}" 2100) * 1000 ))" \
      node --input-type=module <<'JSEOF' || true
import http from 'node:http';
const { PH_URL: url, PH_HEALTH_URL: healthUrl, CRON_SECRET } = process.env;
const intervalMs = Math.max(1000, Number(process.env.PH_INTERVAL_MS) || 5000);
const timeoutMs = Number(process.env.PH_TIMEOUT_MS) > 0 ? Number(process.env.PH_TIMEOUT_MS) : 2100000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const start = Date.now();
let ready = false;
while (!ready && Date.now() - start < 60_000) {
  try {
    const r = await fetch(healthUrl);
    ready = r.ok;
    await r.arrayBuffer();
  } catch {}
  if (!ready) await sleep(500);
}
if (!ready) console.warn('[entrypoint] play-history readiness probe timed out after 60s; starting poll loop anyway');

// node:http for the reason _cron_sync gives. agent: false is a fresh connection
// per poll, as when every poll was its own process: a kept-alive socket would
// race the server's own 5s keep-alive timeout at this interval.
const poll = () => new Promise((resolve, reject) => {
  const req = http.request(
    url,
    { method: 'POST', agent: false, headers: { Authorization: `Bearer ${CRON_SECRET}` } },
    (res) => {
      res.resume();                                   // drain and discard the body
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    },
  );
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error(`no response after ${Math.round(timeoutMs / 1000)}s`));
  });
  req.on('error', reject);
  req.end();
});

for (;;) {
  try {
    const status = await poll();
    if (status < 200 || status >= 300) console.log(`[play-history failed: ${status}]`);
  } catch (e) {
    console.log(`[play-history failed: ${e?.message ?? e}]`);
  }
  await sleep(intervalMs);
}
JSEOF
    # Only reached if node itself died; start a fresh poller after a pause.
    sleep "$INTERVAL"
  done
}

_cron_banner

_cron_loop main &
CRON_PID=$!

_cron_loop fast &
FAST_PID=$!

_play_history_loop &
PH_PID=$!

node server.js &
NODE_PID=$!

# Run phase: forward SIGTERM/SIGINT so Docker can stop the container cleanly.
# `|| true`: kill fails when a loop has already died, and under set -e a failed
# command in a trap would end this script while node is still draining.
trap "kill $NODE_PID $CRON_PID $FAST_PID $PH_PID 2>/dev/null || true" TERM INT

# POSIX: a trapped signal received during `wait` makes it return IMMEDIATELY
# after the trap runs — it does not resume. A single bare `wait $NODE_PID`
# would therefore let this script exit while node is still draining its
# shutdown, and Docker tears the container down (SIGKILL) mid-drain. Re-wait
# until node has actually exited; `kill -0` probes liveness (fails once a wait
# reaped it).
#
# The container exits with node's own status. A trap-interrupted wait returns
# >128 while node is still alive, so rc is re-read on every pass and node's real
# exit, read last, wins. `&& … || …` keeps set -e from aborting on it, and the
# loop cleanup below can't replace it either.
rc=0
while :; do
  wait "$NODE_PID" && rc=0 || rc=$?
  kill -0 "$NODE_PID" 2>/dev/null || break
done
kill "$CRON_PID" "$FAST_PID" "$PH_PID" 2>/dev/null || true
wait "$CRON_PID" 2>/dev/null || true
wait "$FAST_PID" 2>/dev/null || true
wait "$PH_PID" 2>/dev/null || true
exit "$rc"
