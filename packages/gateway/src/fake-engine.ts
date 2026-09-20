import { createServer } from 'node:http';

// A stand-in for Person 2's engine, for trying the gateway before the real one exists.
// Listens on http://localhost:8000/evaluate, takes the flat { agentId, toolName, toolArgs, sessionId } and answers in camelCase, like Person 2's live engine.
// Set AGENTGATE_FAKE_ENGINE_KEY to require `Authorization: Bearer <key>`.
//   tool args mentioning "password" or "secret" -> block (85)
//   "transfer" or "wire"                        -> escalate (50)
//   anything else                               -> allow (5)
// Usage: npm run fake-engine -w packages/gateway   (AGENTGATE_FAKE_ENGINE_PORT to change the port)
const port = Number(process.env.AGENTGATE_FAKE_ENGINE_PORT ?? 8000);

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/evaluate') {
      res.writeHead(404).end();
      return;
    }
    const key = process.env.AGENTGATE_FAKE_ENGINE_KEY;
    if (key && req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    const action = JSON.parse(raw || '{}');
    const text = JSON.stringify(action.toolArgs ?? {}).toLowerCase();
    const [riskScore, decision, reasoning] = /password|secret/.test(text)
      ? [85, 'block', 'fake judge: looks like a credential']
      : /transfer|wire/.test(text)
        ? [50, 'escalate', 'fake judge: money movement, needs review']
        : [5, 'allow', 'fake judge: nothing suspicious'];
    console.error(`[fake-engine] ${action.agentId}/${action.sessionId} ${action.toolName} -> ${decision}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ riskScore, decision, reasoning, latencyMs: 1, category: 'other', degraded: false }));
  });
}).listen(port, '127.0.0.1', () => console.error(`[fake-engine] listening on http://127.0.0.1:${port}/evaluate`));
