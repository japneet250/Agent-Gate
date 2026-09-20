-- What Zip said about an action (budget, vendor, approvers), so the dashboard can show why a purchase was refused.
-- Apply locally:  npx wrangler d1 migrations apply agentgate --local
-- Apply remotely: npx wrangler d1 migrations apply agentgate --remote
--
-- ORDER MATTERS when deploying: apply this BEFORE deploying the Worker that writes/reads the column. Until it exists,
-- the INSERT into action_logs and the GET /actions SELECT both fail (the audit write is swallowed, so rows go missing).

ALTER TABLE action_logs ADD COLUMN zip_facts TEXT;  -- JSON array of sentences from the engine, PII-masked; NULL = Zip was not consulted
