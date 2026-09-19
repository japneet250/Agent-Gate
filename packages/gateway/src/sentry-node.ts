import { SENTRY_BASE_OPTIONS, scrubEvent, setMonitor, withoutConsoleBreadcrumbs } from './monitoring.js';
import { log } from './log.js';

/**
 * Turns on Sentry for the Node entry points (MCP proxy, local HTTP server) if SENTRY_DSN is set.
 * The SDK is loaded only when needed, so with no DSN there is no cost. Returns whether it is on.
 * `transport` is only for tests.
 */
export async function initSentryNode(
  env: Record<string, string | undefined> = process.env,
  runtime = 'node',
  transport?: unknown,
): Promise<boolean> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return false;
  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn,
    ...SENTRY_BASE_OPTIONS,
    environment: env.SENTRY_ENVIRONMENT ?? 'local',
    beforeSend: scrubEvent,
    integrations: withoutConsoleBreadcrumbs,
    ...(transport ? { transport: transport as never } : {}),
  });
  Sentry.setTag('runtime', runtime);
  setMonitor({
    captureException: (err, ctx) => void Sentry.captureException(err, ctx),
    addBreadcrumb: (crumb) => Sentry.addBreadcrumb(crumb),
  });
  log(`Sentry error tracking on (${runtime})`);
  return true;
}
