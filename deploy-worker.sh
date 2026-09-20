#!/usr/bin/env bash
#
# Deploy the gateway to Cloudflare Workers, with the engine reachable from it.
#
#   ./deploy-worker.sh
#
# Needs CLOUDFLARE_API_TOKEN with **Workers Scripts: Edit** (D1:Edit and
# Vectorize:Edit are already in use elsewhere and are not enough on their own —
# deploying is a separate permission and fails with "No access to the specified
# service").
#
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok(){ printf "  ${G}✔${X} %s\n" "$*"; }
bad(){ printf "  ${R}✘${X} %s\n" "$*"; }
warn(){ printf "  ${Y}!${X} %s\n" "$*"; }

CF=/tmp/claude-501/cloudflared
[[ -x "$CF" ]] || CF=$(command -v cloudflared || true)

say(){ printf '%s\n' "$*"; }
say ""
say "${B}Deploying the AgentGate gateway to Cloudflare Workers${X}"
say ""

# ---------------------------------------------------------------- the engine
# The Worker runs at the edge, so "localhost" means nothing to it. Without a
# reachable judge the Worker is rules-only, and a call no rule catches is
# ALLOWED — fail-open, which is the one posture a firewall must not have.
if ! curl -sf http://localhost:8000/health >/dev/null 2>&1; then
  bad "the engine is not running on :8000 — start it first (./demo.sh)"
  exit 1
fi
ok "engine is up locally"

TUNNEL=""
if [[ -n "$CF" ]]; then
  if [[ -f /tmp/claude-501/tunnel-url.txt ]] \
     && curl -sf "$(cat /tmp/claude-501/tunnel-url.txt)/health" >/dev/null 2>&1; then
    TUNNEL=$(cat /tmp/claude-501/tunnel-url.txt)
    ok "reusing the existing tunnel: $TUNNEL"
  else
    nohup "$CF" tunnel --url http://localhost:8000 > /tmp/claude-501/tunnel.log 2>&1 &
    for _ in $(seq 1 30); do
      TUNNEL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/claude-501/tunnel.log 2>/dev/null | head -1)
      [[ -n "$TUNNEL" ]] && break
      sleep 1
    done
    if [[ -n "$TUNNEL" ]]; then
      printf '%s' "$TUNNEL" > /tmp/claude-501/tunnel-url.txt
      ok "tunnel up: $TUNNEL"
    fi
  fi
fi
[[ -z "$TUNNEL" ]] && warn "no tunnel — the Worker will run rules-only (and fail open on anything the rules miss)"

# ------------------------------------------------------------------- migrate
( cd packages/gateway && npx wrangler d1 migrations apply agentgate --remote >/dev/null 2>&1 )
ok "D1 migrations applied"

# -------------------------------------------------------------------- deploy
# Secrets can only be set on a script that exists, so the first deploy goes out
# before them. The Worker fails CLOSED without AGENTGATE_API_KEY (503), so that
# window refuses requests rather than serving them unauthenticated.
say ""
say "${D}deploying…${X}"
if ! ( cd packages/gateway && npx wrangler deploy 2>&1 | tail -12 ); then
  bad "deploy failed"
  exit 1
fi

put(){ printf '%s' "$2" | ( cd packages/gateway && npx wrangler secret put "$1" >/dev/null 2>&1 ) \
       && ok "secret $1" || bad "secret $1"; }
say ""
put AGENTGATE_API_KEY "${AGENTGATE_API_KEY:-}"
[[ -n "$TUNNEL" ]] && put AGENTGATE_ENGINE_URL "$TUNNEL/evaluate"
[[ -n "$TUNNEL" ]] && put AGENTGATE_ENGINE_KEY "${AGENTGATE_API_KEY:-}"
[[ -n "${SENTRY_DSN:-}" ]] && put SENTRY_DSN "$SENTRY_DSN"

# Secrets only reach the running Worker on the next deploy.
say ""
say "${D}redeploying so the secrets take effect…${X}"
( cd packages/gateway && npx wrangler deploy 2>&1 | grep -E "https://|Current Version" | head -4 )

URL=$( cd packages/gateway && npx wrangler deployments list 2>/dev/null | grep -oE "https://[a-z0-9.-]+workers\.dev" | head -1 )
[[ -z "$URL" ]] && URL="https://agentgate-gateway.<your-subdomain>.workers.dev"

say ""
say "${B}Verify${X}"
say "  curl $URL/health"
say "  curl -X POST $URL/evaluate \\"
say "    -H 'content-type: application/json' \\"
say "    -H \"authorization: Bearer \$AGENTGATE_API_KEY\" \\"
say "    -d '{\"agentId\":\"edge\",\"toolName\":\"run_command\",\"toolArgs\":{\"command\":\"rm -rf /\"},\"sessionId\":\"edge\"}'"
say ""
