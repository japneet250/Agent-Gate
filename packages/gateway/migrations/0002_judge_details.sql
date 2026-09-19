-- Adds what the AI judge returns, plus who decided, to action_logs (table created in 0001).
-- Apply locally:  npx wrangler d1 migrations apply agentgate --local
-- Apply remotely: npx wrangler d1 migrations apply agentgate --remote
-- The engine's own table (agentgate_sessions) shares this database and is not touched here.

ALTER TABLE action_logs ADD COLUMN tool_args TEXT;                       -- JSON, REDACTED: PII masked, secret-looking keys blanked, long values cut
ALTER TABLE action_logs ADD COLUMN category TEXT;                        -- engine classifier: data_access | external_comms | financial | ...
ALTER TABLE action_logs ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0;  -- 1 = an engine node fell back (or the judge was unreachable): trust the score less
ALTER TABLE action_logs ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'rules'; -- 'rules' | 'judge' | 'fallback' (judge missing/unreachable, fail-closed default)
ALTER TABLE action_logs ADD COLUMN retrieved_policies TEXT;              -- JSON array from the engine
ALTER TABLE action_logs ADD COLUMN pattern_notes TEXT;                   -- JSON array from the engine
ALTER TABLE action_logs ADD COLUMN guardrails TEXT;                      -- JSON array from the engine

CREATE INDEX idx_action_logs_decided_by ON action_logs (decided_by, created_at DESC);
