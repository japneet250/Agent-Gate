# Bulk Export Row Volume
An agent exporting a very large number of rows across a session may be staging a
dataset for extraction, even when each export is individually authorised.
Severity: high
Applies to: data_access
Enforced by: pattern_detector
Accumulate: sum(toolArgs.rowCount)
Scope: session
Limit: 100000
When exceeded: escalate
Risk floor: 70
