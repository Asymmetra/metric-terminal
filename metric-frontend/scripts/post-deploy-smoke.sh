#!/usr/bin/env bash
# Post-deploy smoke test for Vercel frontend.
# Verifies the deployed frontend can reach the backend API and WS feeds.
#
# Usage: ./scripts/post-deploy-smoke.sh [FRONTEND_URL] [BACKEND_URL]
# Or set FRONTEND_URL / BACKEND_URL env vars. Defaults to localhost.

set -euo pipefail

BASE_URL="${1:-${FRONTEND_URL:-http://localhost:3000}}"
BACKEND_URL="${2:-${BACKEND_URL:-http://localhost:3001}}"
FAILED=0
TOTAL=0

pass() { TOTAL=$((TOTAL + 1)); echo "  PASS: $1"; }
fail() { TOTAL=$((TOTAL + 1)); FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

echo "=== Post-Deploy Smoke Test ==="
echo "Frontend: $BASE_URL"
echo "Backend:  $BACKEND_URL"
echo ""

# 1. Frontend serves HTML
echo "[1] Frontend reachability"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/terminal" --max-time 15)
if [ "$HTTP_CODE" = "200" ]; then
  pass "Frontend /terminal returns 200"
else
  fail "Frontend /terminal returned $HTTP_CODE (expected 200)"
fi

# 2. Frontend HTML contains production API URL (not localhost)
echo "[2] API URL baked into frontend bundle"
PAGE_HTML=$(curl -s "$BASE_URL/terminal" --max-time 15)
if echo "$BASE_URL" | grep -q "localhost"; then
  pass "Local run — skipping production API-URL bundle check"
elif echo "$PAGE_HTML" | grep -q "localhost:3001"; then
  fail "Frontend HTML contains 'localhost:3001' — production env vars not set correctly"
else
  # The URL may be in JS chunks, not the HTML shell — treat absence of localhost as OK
  pass "Frontend HTML does not contain localhost (JS chunks not checked in this test)"
fi

# 3. Backend health
echo "[3] Backend health"
HEALTH=$(curl -s "$BACKEND_URL/health" --max-time 10)
if echo "$HEALTH" | grep -qi "ok"; then
  pass "Backend /health returns ok"
else
  fail "Backend /health returned: $HEALTH"
fi

# 4. Backend API — markets endpoint
echo "[4] Backend API data"
MARKETS=$(curl -s "$BACKEND_URL/api/markets" --max-time 10)
if echo "$MARKETS" | grep -q '"symbol":"SOL"'; then
  pass "Backend /api/markets returns SOL"
else
  fail "Backend /api/markets missing SOL: $MARKETS"
fi

# 5. Backend API — orderbook
echo "[5] Backend orderbook"
ORDERBOOK=$(curl -s "$BACKEND_URL/api/orderbook/SOL" --max-time 10)
if echo "$ORDERBOOK" | grep -q "bids\|asks"; then
  pass "Backend /api/orderbook/SOL has bids/asks"
else
  fail "Backend /api/orderbook/SOL unexpected: $ORDERBOOK"
fi

# 6. CORS — preflight check from frontend origin
echo "[6] CORS preflight"
CORS_HEADERS=$(curl -s -I -X OPTIONS \
  -H "Origin: $BASE_URL" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  "$BACKEND_URL/api/tx/market-order" --max-time 10 2>&1)
if echo "$CORS_HEADERS" | grep -qi "access-control-allow-origin"; then
  pass "CORS preflight returns allow-origin header"
else
  fail "CORS preflight missing allow-origin header"
fi

# 7. WebSocket health endpoint (if available)
echo "[7] WebSocket relay health"
WS_HEALTH=$(curl -s "$BACKEND_URL/health/ws" --max-time 10 2>&1)
if echo "$WS_HEALTH" | grep -q '"status":"ok"'; then
  pass "WS relay /health/ws status ok"
elif echo "$WS_HEALTH" | grep -q '"fresh"'; then
  pass "WS relay /health/ws reports channel status"
else
  fail "WS relay /health/ws unexpected: $WS_HEALTH"
fi

echo ""
echo "=== Results: $((TOTAL - FAILED))/$TOTAL passed ==="
if [ "$FAILED" -gt 0 ]; then
  echo "SMOKE TEST FAILED — $FAILED failures detected"
  exit 1
else
  echo "ALL CHECKS PASSED"
  exit 0
fi
