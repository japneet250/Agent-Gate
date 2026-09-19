# Engine integration — for Person 1 (gateway) and Person 3 (evals)

Everything below is stable. If you need a change to the shape of anything here, tell me
rather than forking it.

## 1. The one function

```ts
import { evaluate, warmup } from '@agentgate/engine';

await warmup();                    // once, at gateway boot
const result = await evaluate(action, context);
```

```ts
evaluate(action: AgentAction, context?: SessionContext): Promise<EvalResult>
```

`EvalResult` is exactly the shared type — `{ riskScore, decision, reasoning, violatedPolicy?, latencyMs }`.

**`evaluate` never throws.** Every internal failure — no API key, OpenAI down, timeout,
malformed model output, bad policy file — degrades to a returned result, never an exception.
You do not need a try/catch. If everything is broken you get `decision: 'escalate'` with the
reason in `reasoning`.

**Nothing is enforced here.** The engine returns a judgement. Blocking, forwarding and the
human-review queue are yours.

## 2. Where this sits relative to your rule engine

Your rules run **first**. Only call the engine when they did not decide:

```ts
const ruled = runRules(action);
if (ruled.matched) return ruled;      // fast path, <10ms, no LLM, no cost
return await evaluate(action, ctx);   // slow path, ~1.8s, costs money
```

Every call to `evaluate` is two LLM calls plus an embedding. Do not call it for actions
your rules already settled.

## 3. Latency — please read this one

Measured over 29 live evaluations against GPT-4o:

```
mean 1842ms · p50 1753ms · p95 2740ms · max 3252ms
```

**This is not the ~500ms the spec assumed.** Plan the demo around it: the fast path is where
the "4ms" story lives, and the judge is the considered-opinion story. If we need the slow
path faster, the lever is swapping the judge to `gpt-4o-mini`
(`AGENTGATE_JUDGE_MODEL=gpt-4o-mini`) — I have not benchmarked accuracy on that yet.

## 4. Session context

```ts
await evaluate(action, { sessionId, agentId, recentActions });
```

Only `sessionId` matters. If you pass `recentActions` the judge uses yours; if you don't, the
engine supplies the last 10 it recorded itself. Either works.

**Use a stable `sessionId` per agent conversation.** All cumulative detection keys off it — a
fresh id per action means the 30 × $400 demo silently never fires. Falls back to
`action.sessionId` if you pass no context.

## 5. Richer result for the dashboard

`evaluateDetailed()` returns everything `evaluate()` does plus what the dashboard's detail
view needs:

```ts
{ category, retrievedPolicies: [{name, score}], patternNotes, guardrails, degraded }
```

`degraded: true` means a node fell back instead of using its model — worth a badge in the UI,
it means trust the score less.

## 6. Cloudflare swap (your hours 16–20)

The engine never touches storage directly, only two interfaces. Implement them against
Vectorize and D1 and call `configureStores` once at Worker boot. Nothing inside the pipeline
changes.

```ts
import { configureStores, type VectorStore, type SessionStore } from '@agentgate/engine';

class VectorizeStore implements VectorStore {
  constructor(private index: VectorizeIndex) {}
  async upsert(records) {
    await this.index.upsert(records.map((r) => ({ id: r.id, values: r.vector, metadata: r.metadata })));
  }
  async query(vector, topK) {
    const res = await this.index.query(vector, { topK });
    return res.matches.map((m) => ({ id: m.id, score: m.score }));
  }
  async size() { return (await this.index.describe()).vectorsCount; }
}

class D1SessionStore implements SessionStore {
  constructor(private db: D1Database) {}
  async get(sessionId) {
    const row = await this.db.prepare('SELECT state FROM sessions WHERE id = ?').bind(sessionId).first();
    return row ? JSON.parse(row.state as string) : emptySession(sessionId);
  }
  async save(state) {
    await this.db.prepare('INSERT OR REPLACE INTO sessions (id, state) VALUES (?, ?)')
      .bind(state.sessionId, JSON.stringify(state)).run();
  }
  async reset() { await this.db.prepare('DELETE FROM sessions').run(); }
}

configureStores({ vectors: new VectorizeStore(env.POLICY_INDEX), sessions: new D1SessionStore(env.DB) });
await warmup();   // embeds policies into Vectorize on first boot
```

Two things to know before you do this:

- `warmup()` re-embeds all 19 policies on every cold start. Against Vectorize that is wasted
  writes — gate it on `(await vectors.size()) === 0`, or embed once in a deploy script.
- The in-memory session store does not survive a Worker eviction. Durable Objects are the
  right home for session state if cumulative detection has to hold across evictions.

## 7. Environment

Only `OPENAI_API_KEY` is required. `.env` is read from the repo root, so one file covers all
packages. LangFuse keys are optional — tracing no-ops without them.

Tuning knobs (all optional, all in `src/config.ts`): `AGENTGATE_JUDGE_MODEL`,
`AGENTGATE_SESSION_SPEND_LIMIT`, `AGENTGATE_ALLOW_BELOW`, `AGENTGATE_BLOCK_AT`,
`AGENTGATE_JUDGE_TIMEOUT_MS`.

## 8. For Person 3 (evals)

- `evaluateDetailed()` gives you `retrievedPolicies` for RAGAS context-relevancy and
  `reasoning` for faithfulness.
- Call `resetSessions()` between scenarios or cumulative state leaks across test cases.
- `test/mockOpenAI.ts` is a scriptable fake client if you want deterministic CI runs with no
  API cost.
- My live suite (`npm run test:live -w @agentgate/engine`) is 16 hand-written scenarios, not a
  benchmark. Your 100+ dataset is the real measurement — this is just a smoke test.
