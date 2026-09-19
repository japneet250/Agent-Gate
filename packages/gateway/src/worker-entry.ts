import * as Sentry from '@sentry/cloudflare';
import { SENTRY_BASE_OPTIONS, scrubEvent, setMonitor, withoutConsoleBreadcrumbs } from './monitoring.js';
import { createWorker } from './worker.js';

// The file wrangler deploys (see wrangler.jsonc `main`): the Worker wrapped with Sentry.
// Set SENTRY_DSN as a secret (`npx wrangler secret put SENTRY_DSN`) to turn error tracking on; with no DSN the SDK sends nothing.
setMonitor({
  captureException: (err, ctx) => void Sentry.captureException(err, ctx),
  addBreadcrumb: (crumb) => Sentry.addBreadcrumb(crumb),
});

export default Sentry.withSentry(
  (env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string }) => ({
    dsn: env.SENTRY_DSN || undefined,
    ...SENTRY_BASE_OPTIONS,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    beforeSend: scrubEvent,
    integrations: withoutConsoleBreadcrumbs,
  }),
  createWorker(),
);
