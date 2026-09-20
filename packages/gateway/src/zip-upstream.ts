/**
 * How to launch Zip's MCP server (`ziphq-mcp`).
 *
 * Zip's setup doc runs it with `uv run --with ziphq-mcp ziphq-mcp`. The gateway
 * used to hardcode `~/.local/bin/ziphq-mcp`, which only exists after a separate
 * `uv tool install`, so a machine set up exactly as the doc says could not start
 * it. This picks, in order:
 *
 *   1. ZIP_MCP_COMMAND          an explicit command line, split on spaces
 *   2. uv                       `uv run --with ziphq-mcp ziphq-mcp` (the doc's way)
 *   3. ~/.local/bin/ziphq-mcp   a `uv tool install`ed binary
 *
 * If neither is installed it still returns the uv form, so the failure names
 * `uv` (which the doc tells you to install) rather than a path nobody asked for.
 *
 * Kept out of mcp.ts because that file starts the proxy when imported.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ZipUpstream {
  command: string;
  args: string[];
  /** Which rule chose it, for the startup log. */
  via: 'env' | 'uv' | 'binary' | 'missing';
}

const UV_ARGS = ['run', '--with', 'ziphq-mcp', 'ziphq-mcp'];

export function zipUpstream(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): ZipUpstream {
  const explicit = env.ZIP_MCP_COMMAND?.trim();
  if (explicit) {
    const [command, ...args] = explicit.split(/\s+/);
    return { command, args, via: 'env' };
  }

  const home = env.HOME ?? '';
  // Claude Desktop launches servers with a minimal PATH, so look in the usual install spots too.
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    const uv = path.join(dir, 'uv');
    if (exists(uv)) return { command: uv, args: UV_ARGS, via: 'uv' };
  }

  const binary = `${home}/.local/bin/ziphq-mcp`;
  if (exists(binary)) return { command: binary, args: [], via: 'binary' };

  return { command: 'uv', args: UV_ARGS, via: 'missing' };
}

/**
 * ziphq-mcp reads ZIP_API_KEY / ZIP_API_URL; the engine's REST client was written against ZIP_API_TOKEN / ZIP_API_BASE.
 * People end up with either pair in .env, so whichever is set fills in the other, in memory only (nothing is written
 * back to disk). A pair that is already set is never overridden. Returns the NAMES it filled, never values.
 */
export function aliasZipEnv(env: Record<string, string | undefined> = process.env): string[] {
  const filled: string[] = [];
  if (!env.ZIP_API_KEY && env.ZIP_API_TOKEN) {
    env.ZIP_API_KEY = env.ZIP_API_TOKEN;
    filled.push('ZIP_API_KEY');
  }
  if (!env.ZIP_API_URL && env.ZIP_API_BASE) {
    env.ZIP_API_URL = env.ZIP_API_BASE.replace(/\/+$/, ''); // a trailing slash on the host is easy to leave in
    filled.push('ZIP_API_URL');
  }
  if (!env.ZIP_API_TOKEN && env.ZIP_API_KEY) {
    env.ZIP_API_TOKEN = env.ZIP_API_KEY;
    filled.push('ZIP_API_TOKEN');
  }
  if (!env.ZIP_API_BASE && env.ZIP_API_URL) {
    env.ZIP_API_BASE = env.ZIP_API_URL;
    filled.push('ZIP_API_BASE');
  }
  return filled;
}

/** Problems that would make Zip's server come up empty or wrong. Empty means good to go. */
export function zipProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  if (!env.ZIP_API_KEY) problems.push('ZIP_API_KEY is not set (create one at {your-domain}/manage/api-key)');
  if (!env.ZIP_API_URL) problems.push('ZIP_API_URL is not set (the HTN staging host is https://staging-api.zip.com)');
  return problems;
}

/** True when the write tools will be hidden: without readwrite, Zip exposes ~60 read tools instead of 131. */
export const zipIsReadOnly = (env: Record<string, string | undefined> = process.env): boolean =>
  env.ZIP_MCP_MODE !== 'readwrite';
