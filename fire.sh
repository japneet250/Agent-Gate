#!/usr/bin/env bash
#
# Send an agent at AgentGate. Every decision appears in the dashboard feed.
#
#   ./fire.sh support | procurement | coding | all
#   ./fire.sh support --unprotected     what happens with no firewall
#
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'

# The demo bots each spawn their OWN gateway process, and an action log lives in
# one process. AGENTGATE_ACTION_SINK is what makes those decisions show up on
# the dashboard instead of dying with the agent.
export AGENTGATE_ACTION_SINK="http://localhost:8787/ingest"
# The harness wants the BASE url here, not /evaluate — see demo.sh.
export AGENTGATE_ENGINE_URL="http://localhost:8000"
export AGENTGATE_ENGINE_KEY="${AGENTGATE_API_KEY:-}"
# The collector owns port 8787. A spawned gateway that inherited this would try
# to bind it too, fail, and take the agent down with it.
unset AGENTGATE_HTTP_PORT

WHICH="${1:-all}"
shift || true

# --gate=off means "the agent does not judge itself — AgentGate does".
# With a local gate on, a call the agent blocks never reaches the gateway, so
# the firewall never sees the thing it exists to stop.
GATE="--gate=off"
for arg in "$@"; do
  if [[ "$arg" == "--unprotected" ]]; then
    export AGENTGATE_BYPASS=1
    echo "${B}Running with NO firewall — this is the 'before AgentGate' half.${X}"
  fi
done

run() {
  local agent="$1"
  echo ""
  echo "${B}── ${agent} agent ─────────────────────────────────────────${X}"
  npm run --silent agent -w @agentgate/demo-agents -- \
    --agent="$agent" --mode=dangerous $GATE
}

# The cumulative scene cannot be a scripted agent run: it only exists across a
# SESSION. Fourteen payments, each one legal, each under the $500 limit, all in
# one session — the pattern detector is the only thing that can see it.
cumulative() {
  local sid="split-$(date +%s)"
  echo ""
  echo "${B}── approval-threshold splitting ───────────────────────────${X}"
  echo "${D}  14 payments of \$400 to an approved vendor. Every one is legal.${X}"
  echo ""
  for i in $(seq 1 14); do
    curl -s -X POST http://localhost:8787/evaluate \
      -H "content-type: application/json" \
      -H "authorization: Bearer ${AGENTGATE_API_KEY:-}" \
      -d "{\"agentId\":\"procurement-agent\",\"toolName\":\"approve_payment\",\"toolArgs\":{\"vendor\":\"Acme Office Supplies\",\"amount\":400,\"invoice\":\"INV-$i\"},\"sessionId\":\"$sid\"}" \
      | node -e "
        let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
          const j=JSON.parse(d), n=$i, total=400*n;
          const mark={allow:'\x1b[32m●\x1b[0m',escalate:'\x1b[33m▲\x1b[0m',block:'\x1b[31m■\x1b[0m'}[j.decision];
          console.log('  '+mark+' #'+String(n).padEnd(3)+('\$'+total.toLocaleString()).padStart(8)+'  '+j.decision.toUpperCase().padEnd(9)+'risk '+String(j.riskScore).padStart(3));
          if(j.patternNotes&&j.patternNotes.length) console.log('\n    \x1b[1m'+j.patternNotes[0]+'\x1b[0m\n');
        })"
  done
  echo "${D}  No single-action check catches this. The pattern detector did.${X}"
}

case "$WHICH" in
  support|procurement|coding) run "$WHICH" ;;
  cumulative|split) cumulative ;;
  all) run support; run coding; cumulative ;;
  *) echo "usage: ./fire.sh [support|coding|procurement|cumulative|all] [--unprotected]"; exit 1 ;;
esac

echo ""
echo "${D}Every decision above is now in the feed at http://localhost:3100${X}"
