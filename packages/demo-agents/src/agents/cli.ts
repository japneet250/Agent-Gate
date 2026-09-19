import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolveEvaluate } from '@agentgate/evals/engine';
import { PERSONAS, type PersonaName, type RunMode } from './personas.js';
import { runAgent, runScript, type RunResult } from './agent.js';
import { passThroughGate, type ToolGate } from './gate.js';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

function usage(): never {
  console.error(
    [
      'Usage: npm run agent -w @agentgate/demo-agents -- --agent=<support|procurement|coding> [options]',
      '',
      '  --agent=<name>     support | procurement | coding   (default: support)',
      '  --mode=<mode>      safe | dangerous                 (default: safe)',
      '  --gate=<gate>      stub | off                       (default: stub)',
      '  --llm              drive with a real OpenAI tool-calling loop (needs OPENAI_API_KEY)',
      '  --json             print the run result as JSON',
    ].join('\n'),
  );
  process.exit(1);
}

function summarise(result: RunResult) {
  const counts = { allow: 0, escalate: 0, block: 0 };
  for (const s of result.steps) counts[s.evaluation.decision]++;
  console.log(
    `\n${result.steps.length} tool call(s): ${counts.allow} allowed, ${counts.escalate} escalated, ${counts.block} blocked.`,
  );
  if (result.finalMessage) console.log(`\nAgent: ${result.finalMessage}`);
}

async function main() {
  const personaName = (arg('agent', 'support') ?? 'support') as PersonaName;
  const mode = (arg('mode', 'safe') ?? 'safe') as RunMode;
  const gateKind = arg('gate', 'stub');

  const persona = PERSONAS[personaName];
  if (!persona) usage();
  if (mode !== 'safe' && mode !== 'dangerous') usage();

  let gate: ToolGate = passThroughGate;
  let gateLabel = 'off (pass-through)';
  if (gateKind !== 'off') {
    const { evaluate, kind } = await resolveEvaluate();
    gate = evaluate;
    gateLabel = kind === 'stub' ? 'stub engine' : 'real engine (P2)';
  }

  const sessionId = randomUUID();
  console.log(
    `\n=== ${persona.agentId} | mode=${mode} | gate=${gateLabel} | session=${sessionId.slice(0, 8)} ===\n`,
  );

  const opts = { agentId: persona.agentId, server: persona.server, sessionId, gate };

  const result = flag('llm')
    ? await runAgent({
        ...opts,
        task: persona.tasks[mode],
        systemPrompt: persona.systemPrompt,
      })
    : await runScript(opts, persona.scripts[mode]);

  if (flag('json')) console.log(JSON.stringify(result, null, 2));
  else summarise(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
