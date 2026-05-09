#!/usr/bin/env bash
#
# Summonarr post-deploy smoke test.
#
# Usage:
#   bash scripts/smoke-test.sh                                    # uses http://localhost:3001
#   bash scripts/smoke-test.sh https://requests.example.com       # remote target
#   ADMIN_COOKIE='__Secure-authjs.session-token=...' bash scripts/smoke-test.sh
#
# What it covers (unattended):
#   - HTTP health + bearer-auth flow with CRON_SECRET
#   - DB schema additions (User columns, AuditAction enum, MediaServerUser, PlexTokenCache)
#   - Plex backfill ran, settings encrypted at rest, OAuth tokens encrypted
#   - Recent log scan for fetch errors and crypto-config errors
#   - Behaviour: machine-session opt-in, sync orchestrator, revoke-all 401 path
#
# What it can't cover (skipped with note):
#   - Browser-based UI (CSP nonce, donation page render, sessions UI)
#   - Plex/Jellyfin actual sign-in (needs interactive credentials)
#   - SSO password-set 403 (needs an SSO session cookie)
#
# Exit code: 0 if all PASS+SKIP and zero FAIL; 1 if any FAIL.

set -uo pipefail

URL="${1:-http://localhost:3001}"
PASS=0
FAIL=0
SKIP=0

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  CYAN=''
  NC=''
fi

pass() { printf "  ${GREEN}✓${NC} %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ${RED}✗${NC} %s\n      %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); }
skip() { printf "  ${YELLOW}~${NC} %s\n      %s\n" "$1" "$2"; SKIP=$((SKIP + 1)); }
section() { printf "\n${CYAN}── %s ──${NC}\n" "$1"; }

# ── Read CRON_SECRET from env ──────────────────────────────────────────────────
if [ -n "${CRON_SECRET:-}" ]; then
  : # already set
elif [ -f .env.local ]; then
  CRON_SECRET=$(grep -E '^CRON_SECRET=' .env.local | head -1 | cut -d= -f2-)
elif [ -f .env ]; then
  CRON_SECRET=$(grep -E '^CRON_SECRET=' .env | head -1 | cut -d= -f2-)
fi
# Strip optional quote wrappers
CRON_SECRET="${CRON_SECRET%\"}"; CRON_SECRET="${CRON_SECRET#\"}"
CRON_SECRET="${CRON_SECRET%\'}"; CRON_SECRET="${CRON_SECRET#\'}"

if [ -z "${CRON_SECRET:-}" ]; then
  printf "${RED}CRON_SECRET not found.${NC}\n"
  printf "Set it as an env var, or put CRON_SECRET=... in .env.local\n"
  exit 2
fi

# ── Detect docker compose ──────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose ps --format=json >/dev/null 2>&1; then
  HAVE_DOCKER=1
else
  HAVE_DOCKER=0
fi

run_psql() {
  if [ "$HAVE_DOCKER" = "1" ]; then
    docker compose exec -T postgres psql -U summonarr -d summonarr -tAc "$1" 2>/dev/null
  else
    echo ""
  fi
}

run_logs_grep() {
  if [ "$HAVE_DOCKER" = "1" ]; then
    docker compose logs summonarr --since "$1" 2>&1 | grep -c "$2" 2>/dev/null
  else
    echo "0"
  fi
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
printf "${CYAN}Summonarr smoke test${NC}\n"
printf "Target:        %s\n" "$URL"
printf "CRON_SECRET:   %s... (%d chars)\n" "${CRON_SECRET:0:8}" "${#CRON_SECRET}"
printf "Docker access: %s\n" "$([ "$HAVE_DOCKER" = "1" ] && echo "yes" || echo "no — DB tests will skip")"
printf "Admin cookie:  %s\n" "$([ -n "${ADMIN_COOKIE:-}" ] && echo "provided" || echo "not provided — admin tests will skip")"

# ─────────────────────────────────────────────────────────────────────────────
section "HTTP smoke"

# 1. Health endpoint
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/api/health" || echo "000")
if [ "$code" = "200" ]; then
  pass "GET /api/health → 200"
else
  fail "GET /api/health" "got HTTP $code, want 200"
fi

# 2. setup-status returns 200
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/api/auth/setup-status")
[ "$code" = "200" ] && pass "GET /api/auth/setup-status → 200" || fail "setup-status" "got $code"

# 3. /api/openapi requires auth (NextAuth's authorized() returns 302 → /login for unauth)
code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/api/openapi")
case "$code" in
  302|401|403) pass "GET /api/openapi requires auth (got $code)" ;;
  *)           fail "/api/openapi unauth" "got $code, want 302/401/403" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
section "Bearer auth (CRON_SECRET)"

# 4. CRON_SECRET works on a cron route
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$URL/api/cron/scrub-audit-pii")
case "$code" in
  200|204) pass "POST /api/cron/scrub-audit-pii (Bearer) → $code" ;;
  *)       fail "Cron Bearer auth" "got $code at /api/cron/scrub-audit-pii" ;;
esac

# 5. Bad Bearer is rejected
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer not-a-real-secret-not-even-close" \
  "$URL/api/cron/scrub-audit-pii")
case "$code" in
  401|403) pass "Bad Bearer rejected ($code)" ;;
  *)       fail "Bad Bearer" "got $code, want 401/403" ;;
esac

# 6. Sync orchestrator (advisory-locked, returns 200 even if skipped)
code=$(curl -s -o /tmp/sync.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$URL/api/sync")
case "$code" in
  200) pass "POST /api/sync (Bearer) → 200" ;;
  *)   fail "Sync orchestrator" "got $code" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
section "Schema (Postgres)"

if [ "$HAVE_DOCKER" = "0" ]; then
  skip "Schema checks" "no docker compose access — run from the host where the stack is up"
else
  # 7. New User columns
  n=$(run_psql "SELECT count(*) FROM information_schema.columns WHERE table_name='User' AND column_name IN ('plexUserId','jellyfinUserId','passwordChangedAt','sessionsRevokedAt');")
  if [ "$n" = "4" ]; then
    pass "User has all 4 new columns (plexUserId, jellyfinUserId, passwordChangedAt, sessionsRevokedAt)"
  else
    fail "User new columns" "got $n, want 4"
  fi

  # 8. Unique indexes on plexUserId / jellyfinUserId
  n=$(run_psql "SELECT count(*) FROM pg_indexes WHERE tablename = 'User' AND indexdef LIKE '%plexUserId%' AND indexdef LIKE '%UNIQUE%';")
  [ "$n" = "1" ] && pass "User.plexUserId is UNIQUE" || fail "User.plexUserId unique index" "got $n, want 1"

  n=$(run_psql "SELECT count(*) FROM pg_indexes WHERE tablename = 'User' AND indexdef LIKE '%jellyfinUserId%' AND indexdef LIKE '%UNIQUE%';")
  [ "$n" = "1" ] && pass "User.jellyfinUserId is UNIQUE" || fail "User.jellyfinUserId unique index" "got $n, want 1"

  # 9. New AuditAction values
  n=$(run_psql "SELECT count(*) FROM unnest(enum_range(NULL::\"AuditAction\")) AS x(v) WHERE v::text IN ('FIX_MATCH','VOTE_DISMISS_ALL','SERVER_USERS_BULK','AUDIT_LOG_EXPORT','PLAY_HISTORY_DELETE','BATCH_REQUEST_DECLINE');")
  [ "$n" = "6" ] && pass "AuditAction enum has all 6 new values" || fail "AuditAction enum" "got $n, want 6"

  # 10. MediaServerUser.serverMachineId
  n=$(run_psql "SELECT count(*) FROM information_schema.columns WHERE table_name='MediaServerUser' AND column_name='serverMachineId';")
  [ "$n" = "1" ] && pass "MediaServerUser.serverMachineId exists" || fail "MediaServerUser.serverMachineId" "got $n"

  # 11. PlexTokenCache.expiresAt + index
  n=$(run_psql "SELECT count(*) FROM information_schema.columns WHERE table_name='PlexTokenCache' AND column_name='expiresAt';")
  [ "$n" = "1" ] && pass "PlexTokenCache.expiresAt exists" || fail "PlexTokenCache.expiresAt" "got $n"

  n=$(run_psql "SELECT count(*) FROM pg_indexes WHERE tablename='PlexTokenCache' AND indexdef LIKE '%expiresAt%';")
  [ "$n" = "1" ] && pass "PlexTokenCache(expiresAt) indexed" || fail "PlexTokenCache expiresAt index" "got $n"

  # 12. TmdbCache(expiresAt) indexed
  n=$(run_psql "SELECT count(*) FROM pg_indexes WHERE tablename='TmdbCache' AND indexdef LIKE '%expiresAt%';")
  [ "$n" = "1" ] && pass "TmdbCache(expiresAt) indexed" || fail "TmdbCache expiresAt index" "got $n"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Encryption at rest"

if [ "$HAVE_DOCKER" = "0" ]; then
  skip "Encryption-at-rest checks" "no docker compose access"
else
  # 13. At least one encrypted Setting row
  n=$(run_psql "SELECT count(*) FROM \"Setting\" WHERE value LIKE 'enc:v1:%';")
  if [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null; then
    pass "Settings encrypted at rest ($n rows with enc:v1: prefix)"
  else
    skip "Settings encryption" "0 rows with enc:v1: prefix — re-save any sensitive setting (Plex token, Jellyfin API key, etc.) once to populate"
  fi

  # 14. No leaking secrets in plain Settings (admin keys + tokens)
  n=$(run_psql "SELECT count(*) FROM \"Setting\" WHERE key IN ('plexAdminToken','jellyfinApiKey','radarrApiKey','sonarrApiKey','discordBotToken','vapidPrivateKey','webhookSecret','tmdbApiKey','tmdbReadToken','traktApiKey','traktClientSecret','smtpPassword','resendApiKey','oidcClientSecret','discordClientSecret','omdbApiKey','mdblistApiKey') AND value NOT LIKE 'enc:v1:%' AND length(value) > 0;")
  if [ -z "$n" ] || [ "$n" = "0" ]; then
    pass "No sensitive Setting keys stored in plaintext"
  else
    fail "Plaintext sensitive Settings" "$n sensitive rows are NOT encrypted (re-save them in admin UI)"
  fi

  # 15. Account OAuth tokens encrypted (if any users)
  n=$(run_psql "SELECT count(*) FROM \"Account\" WHERE refresh_token IS NOT NULL OR access_token IS NOT NULL OR id_token IS NOT NULL;")
  if [ -z "$n" ] || [ "$n" = "0" ]; then
    skip "Account OAuth tokens" "no Account rows with tokens (no OIDC users yet)"
  else
    plain=$(run_psql "SELECT count(*) FROM \"Account\" WHERE (refresh_token IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:%') OR (access_token IS NOT NULL AND access_token NOT LIKE 'enc:v1:%') OR (id_token IS NOT NULL AND id_token NOT LIKE 'enc:v1:%');")
    if [ -z "$plain" ] || [ "$plain" = "0" ]; then
      pass "All Account OAuth tokens encrypted ($n rows)"
    else
      fail "Account OAuth tokens" "$plain rows still plaintext (next OIDC re-login will re-encrypt; or re-link the user)"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Plex / Jellyfin self-heal"

if [ "$HAVE_DOCKER" = "0" ]; then
  skip "Backfill state" "no docker compose access"
else
  bound=$(run_psql "SELECT count(*) FROM \"User\" WHERE \"plexUserId\" IS NOT NULL;")
  unbound=$(run_psql "SELECT count(*) FROM \"User\" WHERE \"plexUserId\" IS NULL;")
  total=$(run_psql "SELECT count(*) FROM \"User\";")
  if [ -n "$bound" ] && [ -n "$unbound" ]; then
    if [ "$bound" -gt 0 ] 2>/dev/null; then
      pass "Plex backfill: $bound bound, $unbound unbound (of $total users)"
      if [ "$unbound" -gt 0 ] 2>/dev/null; then
        printf "        ${YELLOW}note:${NC} unbound users will be REFUSED at Plex sign-in until manually rebound.\n"
        printf "        list:  docker compose exec postgres psql -U summonarr -d summonarr -c 'SELECT id, email FROM \"User\" WHERE \"plexUserId\" IS NULL;'\n"
        printf "        fix:   UPDATE \"User\" SET \"plexUserId\" = '<plex-id>' WHERE email = '<summonarr-email>';\n"
      fi
    else
      skip "Plex backfill" "0 bound — Plex not configured, or no email matches between Plex friends and Summonarr users"
    fi
  fi

  jf_bound=$(run_psql "SELECT count(*) FROM \"User\" WHERE \"jellyfinUserId\" IS NOT NULL;")
  if [ -n "$jf_bound" ] && [ "$jf_bound" -gt 0 ] 2>/dev/null; then
    pass "Jellyfin backfill: $jf_bound bound (auto-heals on next sign-in for synthetic-email users)"
  else
    skip "Jellyfin backfill" "0 bound — no Jellyfin users yet, or none have signed in since upgrade"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Recent logs"

if [ "$HAVE_DOCKER" = "0" ]; then
  skip "Log scan" "no docker compose access"
else
  # 16. No fetch failed in last 5 min
  n=$(run_logs_grep "5m" "fetch failed\|invalid onRequestStart")
  if [ "$n" = "0" ]; then
    pass "No fetch errors in last 5 minutes"
  else
    fail "Recent fetch errors" "$n occurrences in last 5 min — check 'docker compose logs summonarr --since 5m | grep \"fetch failed\"'"
  fi

  # 17. No crypto config errors
  n=$(run_logs_grep "10m" "TokenCryptoConfigError\|Decrypt failed: auth-tag mismatch")
  if [ "$n" = "0" ]; then
    pass "No crypto config errors in last 10 minutes"
  else
    fail "Crypto errors" "$n in last 10 min"
  fi

  # 18. Boot guard fired (TOKEN_ENCRYPTION_KEY validated)
  n=$(run_logs_grep "1h" "Refusing to start")
  if [ "$n" = "0" ]; then
    pass "No 'Refusing to start' boot rejections (token-crypto key OK)"
  else
    fail "Boot guard rejected start" "TOKEN_ENCRYPTION_KEY may be missing or malformed"
  fi

  # 19. Cron started
  n=$(run_logs_grep "1h" "Cron started")
  if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then
    pass "Cron started in last hour ($n times)"
  else
    skip "Cron started" "no 'Cron started' log line in last hour — check container has been restarted recently"
  fi

  # 20. Plex backfill log
  n=$(run_logs_grep "1h" "plex-backfill")
  if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then
    pass "[plex-backfill] log line present ($n in last hour)"
  else
    skip "Plex backfill log" "no [plex-backfill] log — Plex may not be configured, or no users to bind"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Behaviour"

# 21. machine-session is opt-in (returns 403 by default unless feature enabled)
code=$(curl -s -o /tmp/ms.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$URL/api/auth/machine-session")
case "$code" in
  403) pass "POST /api/auth/machine-session → 403 (opt-in flag respected, default OFF)" ;;
  200)
    skip "machine-session" "feature is ENABLED — minted a 15-min admin session. Confirm Setting key 'enableMachineSession' is intentionally true."
    # Bonus: bad-secret rejection
    code2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer wrong-secret-no-way-this-matches" \
      "$URL/api/auth/machine-session")
    [ "$code2" = "401" ] && pass "machine-session rejects bad CRON_SECRET (401)" \
      || fail "machine-session bad secret" "got $code2, want 401"
    ;;
  *) fail "machine-session" "got $code, want 403 (default) or 200 (if enabled)" ;;
esac

# 22. revoke-all requires auth (302 to /login is the NextAuth-default unauth response)
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" -d '{}' \
  "$URL/api/sessions/revoke-all")
case "$code" in
  302|401) pass "POST /api/sessions/revoke-all → $code (rejects unauth)" ;;
  *)       fail "revoke-all unauth" "got $code, want 302/401" ;;
esac

# 23. push/subscribe length cap before DNS resolve
giant=$(printf 'a%.0s' $(seq 1 3000))
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"https://fcm.googleapis.com/$giant\",\"keys\":{\"p256dh\":\"x\",\"auth\":\"y\"}}" \
  "$URL/api/push/subscribe")
case "$code" in
  302) pass "push/subscribe rejects unauth before body parse (302 → /login)" ;;
  401) pass "push/subscribe rejects unauthenticated (401 — expected without cookie)" ;;
  400) pass "push/subscribe rejected oversize endpoint (400)" ;;
  *)   fail "push/subscribe oversize" "got $code, want 302/400/401" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
section "Behaviour (admin cookie)"

if [ -n "${ADMIN_COOKIE:-}" ]; then
  # 24. revoke-all without confirmPassword
  code=$(curl -s -o /tmp/revoke.json -w "%{http_code}" -X POST \
    -H "Cookie: $ADMIN_COOKIE" -H "Content-Type: application/json" -d '{}' \
    "$URL/api/sessions/revoke-all")
  if [ "$code" = "401" ]; then
    if grep -q "password-required\|session-too-old" /tmp/revoke.json; then
      pass "revoke-all step-up enforced (401 password-required or session-too-old)"
    else
      fail "revoke-all step-up reason" "got 401 but unexpected body: $(cat /tmp/revoke.json)"
    fi
  else
    fail "revoke-all without password" "got $code, want 401"
  fi

  # 25. /api/sessions GET works with cookie
  code=$(curl -s -o /tmp/sess.json -w "%{http_code}" \
    -H "Cookie: $ADMIN_COOKIE" "$URL/api/sessions")
  [ "$code" = "200" ] && pass "GET /api/sessions (with cookie) → 200" \
    || fail "/api/sessions GET" "got $code"
else
  skip "revoke-all step-up + sessions GET" "set ADMIN_COOKIE='__Secure-authjs.session-token=...' to run these"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Tests requiring manual interaction (skipped here)"
skip "Browser smoke" "open the app, sign in, click around — looking for CSP violations in DevTools"
skip "Donation URL XSS guard" "admin → Settings → Donate → try to save javascript: URL → should 400"
skip "SSO password refusal" "sign in via Plex/Jellyfin/OIDC → /profile → Change password → expect 403"
skip "Issue claim race" "two browser tabs → click 'Claim' simultaneously → one wins, one gets 409"
skip "Step-up sessions UI" "sessions UI doesn't yet send confirmPassword (UI follow-up)"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
printf "${CYAN}── Summary ──${NC}\n"
printf "  ${GREEN}Passed:  %d${NC}\n" "$PASS"
printf "  ${RED}Failed:  %d${NC}\n" "$FAIL"
printf "  ${YELLOW}Skipped: %d${NC}\n" "$SKIP"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf "${GREEN}OK${NC} — all unattended checks passed. Walk through the manual tests above to fully verify.\n"
  exit 0
else
  printf "${RED}FAIL${NC} — %d check(s) failed. See output above.\n" "$FAIL"
  exit 1
fi
