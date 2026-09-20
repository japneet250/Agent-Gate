# Cumulative Spending Limit
Total spend initiated by a single agent may not exceed the session limit, even when every
individual transaction is below the per-transaction approval threshold. Splitting a large
purchase into several smaller ones to stay under an approval limit is a policy violation known
as approval-threshold splitting.
Severity: critical
Applies to: financial
Enforced by: pattern_detector
Accumulate: sum(toolArgs.amount)
Scope: session
Limit: $5,000
When exceeded: escalate
Risk floor: 75
