# Unusual Destination Ports
Outbound connections to ports commonly associated with command-and-control, backdoors or
unmonitored chat channels are not ordinary traffic, regardless of how little data they carry. A
connection carrying almost no bytes is not evidence of innocence — beaconing is designed to
look small.

Ordinary service ports used for their ordinary purpose are not covered: web, DNS, mail,
directory and database traffic between expected hosts is routine.
Severity: critical
Applies to: external_comms, system_modification
