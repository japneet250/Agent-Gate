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

/** Two small pictures for the two ways this is installed. Same idea: show the
 *  wiring instead of describing it. */
export function McpDiagram() {
  return (
    <svg viewBox="0 0 300 64" className="w-full" role="img" aria-label="Agent connects to AgentGate over MCP; AgentGate connects to the real tool server.">
      <Node x={2} label="Claude" sub="Cursor · Codex" />
      <Wire x1={86} x2={116} />
      <Node x={118} label="AgentGate" sub="MCP proxy" accent />
      <Wire x1={202} x2={232} />
      <Node x={234} label="Tools" sub="the real server" />
    </svg>
  );
}

export function HttpDiagram() {
  return (
    <svg viewBox="0 0 300 64" className="w-full" role="img" aria-label="Your service posts each action to AgentGate before executing it.">
      <Node x={2} label="Your app" sub="any language" />
      <Wire x1={86} x2={116} dashed />
      <Node x={118} label="AgentGate" sub="POST /evaluate" accent />
      <Wire x1={202} x2={232} dashed />
      <Node x={234} label="Execute" sub="only if allowed" />
    </svg>
  );
}

function Node({ x, label, sub, accent }: { x: number; label: string; sub: string; accent?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={10}
        width={84}
        height={44}
        rx={9}
        fill={accent ? 'rgba(91,140,255,0.13)' : '#10131a'}
        stroke={accent ? 'rgba(91,140,255,0.5)' : '#2a3040'}
      />
      <text x={x + 42} y={30} textAnchor="middle" fill="#f2f4f8" fontSize="11.5" fontWeight="600">
        {label}
      </text>
      <text x={x + 42} y={44} textAnchor="middle" fill="#6b7689" fontSize="9.5">
        {sub}
      </text>
    </g>
  );
}

function Wire({ x1, x2, dashed }: { x1: number; x2: number; dashed?: boolean }) {
  return (
    <line
      x1={x1}
      y1={32}
      x2={x2}
      y2={32}
      stroke="#3b4356"
      strokeWidth="1.5"
      strokeDasharray={dashed ? '3 3' : undefined}
    />
  );
}
