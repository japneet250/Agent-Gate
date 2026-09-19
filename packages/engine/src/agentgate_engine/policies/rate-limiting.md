# Action Rate Limits
An agent making more than 20 tool calls per minute, or repeating a near-identical call more than
10 times, is treated as looping or under prompt injection. Throttle and escalate rather than
continuing to execute.
Enforced by: pattern_detector
Severity: medium
Applies to: other, system_modification
