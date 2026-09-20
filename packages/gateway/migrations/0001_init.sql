-- AgentGate D1 schema.
-- Apply locally:  npx wrangler d1 migrations apply agentgate --local
-- Apply remotely: npx wrangler d1 migrations apply agentgate --remote

-- Policies the dashboard can list and toggle. `id` of a 'rule' policy is the rule's name in src/rules.ts;
-- setting enabled = 0 turns that rule off (a missing row or enabled = 1 means on).
CREATE TABLE policies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('rule', 'llm')),
  pattern     TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per action that went through POST /evaluate, with the decision.
-- Argument VALUES are deliberately not stored (they can contain SSNs, card numbers, ...): only the names.
CREATE TABLE action_logs (
  id              TEXT PRIMARY KEY,         -- server-generated, so a caller can't overwrite or suppress rows
  action_id       TEXT NOT NULL,            -- the id the caller supplied (not unique)
  created_at      TEXT NOT NULL,            -- ISO 8601, server clock
  agent_id        TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  arg_keys        TEXT NOT NULL,            -- JSON array of argument names
  decision        TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'escalate')),
  risk_score      REAL NOT NULL,
  reasoning       TEXT NOT NULL,
  violated_policy TEXT,                     -- comma-separated policy ids, NULL if none
  latency_ms      REAL NOT NULL
);
CREATE INDEX idx_action_logs_created ON action_logs (created_at DESC);
CREATE INDEX idx_action_logs_agent   ON action_logs (agent_id, created_at DESC);
CREATE INDEX idx_action_logs_decision ON action_logs (decision, created_at DESC);

INSERT INTO policies (id, name, description, type, pattern) VALUES
  ('pii_detector',        'PII detector',        'Blocks SSNs and credit card numbers; escalates emails and phone numbers in free text.', 'rule', 'SSN, card (Luhn), email, phone'),
  ('destructive_command', 'Destructive commands', 'Blocks rm -rf, DROP TABLE, TRUNCATE, DELETE FROM, disk formatting in shell/SQL tools.', 'rule', 'rm -r, DROP, TRUNCATE, DELETE FROM, mkfs'),
  ('spending_limit',      'Spending limit',      'Blocks payment tool calls with an amount above the limit ($500 by default).', 'rule', 'amount > limit'),
  ('rate_limit',          'Rate limit',          'Blocks an agent that makes more than 20 calls in 60 seconds.', 'rule', '> 20 calls / 60s'),
  ('blocked_tool',        'Blocked tools',       'Blocks tools on the configured never-call list.', 'rule', 'AGENTGATE_BLOCKED_TOOLS');
