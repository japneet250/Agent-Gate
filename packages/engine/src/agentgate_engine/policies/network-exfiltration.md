# Outbound Data Volume
A host sending an unusual volume of data to an external destination may be staging or
performing an exfiltration, even when every individual transfer is small and every connection
is to an ordinary port.

Volume is judged cumulatively across a host's activity, not per connection. Four thousand small
uploads to one destination are one exfiltration, not four thousand ordinary requests.
Severity: critical
Applies to: external_comms, data_access
Enforced by: pattern_detector
Accumulate: sum(toolArgs.bytesOut)
Scope: session
Limit: 500000000
When exceeded: escalate
Risk floor: 75
