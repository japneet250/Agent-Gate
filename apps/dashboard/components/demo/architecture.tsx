'use client';

/**
 * The whole system, drawn from what ships.
 *
 * Compact on purpose: this sits above the thing people came to use, so it has
 * to be readable in one glance and then get out of the way. The detail that
 * earns its space is the split — a deterministic fast path beside a five-node
 * pipeline — and where the state actually lives. Everything else is a chip.
 *
 * Two deliberate departures from the spec's version: the action log is D1, not
 * Elasticsearch, and the judge is one node inside a pipeline rather than a box
 * of its own. A diagram that overstates the system is worse than none at a
 * judging table, because the first thing a judge does with a box is ask to see
 * it.
 */
const INK = '#10131a';
const LINE = '#2a3040';
const WIRE = '#3b4356';
const DIM = '#6b7689';
const MUTED = '#9aa4b8';
const PAPER = '#f2f4f8';
const ACCENT = '#5b8cff';

export function ArchitectureDiagram({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1180 296"
      className={className}
      role="img"
      aria-label="A tool call enters the AgentGate proxy and is routed either to the deterministic rule engine or to a five-node evaluation pipeline, returning allow, hold or block. Cloudflare D1 and Vectorize hold policies, vectors, sessions and the action log; a Next.js control plane reads them; LangFuse and Sentry trace every evaluation."
    >
      <defs>
        <marker id="a-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill={WIRE} />
        </marker>
        <linearGradient id="a-gate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.085" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <Box x={6} y={102} w={108} h={48} title="AI agent" sub="wants to act" />
      <Arrow x1={114} y1={126} x2={140} y2={126} />

      {/* ---------------------------------------------- interception layer */}
      <rect x={140} y={14} width={640} height={196} rx={12} fill="url(#a-gate)" stroke={ACCENT} strokeOpacity={0.32} />
      <text x={154} y={31} fill={ACCENT} fontSize={10} letterSpacing="0.09em">
        AGENTGATE
      </text>

      <Box x={154} y={102} w={110} h={48} title="Proxy" sub="MCP · HTTP" />
      <Arrow x1={264} y1={126} x2={286} y2={126} />
      <Box x={288} y={102} w={86} h={48} title="Router" sub="fast or full" />

      {/* fast path — most calls end here, and never cost a model call */}
      <path d="M374 114 C 388 114, 388 66, 402 66" fill="none" stroke="#1b7d57" strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <Box
        x={404}
        y={42}
        w={218}
        h={48}
        title="Rule engine"
        sub="PII · destructive · limits · ~1ms"
        tone="#3ddc97"
      />

      {/* full path */}
      <path d="M374 138 C 388 138, 388 116, 402 116" fill="none" stroke={WIRE} strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <rect x={404} y={104} width={218} height={98} rx={9} fill={INK} stroke={LINE} />
      <text x={414} y={118} fill={MUTED} fontSize={9.5} letterSpacing="0.07em">
        EVALUATION PIPELINE
      </text>
      <Stage y={124} label="Classifier" sub="4o-mini" />
      <Stage y={140} label="Policy retrieval" sub="Vectorize + BM25" />
      <Stage y={156} label="Risk judge" sub="4o · guardrails" accent />
      <Stage y={172} label="Decision gate" sub="thresholds" />
      <Stage y={188} label="Pattern detector" sub="cumulative" />

      <path d="M622 66 C 638 66, 638 118, 652 118" fill="none" stroke={WIRE} strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <path d="M622 152 C 638 152, 638 136, 652 136" fill="none" stroke={WIRE} strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <Box x={654} y={102} w={98} h={48} title="Decision" sub="+ reason" accent />

      {/* ------------------------------------------------------- outcomes */}
      <path d="M752 116 C 772 116, 772 58, 792 58" fill="none" stroke="#1b7d57" strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <path d="M752 126 C 772 126, 772 126, 792 126" fill="none" stroke="#8a5c0d" strokeWidth={1.4} markerEnd="url(#a-tip)" />
      <path d="M752 136 C 772 136, 772 194, 792 194" fill="none" stroke="#8f1f30" strokeWidth={1.4} markerEnd="url(#a-tip)" />

      <Outcome y={58} colour="#3ddc97" label="Allowed" sub="reaches the real tool" />
      <Outcome y={126} colour="#ffb020" label="Held" sub="human review queue" />
      <Outcome y={194} colour="#ff4d64" label="Blocked" sub="refused, with the policy" />

      {/* --------------------------------------- state, plane, telemetry */}
      <Dotted d="M470 202 L 470 238" />
      <Dotted d="M703 150 C 703 220, 640 220, 640 238" />

      <text x={6} y={252} fill={DIM} fontSize={9.5} letterSpacing="0.08em">
        PERSISTED
      </text>
      <text x={6} y={266} fill={DIM} fontSize={9.5} letterSpacing="0.08em">
        &amp; OBSERVED
      </text>

      <Chip x={90} title="Policy store" sub="D1" />
      <Chip x={254} title="Policy vectors" sub="Vectorize" />
      <Chip x={418} title="Action log · sessions" sub="D1" />
      <Chip x={582} title="Control plane" sub="Next.js dashboard" accent />
      <Chip x={746} title="LangFuse" sub="per-node traces" />
      <Chip x={910} title="Sentry" sub="errors · tracing" />
    </svg>
  );
}

const CHIP_W = 154;

function Chip({ x, title, sub, accent }: { x: number; title: string; sub: string; accent?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={236}
        width={CHIP_W}
        height={40}
        rx={8}
        fill={accent ? 'rgba(91,140,255,0.11)' : INK}
        stroke={accent ? 'rgba(91,140,255,0.42)' : LINE}
      />
      <text x={x + CHIP_W / 2} y={254} textAnchor="middle" fill={PAPER} fontSize={11.5} fontWeight={600}>
        {title}
      </text>
      <text x={x + CHIP_W / 2} y={268} textAnchor="middle" fill={DIM} fontSize={9.5}>
        {sub}
      </text>
    </g>
  );
}

function Box({
  x, y, w, h, title, sub, accent, tone,
}: {
  x: number; y: number; w: number; h: number; title: string; sub: string; accent?: boolean; tone?: string;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={9}
        fill={accent ? 'rgba(91,140,255,0.13)' : INK}
        stroke={accent ? 'rgba(91,140,255,0.5)' : tone ? `${tone}55` : LINE}
      />
      <text x={x + w / 2} y={y + 21} textAnchor="middle" fill={PAPER} fontSize={12.5} fontWeight={600}>
        {title}
      </text>
      <text x={x + w / 2} y={y + 36} textAnchor="middle" fill={tone ?? DIM} fontSize={10}>
        {sub}
      </text>
    </g>
  );
}

/** One row inside the evaluation pipeline. */
function Stage({ y, label, sub, accent }: { y: number; label: string; sub: string; accent?: boolean }) {
  return (
    <g>
      <rect x={412} y={y} width={202} height={14} rx={4} fill={accent ? 'rgba(91,140,255,0.16)' : '#151922'} />
      <text x={418} y={y + 10.5} fill={PAPER} fontSize={9.5} fontWeight={600}>
        {label}
      </text>
      <text x={608} y={y + 10.5} textAnchor="end" fill={DIM} fontSize={9}>
        {sub}
      </text>
    </g>
  );
}

function Outcome({ y, colour, label, sub }: { y: number; colour: string; label: string; sub: string }) {
  return (
    <g>
      <circle cx={802} cy={y} r={4} fill={colour} />
      <text x={815} y={y - 1} fill={PAPER} fontSize={12.5} fontWeight={600}>
        {label}
      </text>
      <text x={815} y={y + 13} fill={DIM} fontSize={10}>
        {sub}
      </text>
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={WIRE} strokeWidth={1.4} markerEnd="url(#a-tip)" />;
}

function Dotted({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={WIRE} strokeWidth={1.1} strokeDasharray="3 4" opacity={0.7} />;
}
