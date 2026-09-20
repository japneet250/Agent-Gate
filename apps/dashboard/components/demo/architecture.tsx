'use client';

/**
 * The whole system, at the depth the spec's architecture diagram works at —
 * but drawn from what actually ships.
 *
 * Two deliberate departures from the spec's version: the action log is D1, not
 * Elasticsearch, and the judge sits inside a five-node pipeline rather than
 * being a single box. A diagram that overstates the system is worse than none
 * at a judging table, because the first question a judge asks about a box is
 * "show me".
 *
 * Full width on purpose. At hero width every glyph in here would scale down
 * past legibility; this needs the whole row.
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
      viewBox="0 0 1280 462"
      className={className}
      role="img"
      aria-label="An agent's tool call enters the AgentGate proxy, is routed to either the deterministic rule engine or the five-node evaluation pipeline, and returns allow, hold or block. Cloudflare D1 and Vectorize hold policies, vectors, sessions and the action log; the Next.js control plane reads them; LangFuse and Sentry trace every evaluation."
    >
      <defs>
        <marker id="a-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill={WIRE} />
        </marker>
        <linearGradient id="a-gate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.09" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* ---------------------------------------------- interception layer */}
      <rect x={150} y={18} width={812} height={286} rx={14} fill="url(#a-gate)" stroke={ACCENT} strokeOpacity={0.35} />
      <text x={166} y={38} fill={ACCENT} fontSize={11.5} letterSpacing="0.08em">
        AGENTGATE — INTERCEPTION LAYER
      </text>

      <Box x={10} y={150} w={124} h={62} title="AI agent" sub="wants to act" />
      <Arrow x1={134} y1={181} x2={168} y2={181} />

      <Box x={170} y={150} w={134} h={62} title="Proxy" sub="MCP · HTTP" />
      <Arrow x1={304} y1={181} x2={336} y2={181} />

      <Box x={338} y={150} w={104} h={62} title="Router" sub="fast or full" />

      {/* fast path */}
      <path d={`M442 166 C 470 166, 470 96, 500 96`} fill="none" stroke="#1b7d57" strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <text x={452} y={128} fill="#3ddc97" fontSize={10.5}>
        fast
      </text>
      <Box
        x={502}
        y={64}
        w={266}
        h={62}
        title="Rule engine"
        sub="PII · destructive · limits · rate"
        note="~1ms · no model call"
        tone="#3ddc97"
      />

      {/* full path */}
      <path d={`M442 196 C 470 196, 470 232, 500 232`} fill="none" stroke={WIRE} strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <text x={450} y={226} fill={DIM} fontSize={10.5}>
        complex
      </text>

      <rect x={502} y={146} width={266} height={142} rx={10} fill={INK} stroke={LINE} />
      <text x={514} y={163} fill={MUTED} fontSize={10.5} letterSpacing="0.06em">
        EVALUATION PIPELINE
      </text>
      <Stage y={172} label="Classifier" sub="gpt-4o-mini" />
      <Stage y={196} label="Policy retrieval" sub="Vectorize + BM25" />
      <Stage y={220} label="Risk judge" sub="gpt-4o · guardrails" accent />
      <Stage y={244} label="Decision gate" sub="risk thresholds" />
      <Stage y={268} label="Pattern detector" sub="cumulative limits" />

      {/* converge on the decision */}
      <path d={`M768 96 C 800 96, 800 160, 824 160`} fill="none" stroke={WIRE} strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <path d={`M768 216 C 800 216, 800 190, 824 190`} fill="none" stroke={WIRE} strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <Box x={826} y={144} w={118} h={62} title="Decision" sub="+ reason" accent />

      {/* ------------------------------------------------------- outcomes */}
      <path d={`M944 162 C 972 162, 972 84, 996 84`} fill="none" stroke="#1b7d57" strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <path d={`M944 175 C 972 175, 972 175, 996 175`} fill="none" stroke="#8a5c0d" strokeWidth={1.6} markerEnd="url(#a-tip)" />
      <path d={`M944 188 C 972 188, 972 266, 996 266`} fill="none" stroke="#8f1f30" strokeWidth={1.6} markerEnd="url(#a-tip)" />

      <Outcome y={84} colour="#3ddc97" label="Allowed" sub="forwarded to the real tool" />
      <Outcome y={175} colour="#ffb020" label="Held" sub="human review queue" />
      <Outcome y={266} colour="#ff4d64" label="Blocked" sub="refused, with the policy" />

      {/* --------------------------------------------------- data + planes */}
      <Group x={150} y={330} w={474} h={112} label="DATA — CLOUDFLARE" />
      <Store x={168} y={366} w={136} title="Policy store" sub="D1" />
      <Store x={316} y={366} w={140} title="Policy vectors" sub="Vectorize" />
      <Store x={468} y={366} w={140} title="Action log · sessions" sub="D1" />

      <Group x={644} y={330} w={318} h={112} label="CONTROL PLANE" />
      <Box x={662} y={366} w={282} h={54} title="Dashboard — Next.js" sub="feed · analytics · policies · review" />

      <Group x={982} y={330} w={288} h={112} label="OBSERVABILITY" />
      <Box x={1000} y={366} w={124} h={54} title="LangFuse" sub="per-node traces" />
      <Box x={1136} y={366} w={116} h={54} title="Sentry" sub="errors" />

      {/* dotted: what reads and writes what */}
      <Dotted d="M560 288 L 560 366" />
      <Dotted d="M386 212 C 386 300, 236 300, 236 366" />
      <Dotted d="M885 206 C 885 300, 538 300, 538 366" />
      <Dotted d="M803 366 L 803 304" />
      <Dotted d="M1062 366 C 1062 300, 700 300, 700 290" />
    </svg>
  );
}

function Box({
  x, y, w, h, title, sub, note, accent, tone,
}: {
  x: number; y: number; w: number; h: number;
  title: string; sub: string; note?: string; accent?: boolean; tone?: string;
}) {
  const stroke = accent ? 'rgba(91,140,255,0.5)' : tone ? `${tone}55` : LINE;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={accent ? 'rgba(91,140,255,0.13)' : INK} stroke={stroke} />
      <text x={x + w / 2} y={y + (note ? 24 : h / 2 + 1)} textAnchor="middle" fill={PAPER} fontSize={14} fontWeight={600}>
        {title}
      </text>
      <text x={x + w / 2} y={y + (note ? 40 : h / 2 + 17)} textAnchor="middle" fill={DIM} fontSize={11}>
        {sub}
      </text>
      {note && (
        <text x={x + w / 2} y={y + 54} textAnchor="middle" fill={tone ?? MUTED} fontSize={10.5}>
          {note}
        </text>
      )}
    </g>
  );
}

/** One row inside the evaluation pipeline. */
function Stage({ y, label, sub, accent }: { y: number; label: string; sub: string; accent?: boolean }) {
  return (
    <g>
      <rect x={514} y={y} width={242} height={20} rx={5} fill={accent ? 'rgba(91,140,255,0.16)' : '#151922'} />
      <text x={522} y={y + 14} fill={PAPER} fontSize={11.5} fontWeight={600}>
        {label}
      </text>
      <text x={748} y={y + 14} textAnchor="end" fill={DIM} fontSize={10.5}>
        {sub}
      </text>
    </g>
  );
}

function Outcome({ y, colour, label, sub }: { y: number; colour: string; label: string; sub: string }) {
  return (
    <g>
      <circle cx={1008} cy={y} r={4.5} fill={colour} />
      <text x={1022} y={y - 1} fill={PAPER} fontSize={14} fontWeight={600}>
        {label}
      </text>
      <text x={1022} y={y + 15} fill={DIM} fontSize={11}>
        {sub}
      </text>
    </g>
  );
}

function Group({ x, y, w, h, label }: { x: number; y: number; w: number; h: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} fill="#0b0d12" stroke={LINE} />
      <text x={x + 16} y={y + 20} fill={MUTED} fontSize={10.5} letterSpacing="0.08em">
        {label}
      </text>
    </g>
  );
}

function Store({ x, y, w, title, sub }: { x: number; y: number; w: number; title: string; sub: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={54} rx={8} fill={INK} stroke={LINE} />
      <ellipse cx={x + w / 2} cy={y + 8} rx={w / 2 - 1} ry={5} fill="#151922" stroke={LINE} />
      <text x={x + w / 2} y={y + 30} textAnchor="middle" fill={PAPER} fontSize={12.5} fontWeight={600}>
        {title}
      </text>
      <text x={x + w / 2} y={y + 45} textAnchor="middle" fill={DIM} fontSize={10.5}>
        {sub}
      </text>
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={WIRE} strokeWidth={1.6} markerEnd="url(#a-tip)" />;
}

function Dotted({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={WIRE} strokeWidth={1.2} strokeDasharray="3 4" opacity={0.75} />;
}
