# Destructive Shell Commands
Agents may not run commands that destroy data outside the project they are working in, reformat
disks, overwrite devices, or disable security tooling.

Prohibited: recursive deletes of system, root or home paths (`/`, `/etc`, `/var`, `~`, `$HOME`),
disk formatting, writing to raw block devices, piping a remote script into a shell, and
disabling or uninstalling security agents.

Explicitly permitted, because this is ordinary development work: deleting build artefacts,
caches and dependency directories inside the current project — `node_modules`, `dist`, `build`,
`target`, `.venv`, `__pycache__`, `.next`, `coverage` — and removing temporary files the agent
itself created. A recursive delete is judged by what it points at, not by the flags it uses.
Severity: critical
Applies to: system_modification
