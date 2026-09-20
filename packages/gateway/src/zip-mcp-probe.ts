/**
 * Read-only look at Zip's real MCP server, through the same launcher the gateway uses.
 *
 *   npm run zip:probe -w packages/gateway                      # list tools
 *   npm run zip:probe -w packages/gateway -- zip_search_vendors '{"name":"Lemon"}'
 *
 * It refuses to call anything that is not a get/list/search tool, so it cannot change
 * Zip's data. Prints variable NAMES only, never values.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZipEnv } from './env-file.js';
import { aliasZipEnv, zipProblems, zipUpstream } from './zip-upstream.js';
import { connectUpstream } from './upstream.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const READ_ONLY = /^(?:zip_)?(get|list|search)_/;

const [tool, rawArgs] = process.argv.slice(2);

loadZipEnv(path.join(REPO, '.env'));
aliasZipEnv();
const problems = zipProblems();
if (problems.length) {
  console.error(`Zip is not configured:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const via = zipUpstream();
const client = await connectUpstream({ kind: 'stdio', command: via.command, args: via.args });
try {
  if (!tool) {
    const { tools } = await client.listTools();
    const reads = tools.filter((t) => READ_ONLY.test(t.name));
    if (process.env.ZIP_PROBE_WRITES) { for (const t of tools.filter((x) => !READ_ONLY.test(x.name))) console.log(t.name); process.exit(0); }
    if (process.env.ZIP_PROBE_SCHEMA) { for (const t of tools.filter((x) => x.name.includes(process.env.ZIP_PROBE_SCHEMA!))) console.log(JSON.stringify({ name: t.name, description: t.description, input: t.inputSchema }, null, 1)); process.exit(0); }
    console.log(`${tools.length} tools, ${reads.length} read-only (get/list/search)`);
    for (const t of reads) console.log(`  ${t.name}`);
  } else {
    // A write must be named explicitly, one tool per run: ZIP_PROBE_ALLOW_WRITE=zip_update_vendor
    if (!READ_ONLY.test(tool) && process.env.ZIP_PROBE_ALLOW_WRITE !== tool) {
      console.error(`refusing to call '${tool}': only get/list/search tools are allowed here (or set ZIP_PROBE_ALLOW_WRITE=${tool})`);
      process.exit(2);
    }
    const res = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    console.log(JSON.stringify(res, null, 2));
  }
} finally {
  await client.close();
}
