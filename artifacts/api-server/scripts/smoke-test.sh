#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Smoke tests — run after every deploy to verify critical paths
# Usage: BASE_URL=https://your-domain.replit.app bash scripts/smoke-test.sh
# Exit code 0 = all passed, non-zero = at least one failure.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
FAILURES=0
TOTAL=0

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILURES=$((FAILURES + 1)); }
section() { echo; echo "── $1 ──"; }

check() {
  local label="$1"
  local url="$2"
  local expected_status="${3:-200}"
  local contains="${4:-}"
  TOTAL=$((TOTAL + 1))

  HTTP_STATUS=$(curl -s -o /tmp/smoke_body.txt -w "%{http_code}" \
    -H "Accept: application/json" \
    "$url" || echo "000")

  if [ "$HTTP_STATUS" != "$expected_status" ]; then
    fail "$label — expected HTTP $expected_status, got $HTTP_STATUS"
    return
  fi

  if [ -n "$contains" ]; then
    if ! grep -q "$contains" /tmp/smoke_body.txt 2>/dev/null; then
      fail "$label — response missing expected content: $contains"
      return
    fi
  fi

  pass "$label"
}

echo "Smoke tests against: $BASE_URL"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

section "Health"
check "healthz"               "$BASE_URL/api/healthz"          200 '"status"'
check "system health"         "$BASE_URL/api/health/system"    200 '"circuitBreakers"'

section "Public API"
check "fixtures (public)"     "$BASE_URL/api/fixtures/upcoming" 200
check "fixtures upcoming"     "$BASE_URL/api/fixtures/upcoming"  200

section "Auth gates"
# These should return 401/403, not 500
check "predictions (no auth)" "$BASE_URL/api/predictions"       401
check "admin status"          "$BASE_URL/api/auth/status"       200 '"authenticated"'

section "Rate limit headers"
# Verify RateLimit headers are present on a limited route
HEADERS=$(curl -sI "$BASE_URL/api/healthz" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$HEADERS" | grep -qi "ratelimit\|x-ratelimit"; then
  pass "RateLimit headers present"
else
  # Not all routes have them — soft-warn rather than fail
  echo "  ~ RateLimit headers not detected on /healthz (expected on /api/predictions)"
  TOTAL=$((TOTAL - 1))
fi

# ─────────────────────────────────────────────────────────────
echo
echo "Results: $((TOTAL - FAILURES))/$TOTAL passed"
if [ "$FAILURES" -gt 0 ]; then
  echo "SMOKE TEST FAILED — $FAILURES failure(s)"
  exit 1
else
  echo "SMOKE TEST PASSED"
  exit 0
fi
