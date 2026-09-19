/**
 * Loads the repo-root .env, from anywhere in the workspace.
 *
 * `import 'dotenv/config'` resolves .env against process.cwd(), and npm
 * workspace scripts run with cwd set to the *package* directory -- so
 * `npm run eval -w @agentgate/evals` looked for packages/evals/.env and
 * silently found nothing. Every key in the repo-root .env was invisible to
 * both entrypoints, which reads exactly like "no keys configured".
 *
 * Import this for its side effect, as the FIRST import of an entrypoint:
 *
 *     import '@agentgate/observability/load-env';
 *
 * It has to be an import rather than a function call because some modules read
 * process.env at module scope (models/registry.ts builds MODEL_IDS on import),
 * and ESM evaluates imports in order before any of the importing module's body.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

function findRepoRootEnv(startDir: string): string | undefined {
  let dir = startDir;
  // Walk up to the filesystem root; the workspace root is wherever .env sits
  // next to the root package.json.
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envPath =
  findRepoRootEnv(process.cwd()) ??
  findRepoRootEnv(path.dirname(fileURLToPath(import.meta.url)));

if (envPath) {
  // override:false -- a var already exported in the shell wins over the file,
  // so CI and one-off `FOO=bar npm run ...` invocations still work.
  config({ path: envPath, override: false });
} else if (!process.env.AGENTGATE_QUIET_ENV) {
  console.warn('[env] no .env found — relying on the ambient environment only');
}

export const loadedEnvPath = envPath;
