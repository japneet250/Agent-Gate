# @agentgate/observability

Sentry (errors + a breadcrumb per evaluation) and LangFuse (end-to-end tracing)
for the AgentGate demo agents and eval harness. Owned by P3.

Both degrade to a no-op when their keys are missing, so the demo and the harness
still run offline.

## Use

```ts
import { observeRun, shutdownObservability, startObservability } from '@agentgate/observability';

startObservability('demo-agents');
const run = observeRun({ sessionId, agentId });
run.step(action, evalResult, toolOutput);   // once per gated tool call
run.end({ blocked: 3 });
await shutdownObservability();              // short-lived processes MUST flush
```

## Verify it actually emits

```bash
npm run verify -w @agentgate/observability
```

Stands up a local HTTP collector that speaks enough of both ingest protocols,
runs a real demo-agent run and a real eval run against it, and asserts that
breadcrumbs, events and spans arrived. No live keys needed — so it doubles as a
regression test for the wiring.

## Sentry

- `service` tag: `demo-agents` / `evals`.
- One `agentgate.evaluate` breadcrumb per evaluation, carrying tool name, args,
  decision, risk score, violated policy and latency. Level maps from the
  decision (`block` → error, `escalate` → warning, `allow` → info).
- Every `block` is also captured as a warning-level event, so the breadcrumb
  trail arrives attached to the thing it explains.
- `uncaughtException` / `unhandledRejection` are captured and flushed.

## LangFuse span names

Agreed across the team — **P2 nests engine spans under `agentgate.evaluate`**:

```
agentgate.agent.run          (P3) one demo-agent run / one eval suite
  agentgate.tool_call        (P3) one attempted tool call
    agentgate.evaluate       (P2) evaluate(); P2's judge / RAG / pattern spans go UNDER this
    agentgate.tool_exec      (P3) forwarded call to the real tool; absent unless allowed
```

Constants are exported as `SPAN` — import them rather than retyping the strings.

## Env

```
SENTRY_DSN=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```
