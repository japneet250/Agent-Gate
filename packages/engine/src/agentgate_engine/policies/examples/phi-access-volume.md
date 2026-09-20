# PHI Access Volume
An agent reading an unusual number of patient records in one session is a possible
bulk-extraction attempt, even when each individual read is authorised.
Severity: critical
Applies to: data_access
Enforced by: pattern_detector
Accumulate: count()
Scope: session
Limit: 5
When exceeded: escalate
Risk floor: 80
