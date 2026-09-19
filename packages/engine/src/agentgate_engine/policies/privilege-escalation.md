# Privilege Escalation
Agents may not grant themselves or others additional permissions, add users to admin groups,
modify IAM roles, disable audit logging, or request scopes beyond the ones provisioned for the
task. A sequence of increasing permission requests within one session is a strong attack signal.
Severity: critical
Applies to: system_modification
Enforced by: pattern_detector
Accumulate: count()
Match: (grant|permission|role|scope|admin|sudo|iam|privilege)
Scope: session
Limit: 2
When exceeded: escalate
Risk floor: 70
