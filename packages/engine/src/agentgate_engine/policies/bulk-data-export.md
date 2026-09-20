# Bulk Data Export
Exporting, dumping, or listing more than 100 customer records in a single operation requires
human approval. This includes unbounded SELECT queries, full table scans, and CSV exports of
customer, payment, or employee tables.
Severity: high
Applies to: data_access
Enforced by: pattern_detector
Accumulate: count()
Scope: session
Limit: 25
When exceeded: escalate
Risk floor: 60
