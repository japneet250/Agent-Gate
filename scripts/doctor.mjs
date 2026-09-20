/**
 * Version-drift check. Run `npm run doctor`.
 *
 * Drift between P1/P2/P3 on Node and the three pinned SDK majors is the most
 * likely cause of a merge that installs for one of us and not the others, so
 * this reports it in one command rather than leaving it to be discovered.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// A dependency may be hoisted to the root or kept under its own workspace, so
// look in both. Read package.json off disk rather than through require(): most
// modern packages have an `exports` map that refuses to expose it.
const searchDirs = [path.join(root, 'node_modules')];
for (const dir of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
  if (dir.isDirectory()) {
    searchDirs.push(path.join(root, 'packages', dir.name, 'node_modules'));
  }
}

function resolvePackageJson(name) {
  for (const dir of searchDirs) {
    const file = path.join(dir, ...name.split('/'), 'package.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

const expectedNode = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const actualNode = process.versions.node;

/** package -> the major we have agreed on. */
const PINNED = {
  '@sentry/node': 10,
  '@google/genai': 2,
  mongodb: 6,
  langfuse: 3,
  openai: 4,
};

const rows = [];
let problems = 0;

const nodeOk = actualNode === expectedNode;
if (!nodeOk) problems++;
rows.push({
  what: 'node',
  want: expectedNode,
  got: actualNode,
  note: nodeOk ? 'ok' : 'MISMATCH — see .nvmrc',
});

for (const [name, major] of Object.entries(PINNED)) {
  let got = '(not installed)';
  let note = 'MISSING — run npm install';
  const pkg = resolvePackageJson(name);
  if (!pkg) {
    problems++;
  } else {
    got = pkg.version;
    const gotMajor = Number(got.split('.')[0]);
    const engineNode = pkg.engines?.node;
    if (gotMajor !== major) {
      note = `MAJOR DRIFT — expected v${major}`;
      problems++;
    } else if (engineNode && !satisfiesLoose(actualNode, engineNode)) {
      note = `runs, but declares node ${engineNode}`;
    } else {
      note = 'ok';
    }
  }
  rows.push({ what: name, want: `v${major}`, got, note });
}

/** Deliberately loose: only handles the `>=X` form these packages use. */
function satisfiesLoose(version, range) {
  const m = /^>=\s*(\d+)/.exec(range.trim());
  if (!m) return true;
  return Number(version.split('.')[0]) >= Number(m[1]);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\nAgentGate version check\n');
console.log(`  ${pad('what', 18)}${pad('pinned', 10)}${pad('installed', 18)}note`);
for (const r of rows) {
  console.log(`  ${pad(r.what, 18)}${pad(r.want, 10)}${pad(r.got, 18)}${r.note}`);
}
console.log(
  problems === 0
    ? '\n  no drift\n'
    : `\n  ${problems} problem(s) — match .nvmrc and the pinned majors before merging\n`,
);
process.exit(problems === 0 ? 0 : 1);
