# Destructive Shell Commands
Agents may not run commands that recursively delete files, reformat disks, overwrite devices, or
disable security tooling. Examples include recursive force deletes of root or home paths, disk
formatting, writing to raw block devices, and piping remote scripts into a shell.
Severity: critical
Applies to: system_modification
