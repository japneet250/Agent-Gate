/**
 * Reads ZIP_* settings from the repo's .env into the process environment.
 *
 * The gateway never loaded .env (the engine does its own), so a ZIP_API_KEY
 * placed in .env, exactly where the setup instructions say to put it, was
 * invisible to `npm run mcp -- zip`. ziphq-mcp then started without a key and
 * silently exposed the wrong tool set.
 *
 * Deliberately narrow: only ZIP_* names, and a variable that is already set
 * wins. Loading the whole file would quietly change how the gateway behaves
 * (Sentry, HTTP key, engine URL) as a side effect of a Zip fix.
 */
import { readFileSync } from 'node:fs';

/** `KEY=value` lines. Handles `export`, quotes and comments; not multi-line values. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, ''); // an unquoted trailing comment
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Sets any ZIP_* variable from `file` that the environment does not already have.
 * Returns the NAMES it set (never values). A missing file is not an error.
 */
export function loadZipEnv(
  file: string,
  env: Record<string, string | undefined> = process.env,
  read: (f: string) => string = (f) => readFileSync(f, 'utf8'),
): string[] {
  let text: string;
  try {
    text = read(file);
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (!name.startsWith('ZIP_') || !value || env[name]) continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}
