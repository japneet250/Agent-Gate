'use client';

/**
 * The whole product in one picture.
 *
 * Three paragraphs explaining interception is a slide. One diagram with a
 * packet moving through a gate, splitting three ways, is the mechanism — and a
 * room reads it in two seconds from the back.
 *
 * Deliberately plain SVG: no chart library, no layout thrash, and it scales to
 * a projector without going fuzzy.
 */
export function FlowDiagram({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 680 150"
      className={className}
      role="img"
      aria-label="An agent's tool call passes through AgentGate, which allows, holds, or blocks it."
    >
      <defs>
        <linearGradient id="gate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#5b8cff" stopOpacity="0.08" />
        </linearGradient>
        <marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#3b4356" />
        </marker>
      </defs>

      {/* agent */}
      <g>
        <rect x="6" y="52" width="122" height="46" rx="10" fill="#10131a" stroke="#2a3040" />
        <text x="67" y="72" textAnchor="middle" fill="#f2f4f8" fontSize="13" fontWeight="600">
          AI agent
        </text>
        <text x="67" y="88" textAnchor="middle" fill="#6b7689" fontSize="10.5">
          wants to act
        </text>
      </g>

      <line x1="132" y1="75" x2="196" y2="75" stroke="#2a3040" strokeWidth="1.5" markerEnd="url(#tip)" />
      {/* the packet in flight: the only motion on the page, so the eye goes
          exactly where the explanation is */}
      <circle r="3.5" fill="#5b8cff">
        <animate attributeName="cx" values="134;192" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="cy" values="75;75" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;1;0" dur="1.8s" repeatCount="indefinite" />
      </circle>

      {/* the gate */}
      <g>
        <rect x="202" y="34" width="150" height="82" rx="12" fill="url(#gate)" stroke="#5b8cff" strokeOpacity="0.45" />
        <text x="277" y="60" textAnchor="middle" fill="#f2f4f8" fontSize="13" fontWeight="600">
          AgentGate
        </text>
        <text x="277" y="78" textAnchor="middle" fill="#9aa4b8" fontSize="10.5">
          rules · ~1ms
        </text>
        <text x="277" y="94" textAnchor="middle" fill="#9aa4b8" fontSize="10.5">
          judge · RAG + policy
        </text>
      </g>

      {/* three outcomes */}
      <path d="M356 62 C 404 62, 404 30, 448 30" fill="none" stroke="#1b7d57" strokeWidth="1.5" markerEnd="url(#tip)" />
      <path d="M356 75 C 404 75, 404 75, 448 75" fill="none" stroke="#8a5c0d" strokeWidth="1.5" markerEnd="url(#tip)" />
      <path d="M356 88 C 404 88, 404 120, 448 120" fill="none" stroke="#8f1f30" strokeWidth="1.5" markerEnd="url(#tip)" />

      <Outcome y={30} colour="#3ddc97" label="Allowed" sub="reaches the tool" />
      <Outcome y={75} colour="#ffb020" label="Held" sub="waits for a human" />
      <Outcome y={120} colour="#ff4d64" label="Blocked" sub="never runs" />
    </svg>
  );
}

function Outcome({ y, colour, label, sub }: { y: number; colour: string; label: string; sub: string }) {
  return (
    <g>
      <circle cx="462" cy={y} r="4" fill={colour} />
      <text x="476" y={y - 1} fill="#f2f4f8" fontSize="12.5" fontWeight="600">
        {label}
      </text>
      <text x="476" y={y + 13} fill="#6b7689" fontSize="10.5">
        {sub}
      </text>
    </g>
  );
}

/**
 * Two small pictures for the two ways this is installed.
 *
 * The viewBox is wide relative to its contents on purpose. These sit in a card
 * roughly 900px across; a narrow viewBox scales every glyph up with it, which
 * is how the first version ended up looking zoomed in AND clipping its last
 * node off the right edge. Sizing the canvas near the rendered width keeps the
 * scale factor close to 1 and the labels at a sane size.
 */
const NODE_W = 170;
const NODE_H = 58;
const ROW_Y = 22;

export function McpDiagram() {
  return (
    <svg
      viewBox="0 0 760 102"
      className="w-full"
      role="img"
      aria-label="The agent connects to AgentGate over MCP, and AgentGate connects to the real tool server."
    >
      <Node x={10} label="Claude" sub="Cursor · Codex" />
      <Wire x1={NODE_W + 10} x2={295} label="MCP" />
      <Node x={295} label="AgentGate" sub="MCP proxy" accent />
      <Wire x1={295 + NODE_W} x2={580} label="MCP" />
      <Node x={580} label="Tools" sub="the real server" />
    </svg>
  );
}

export function HttpDiagram() {
  return (
    <svg
      viewBox="0 0 760 102"
      className="w-full"
      role="img"
      aria-label="Your service posts each action to AgentGate before executing it."
    >
      <Node x={10} label="Your app" sub="any language" />
      <Wire x1={NODE_W + 10} x2={295} label="POST" dashed />
      <Node x={295} label="AgentGate" sub="/evaluate" accent />
      <Wire x1={295 + NODE_W} x2={580} label="allow" dashed />
      <Node x={580} label="Execute" sub="only if allowed" />
    </svg>
  );
}

function Node({ x, label, sub, accent }: { x: number; label: string; sub: string; accent?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={ROW_Y}
        width={NODE_W}
        height={NODE_H}
        rx={11}
        fill={accent ? 'rgba(91,140,255,0.13)' : '#10131a'}
        stroke={accent ? 'rgba(91,140,255,0.5)' : '#2a3040'}
      />
      <text x={x + NODE_W / 2} y={ROW_Y + 26} textAnchor="middle" fill="#f2f4f8" fontSize="16" fontWeight="600">
        {label}
      </text>
      <text x={x + NODE_W / 2} y={ROW_Y + 44} textAnchor="middle" fill="#6b7689" fontSize="12.5">
        {sub}
      </text>
    </g>
  );
}

function Wire({ x1, x2, label, dashed }: { x1: number; x2: number; label?: string; dashed?: boolean }) {
  const mid = (x1 + x2) / 2;
  const y = ROW_Y + NODE_H / 2;
  return (
    <g>
      <line
        x1={x1 + 6}
        y1={y}
        x2={x2 - 6}
        y2={y}
        stroke="#3b4356"
        strokeWidth="1.5"
        strokeDasharray={dashed ? '4 4' : undefined}
      />
      {label && (
        <text x={mid} y={y - 9} textAnchor="middle" fill="#6b7689" fontSize="11">
          {label}
        </text>
      )}
    </g>
  );
}

/**
 * The evaluation pipeline, drawn once so the latency bars underneath it mean
 * something.
 *
 * A list of node names and millisecond figures is data without a shape. With
 * the graph above it, "risk judge 942ms, 39%" reads as a position in a pipeline
 * rather than a row in a table — and the fast-path bypass explains, without a
 * sentence, why most calls never cost a model call at all.
 */
export function PipelineDiagram({ className = '' }: { className?: string }) {
  const STAGE_W = 118;
  const gap = 22;
  const x = (i: number) => 8 + i * (STAGE_W + gap);
  const stages = [
    { label: 'Classifier', sub: 'gpt-4o-mini' },
    { label: 'Retrieval', sub: 'vector + BM25' },
    { label: 'Risk judge', sub: 'gpt-4o' },
    { label: 'Decision gate', sub: 'thresholds' },
    { label: 'Pattern', sub: 'cumulative' },
  ];

  return (
    <svg
      viewBox="0 0 790 128"
      className={className}
      role="img"
      aria-label="An action enters the classifier; simple cases take the rule-engine fast path, the rest pass through retrieval, the judge, the decision gate and the pattern detector."
    >
      <defs>
        <marker id="ptip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#3b4356" />
        </marker>
      </defs>

      {/* the slow path */}
      {stages.map((s, i) => (
        <g key={s.label}>
          <rect
            x={x(i)}
            y={46}
            width={STAGE_W}
            height={44}
            rx={9}
            fill={i === 2 ? 'rgba(91,140,255,0.13)' : '#10131a'}
            stroke={i === 2 ? 'rgba(91,140,255,0.45)' : '#2a3040'}
          />
          <text x={x(i) + STAGE_W / 2} y={66} textAnchor="middle" fill="#f2f4f8" fontSize="12.5" fontWeight="600">
            {s.label}
          </text>
          <text x={x(i) + STAGE_W / 2} y={81} textAnchor="middle" fill="#6b7689" fontSize="10.5">
            {s.sub}
          </text>
          {i < stages.length - 1 && (
            <line
              x1={x(i) + STAGE_W}
              y1={68}
              x2={x(i + 1) - 4}
              y2={68}
              stroke="#3b4356"
              strokeWidth="1.5"
              markerEnd="url(#ptip)"
            />
          )}
        </g>
      ))}

      {/* the fast path: most calls are decided here and never reach a model */}
      <path
        d={`M ${x(0) + STAGE_W / 2} 46 C ${x(0) + STAGE_W / 2} 14, ${x(3) + STAGE_W / 2} 14, ${x(3) + STAGE_W / 2} 46`}
        fill="none"
        stroke="#1b7d57"
        strokeWidth="1.5"
        strokeDasharray="4 4"
        markerEnd="url(#ptip)"
      />
      <text x={(x(0) + x(3)) / 2 + STAGE_W / 2} y={12} textAnchor="middle" fill="#3ddc97" fontSize="11">
        rule engine · ~1ms · no model
      </text>

      {/* the outcome */}
      <line x1={x(4) + STAGE_W} y1={68} x2={x(4) + STAGE_W + 26} y2={68} stroke="#3b4356" strokeWidth="1.5" />
      <text x={x(4) + STAGE_W + 32} y={64} fill="#f2f4f8" fontSize="12" fontWeight="600">
        Verdict
      </text>
      <text x={x(4) + STAGE_W + 32} y={78} fill="#6b7689" fontSize="10.5">
        + reason
      </text>

      <text x={8} y={110} fill="#6b7689" fontSize="10.5">
        Every stage degrades rather than failing. A firewall that cannot judge does not allow.
      </text>
    </svg>
  );
}
