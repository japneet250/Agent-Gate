#!/usr/bin/env bash
#
# AgentGate — one command to bring the whole demo up.
#
#   ./demo.sh          start everything, print what to open, hold until Ctrl-C
#   ./demo.sh down     stop everything
#
# Three processes, one screen to watch. Ctrl-C tears all of it down.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
LOGS="$ROOT/.demo-logs"; mkdir -p "$LOGS"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf "  ${G}✔${X} %s\n" "$*"; }
bad()  { printf "  ${R}✘${X} %s\n" "$*"; }
warn() { printf "  ${Y}!${X} %s\n" "$*"; }

ENGINE_PORT=8000
GATEWAY_PORT=8787
DASH_PORT=3100

port_pids() { lsof -tnP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null; }

stop_all() {
  say ""
  say "${B}Stopping AgentGate…${X}"
  for port in $DASH_PORT $GATEWAY_PORT $ENGINE_PORT; do
    for pid in $(port_pids "$port"); do kill "$pid" 2>/dev/null; done
  done
  pkill -f "next dev -p $DASH_PORT"        2>/dev/null
  pkill -f "gateway/src/mcp.ts"            2>/dev/null
  pkill -f "uvicorn server:app"            2>/dev/null
  sleep 1
  ok "stopped"
}

if [[ "${1:-}" == "down" || "${1:-}" == "stop" ]]; then stop_all; exit 0; fi

WITH_ZIP=0
[[ "${1:-}" == "--zip" ]] && WITH_ZIP=1

# ---------------------------------------------------------------- environment
if [[ ! -f .env ]]; then
  bad ".env is missing. cp .env.example .env and fill in OPENAI_API_KEY."
  exit 1
fi
set -a; . ./.env; set +a

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  bad "OPENAI_API_KEY is not set in .env — the judge cannot run."
  exit 1
fi

# The eval harness and the demo agents want the BASE url; the gateway wants the
# full /evaluate path. Same variable name, two contracts — so set both here and
# never make anyone remember which is which.
export AGENTGATE_ENGINE_URL="http://localhost:${ENGINE_PORT}/evaluate"
export AGENTGATE_ENGINE_KEY="${AGENTGATE_API_KEY:-}"
export AGENTGATE_HTTP_PORT="$GATEWAY_PORT"

# A stale report.json is a stub run, and the dashboard prefers it over the real
# committed baseline — which is how the benchmark on screen becomes 91% with a
# NOT A PRODUCT NUMBER banner instead of the honest 72.3%.
if [[ -f packages/evals/report.json ]] \
   && ! node -e "process.exit(require('./packages/evals/report.json').isProductNumber?0:1)" 2>/dev/null; then
  warn "packages/evals/report.json is a stub run — moving it aside so the dashboard shows the real baseline"
  mv packages/evals/report.json "$LOGS/report.stub.$(date +%s).json"
fi

if [[ $WITH_ZIP == 1 ]]; then
  ZIP_TOKEN_FOR_ENGINE="${ZIP_API_TOKEN:-}"
else
  ZIP_TOKEN_FOR_ENGINE=""
fi

say ""
say "${B}AgentGate${X} ${D}— bringing up engine, gateway and dashboard${X}"
say ""

# ---------------------------------------------------------------------- engine
if curl -sf "http://localhost:${ENGINE_PORT}/health" >/dev/null 2>&1; then
  ok "engine already up on :${ENGINE_PORT}"
else
  if [[ ! -x packages/engine/venv/bin/uvicorn ]]; then
    bad "packages/engine/venv is missing. Run: cd packages/engine && ./setup.sh"
    exit 1
  fi
  # Zip grounding consults live Zip state, and the staging tenant has ZERO
  # vendors — so every payment is correctly refused as an unapproved payee and
  # the cumulative-spend scene never gets to happen. Off by default; ./demo.sh
  # --zip turns it on for the scene that is actually about Zip.
  ( cd packages/engine && ZIP_API_TOKEN="$ZIP_TOKEN_FOR_ENGINE" \
      nohup ./venv/bin/uvicorn server:app --port "$ENGINE_PORT" \
      > "$LOGS/engine.log" 2>&1 & )
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:${ENGINE_PORT}/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf "http://localhost:${ENGINE_PORT}/health" >/dev/null 2>&1; then
    ok "engine up on :${ENGINE_PORT}"
  else
    bad "engine did not start — see $LOGS/engine.log"; tail -5 "$LOGS/engine.log"; exit 1
  fi
fi

HEALTH=$(curl -s "http://localhost:${ENGINE_PORT}/health")
RETRIEVAL=$(node -e "try{console.log(JSON.parse(process.argv[1]).retrieval)}catch(e){console.log('?')}" "$HEALTH")
POLICIES=$(node -e "try{console.log(JSON.parse(process.argv[1]).policies)}catch(e){console.log('?')}" "$HEALTH")
VECTORS=$(node -e "try{console.log(JSON.parse(process.argv[1]).storage.vectors)}catch(e){console.log('?')}" "$HEALTH")
if [[ "$RETRIEVAL" == "hybrid" ]]; then
  ok "${POLICIES} policies · retrieval ${RETRIEVAL} · vectors ${VECTORS}"
else
  warn "retrieval is '${RETRIEVAL}', not hybrid — embeddings are failing, RAG is keyword-only"
fi

# --------------------------------------------------------------------- gateway
# This process is the COLLECTOR: MCP proxy + POST /evaluate + GET /actions +
# POST /ingest, all off one shared action log. Gateways that agents spawn
# forward their decisions here, which is what puts agent traffic on the screen.
for pid in $(port_pids "$GATEWAY_PORT"); do kill "$pid" 2>/dev/null; done
sleep 1
# CLOUDFLARE_* and D1_DATABASE_ID come from .env above, and are what make the
# action log durable rather than dying with this process.
nohup npx tsx packages/gateway/src/mcp.ts customer-support < /dev/null \
  > "$LOGS/gateway.log" 2>&1 &
for _ in $(seq 1 40); do
  curl -sf "http://localhost:${GATEWAY_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf "http://localhost:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
  ok "gateway up on :${GATEWAY_PORT} ${D}(MCP proxy + action feed collector)${X}"
  AUDIT=$(grep -o 'audit log: .*' "$LOGS/gateway.log" | head -1)
  if [[ "$AUDIT" == *durable* ]]; then
    ok "$AUDIT"
  elif [[ -n "$AUDIT" ]]; then
    warn "$AUDIT"
  fi
else
  bad "gateway did not start — see $LOGS/gateway.log"; tail -10 "$LOGS/gateway.log"; exit 1
fi

# ------------------------------------------------------------------- dashboard
for pid in $(port_pids "$DASH_PORT"); do kill "$pid" 2>/dev/null; done
pkill -f "next dev -p $DASH_PORT" 2>/dev/null
sleep 1
( cd apps/dashboard && \
  NEXT_PUBLIC_DATA_MODE=live \
  NEXT_PUBLIC_GATEWAY_URL="http://localhost:${GATEWAY_PORT}" \
  NEXT_PUBLIC_ENGINE_URL="http://localhost:${ENGINE_PORT}" \
  ENGINE_URL="http://localhost:${ENGINE_PORT}" \
  AGENTGATE_API_KEY="${AGENTGATE_API_KEY:-}" \
  LANGFUSE_HOST="${LANGFUSE_HOST:-}" \
  LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
  LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  nohup npm run dev > "$LOGS/dashboard.log" 2>&1 & )
for _ in $(seq 1 60); do
  curl -sf "http://localhost:${DASH_PORT}" >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf "http://localhost:${DASH_PORT}" >/dev/null 2>&1; then
  BENCH=$(grep -o 'benchmark: [^,]*' "$LOGS/dashboard.log" | head -1)
  ok "dashboard up on :${DASH_PORT} ${D}(live mode)${X}"
  [[ -n "$BENCH" ]] && ok "${BENCH}"
else
  bad "dashboard did not start — see $LOGS/dashboard.log"; tail -10 "$LOGS/dashboard.log"; exit 1
fi

# ------------------------------------------------------------------ what to do
cat <<BANNER

${B}────────────────────────────────────────────────────────────────${X}
${B}  OPEN THIS:  http://localhost:${DASH_PORT}/live${X}
${B}────────────────────────────────────────────────────────────────${X}

  ${B}/live${X}        THE DEMO — three production agents in three terminals.
                 Type anything at them. Every call is really evaluated.
  ${B}/present${X}     the opener — problem, mechanism, measurement
  ${B}/${X}            the Shield — live feed of every gated action
  ${B}/review${X}      the approval queue — escalations an admin signs off
  ${B}/analytics${X}   the benchmark, policy hit rates, latency split
  ${B}/policies${X}    the policies the judge cites — and publish a new one
                 in plain English, live into the vector store

${B}Or drive it from the terminal${X} — each lights up the feed live:

  ${D}./fire.sh support${X}       PII exfiltration → BLOCK on the fast path
  ${D}./fire.sh coding${X}        DROP TABLE, rm -rf → BLOCK, no model call
  ${D}./fire.sh cumulative${X}    14 legal \$400 payments → ESCALATE at \$5,200
  ${D}./fire.sh all${X}           the three scenes, in demo order

${B}Two ways to show it${X}

  ${B}1 · MCP${X}  — a real agent, no code changes
       npm run mcp -w packages/gateway -- --config
       merge into Claude Desktop's config, ⌘Q, reopen, then ask it to
       email a customer their SSN. It gets refused before the tool runs.

  ${B}2 · Enterprise${X} — the admin console
       Everything an agent attempts lands in the feed at /
       Escalations wait for a human at /review

  ${D}Ctrl-C stops everything.  Logs: .demo-logs/${X}

BANNER

trap 'stop_all; exit 0' INT TERM
while true; do sleep 3600; done
