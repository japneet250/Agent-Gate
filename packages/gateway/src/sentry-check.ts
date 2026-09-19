import { reportError } from './monitoring.js';
import { initSentryNode } from './sentry-node.js';

// Sends one harmless test error to Sentry so you can see it arrive.
// Usage: SENTRY_DSN=<your dsn> npm run sentry:check -w packages/gateway   (or put SENTRY_DSN in the repo-root .env and export it)
const on = await initSentryNode(process.env, 'sentry-check');
if (!on) {
  console.error('SENTRY_DSN is not set, nothing sent.');
  process.exit(1);
}
reportError(new Error('AgentGate Sentry check: if you can see this in Sentry, error tracking works'), 'sentry-check');
const Sentry = await import('@sentry/node');
const flushed = await Sentry.flush(5000);
console.error(flushed ? 'Sent. Look for "AgentGate Sentry check" in your Sentry project (may take a few seconds).' : 'Timed out sending. Check the DSN and your network.');
process.exit(flushed ? 0 : 1);
