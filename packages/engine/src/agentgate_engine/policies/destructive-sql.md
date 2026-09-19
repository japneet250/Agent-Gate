# Destructive Database Operations
Agents may not execute DROP, TRUNCATE, ALTER, or unqualified DELETE/UPDATE statements against any
database. DELETE and UPDATE statements must include a WHERE clause scoped to specific records.
Schema migrations are human-only.
Severity: critical
Applies to: system_modification, data_access
