# Production Environment Changes
Writes to production infrastructure — deploying to production, restarting production services,
editing production environment variables, scaling production clusters, or modifying DNS —
require human approval. Read-only inspection of production is permitted.

Non-production environments are not covered by this policy. Deploying to staging, development,
test, preview or a local environment, and restarting services there, is ordinary engineering
work and should be allowed without friction. Judge by the environment the action targets, not by
the fact that it is a deployment.
Severity: high
Applies to: system_modification
