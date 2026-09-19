# Seeing it work

Everything here runs on one machine with nothing but an OpenAI key.

---

## 0. One-time setup

```bash
cd packages/engine
./setup.sh
```

That builds a venv, installs dependencies, and installs `agentgate_shared` and
`agentgate_engine` in editable mode. Takes about a minute.

The only thing you need is `OPENAI_API_KEY` in the repo-root `.env`. Everything else is
optional.

---

## 1. Prove it works with no API key and no network

```bash
./venv/bin/pytest -q
```

```
29 passed in 0.44s
```

These run the real pipeline — the real graph, the real guardrails, the real pattern detector —
against a scripted fake model. They prove the *mechanics*. They cost nothing and they are what
you run in CI.

Useful slices:

```bash
./venv/bin/pytest tests/test_patterns.py -v          # the cumulative spend logic
./venv/bin/pytest -k consistency -v                  # the consistency guardrail
./venv/bin/pytest -k degradation -v                  # what happens when OpenAI is down
```

---

## 2. Watch it run, narrated

```bash
./venv/bin/python demo.py
```

Four scenes, about 40 seconds:

```
──────────────────────────────────────────────────────────────────────────
  Scene 1 — a normal day. Security should be invisible.
──────────────────────────────────────────────────────────────────────────

  agent attempts: look up order #12345
  ● ALLOW       risk  10/100    1803ms   data_access
  The action involves looking up a single order by its ID, which is a routine
  read-only operation…

──────────────────────────────────────────────────────────────────────────
  Scene 3 — 30 × $400. Every one is under the $500 approval limit.
──────────────────────────────────────────────────────────────────────────

  ● #1  $   400 approved   risk 0
  ● #2  $   800 approved   risk 0
  …
  ● #12 $ 4,800 approved   risk 0

  agent attempts: purchase order #13 — $400 to Supplier 13
  ▲ ESCALATE    risk  75/100    1766ms   financial
  policy violated: Cumulative Spending Limit
  …Cumulative spend alert: $5,200 across 13 transactions this session exceeds
  the $5,000 limit. Pattern: approval-threshold splitting.

  No single-action check catches this. The pattern detector did.
```

`--fast` skips the pauses. `--http` drives the running service instead of the in-process
pipeline — use that to prove the HTTP path works end to end.

---

## 3. Run the service Person 1 calls

```bash
./venv/bin/uvicorn server:app --port 8000
```

```
[agentgate] engine ready — 19 policies, hybrid retrieval, tracing off
```

In another terminal:

```bash
curl -s localhost:8000/health | python3 -m json.tool
```

Send it a dangerous action:

```bash
curl -s -X POST localhost:8000/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"support-bot","toolName":"send_email","sessionId":"s1",
       "toolArgs":{"to":"personal@gmail.com","body":"SSN 123-45-6789"}}' \
  | python3 -m json.tool
```

```json
{
  "riskScore": 100,
  "decision": "block",
  "reasoning": "The attempted email contains personally identifiable information…",
  "violatedPolicy": "PII Protection",
  "latencyMs": 1790,
  "category": "external_comms",
  "retrievedPolicies": [{"name": "PII Protection", "score": 0.452}, …],
  "degraded": false
}
```

And a safe one, which should come back `allow` with a low score:

```bash
curl -s -X POST localhost:8000/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"support-bot","toolName":"lookup_order","sessionId":"s1",
       "toolArgs":{"orderId":"12345"}}' | python3 -m json.tool
```

Interactive API docs, handy for showing a judge: **http://localhost:8000/docs**

---

## 4. Watch cumulative state build up

Fire orders at it and watch the running total climb:

```bash
for i in $(seq 1 13); do
  curl -s -X POST localhost:8000/evaluate -H 'Content-Type: application/json' \
    -d "{\"agentId\":\"proc\",\"toolName\":\"approve_payment\",\"sessionId\":\"proc-1\",
         \"toolArgs\":{\"vendor\":\"Supplier $i\",\"vendorStatus\":\"approved\",\"amount\":400}}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print(f\"#$i {r['decision']:<9} risk={r['riskScore']}\")"
done

curl -s localhost:8000/sessions/proc-1 | python3 -m json.tool
```

The first twelve allow; the thirteenth escalates. Reset between demo runs:

```bash
curl -s -X POST localhost:8000/sessions/reset
```

---

## 5. Prove the judgement, not just the plumbing

```bash
./venv/bin/python test_live.py
```

16 hand-written scenarios plus the semantic-retrieval and cumulative checks, against the real
model. Costs a few cents. Prints every decision, the policy cited, the reasoning, and a latency
summary.

```
18/18 passed
  n=29  mean=1842ms  p50=1753ms  p95=2740ms  max=3252ms
```

This is a **smoke test, not a benchmark**. Person 3's 100+ scenario dataset is the real
measurement — don't quote these numbers as precision/recall.

---

## 6. See inside the pipeline (LangFuse)

Add to the repo-root `.env`:

```
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
LANGFUSE_BASEURL=https://us.cloud.langfuse.com
```

**Get the region right.** LangFuse Cloud is regional and keys only work against
their own region — EU is `https://cloud.langfuse.com`, US is
`https://us.cloud.langfuse.com`. The wrong one returns a 401 reading
*"Invalid credentials. Confirm that you've configured the correct host"*, which
reads like a bad key and is not. This project is on **US**.

Restart and run anything. Each evaluation becomes one trace at
[cloud.langfuse.com](https://cloud.langfuse.com):

```
agentgate.evaluate
  ├─ classifier.run           (classifier.llm — gpt-4o-mini, tokens, cost)
  ├─ policy_retriever.search  (policy_retriever.embed_query)
  ├─ risk_judge.evaluate      (risk_judge.llm — gpt-4o, tokens, cost)
  ├─ decision_gate.decide
  └─ pattern_detector.check   (event: pattern.alert)
```

Without the keys, tracing is a no-op — nothing breaks, you just don't get traces. This is the
screenshot for the Devpost submission.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| LangFuse 401 "invalid credentials" | wrong regional host — see above, this project is US |
| `retrieval: keyword-only` in `/health` | no API key, or the embedding call failed. Still works; semantic matching is off. |
| Everything comes back `escalate` at ~10ms | circuit breaker is open — OpenAI failed 3 times. Clears after 30s. |
| Cumulative alert never fires | a different `sessionId` per action. It must be stable per conversation. |
| `risk 50, degraded: true` | the judge failed. The reason is in `reasoning`. |
| Import errors | the venv isn't active, or `./setup.sh` wasn't run. |
