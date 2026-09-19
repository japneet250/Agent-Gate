// stdout is the MCP channel when running over stdio, so all logging goes to stderr.
// Set AGENTGATE_LOG_FILE to also append log lines to a file (some MCP clients drop stderr).
export const log = (...args: unknown[]) => {
  console.error('[agentgate]', ...args);
  const file = process.env.AGENTGATE_LOG_FILE;
  // node:fs is looked up at call time (not imported) so this file also bundles for Cloudflare Workers.
  if (file) process.getBuiltinModule('node:fs').appendFileSync(file, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
};

// Argument values can hold PII, so logs only get the argument names unless AGENTGATE_LOG_ARGS=1.
export const describeArgs = (args: Record<string, unknown>) =>
  process.env.AGENTGATE_LOG_ARGS === '1' ? args : Object.keys(args);
