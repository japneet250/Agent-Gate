import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadZipEnv, parseEnv } from './env-file.js';
import { aliasZipEnv, zipIsReadOnly, zipProblems, zipUpstream } from './zip-upstream.js';

const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe('zipUpstream', () => {
  it("uses Zip's documented `uv run --with ziphq-mcp ziphq-mcp` when uv is on the PATH", () => {
    const r = zipUpstream({ PATH: '/usr/bin:/opt/tools', HOME: '/h' }, has('/opt/tools/uv'));
    assert.deepEqual(r, { command: '/opt/tools/uv', args: ['run', '--with', 'ziphq-mcp', 'ziphq-mcp'], via: 'uv' });
  });

  it('finds uv in the usual install spots even when the PATH is Claude Desktop-minimal', () => {
    const r = zipUpstream({ PATH: '/usr/bin:/bin', HOME: '/h' }, has('/opt/homebrew/bin/uv'));
    assert.equal(r.via, 'uv');
    assert.equal(r.command, '/opt/homebrew/bin/uv');
  });

  it('falls back to a `uv tool install`ed binary', () => {
    const r = zipUpstream({ PATH: '/usr/bin', HOME: '/h' }, has('/h/.local/bin/ziphq-mcp'));
    assert.deepEqual(r, { command: '/h/.local/bin/ziphq-mcp', args: [], via: 'binary' });
  });

  it('honours ZIP_MCP_COMMAND over everything', () => {
    const r = zipUpstream({ ZIP_MCP_COMMAND: '/x/python -m ziphq_mcp', PATH: '/usr/bin' }, has('/usr/bin/uv'));
    assert.deepEqual(r, { command: '/x/python', args: ['-m', 'ziphq_mcp'], via: 'env' });
  });

  it('still names uv when nothing is installed, so the error says what to install', () => {
    const r = zipUpstream({ PATH: '/usr/bin', HOME: '/h' }, () => false);
    assert.equal(r.via, 'missing');
    assert.equal(r.command, 'uv');
  });
});

describe('aliasZipEnv', () => {
  it('lets the engine-style names (ZIP_API_TOKEN / ZIP_API_BASE) satisfy ziphq-mcp', () => {
    const env: Record<string, string | undefined> = { ZIP_API_TOKEN: 't', ZIP_API_BASE: 'https://staging-api.zip.com/' };
    assert.deepEqual(aliasZipEnv(env).sort(), ['ZIP_API_KEY', 'ZIP_API_URL']);
    assert.equal(env.ZIP_API_KEY, 't');
    assert.equal(env.ZIP_API_URL, 'https://staging-api.zip.com', 'trailing slash removed');
    assert.equal(zipProblems(env).length, 0);
  });

  it('works the other way round, for the doc-style names', () => {
    const env: Record<string, string | undefined> = { ZIP_API_KEY: 'k', ZIP_API_URL: 'https://staging-api.zip.com' };
    assert.deepEqual(aliasZipEnv(env).sort(), ['ZIP_API_BASE', 'ZIP_API_TOKEN']);
    assert.equal(env.ZIP_API_TOKEN, 'k');
  });

  it('never overrides a value that is already set, and returns names only', () => {
    const env: Record<string, string | undefined> = { ZIP_API_KEY: 'doc', ZIP_API_TOKEN: 'engine', ZIP_API_URL: 'u', ZIP_API_BASE: 'b' };
    assert.deepEqual(aliasZipEnv(env), []);
    assert.equal(env.ZIP_API_KEY, 'doc');
    assert.equal(env.ZIP_API_TOKEN, 'engine');
    const names = aliasZipEnv({ ZIP_API_TOKEN: 'secret-value' });
    assert.ok(!names.join().includes('secret-value'));
  });
});

describe('zip preflight', () => {
  it('names each missing variable', () => {
    assert.equal(zipProblems({ ZIP_API_KEY: 'k', ZIP_API_URL: 'https://x' }).length, 0);
    assert.match(zipProblems({ ZIP_API_URL: 'https://x' }).join(), /ZIP_API_KEY/);
    assert.match(zipProblems({ ZIP_API_KEY: 'k' }).join(), /ZIP_API_URL/);
  });

  it('flags read-only mode, which hides the write tools', () => {
    assert.equal(zipIsReadOnly({}), true);
    assert.equal(zipIsReadOnly({ ZIP_MCP_MODE: 'read' }), true);
    assert.equal(zipIsReadOnly({ ZIP_MCP_MODE: 'readwrite' }), false);
  });
});

describe('env file', () => {
  it('parses export, quotes and comments', () => {
    const env = parseEnv(
      ['# comment', 'A=1', 'export B="two words"', "C='x'", 'D=val # trailing', 'E=', '  F = spaced  ', 'not a line'].join('\n'),
    );
    assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'val', E: '', F: 'spaced' });
  });

  it('loads only ZIP_* names, never overrides, and returns names not values', () => {
    const env: Record<string, string | undefined> = { ZIP_API_URL: 'already-set' };
    const names = loadZipEnv(
      '/repo/.env',
      env,
      () => 'ZIP_API_KEY=secret\nZIP_API_URL=from-file\nSENTRY_DSN=nope\nZIP_MCP_MODE=readwrite\nZIP_EMPTY=',
    );
    assert.deepEqual(names.sort(), ['ZIP_API_KEY', 'ZIP_MCP_MODE']);
    assert.equal(env.ZIP_API_KEY, 'secret');
    assert.equal(env.ZIP_API_URL, 'already-set', 'an existing variable wins');
    assert.equal(env.SENTRY_DSN, undefined, 'non-Zip settings are left alone');
    assert.ok(!names.join().includes('secret'), 'names only');
  });

  it('treats a missing file as nothing to load', () => {
    assert.deepEqual(loadZipEnv('/nope/.env', {}, () => { throw new Error('ENOENT'); }), []);
  });
});
