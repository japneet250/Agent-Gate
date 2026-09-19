/**
 * Chart color tokens — VALIDATED, not chosen by eye.
 *
 * Produced by the dataviz skill's validator:
 *   node validate_palette.js "<hex,…>" --mode dark --surface "#10131a"
 *
 * ── Decision fills (status palette, chart marks) ─────────────────────────────
 *   #229a6b allow · #c2840f escalate · #e0455c block
 *     PASS lightness band (all inside L 0.48–0.67 for dark)
 *     PASS chroma floor · PASS normal-vision floor (ΔE 17.2)
 *     PASS contrast vs surface (all ≥ 3:1)
 *     WARN CVD separation — escalate↔block ΔE 7.6 (deutan)
 *
 *   That WARN sits in the 6–8 floor band, which the method permits ONLY with
 *   secondary encoding. Every decision mark in this app ships an icon AND a
 *   text label ("Allowed" / "Escalated" / "Blocked"), so identity never rests
 *   on hue. Green/amber/red is also the one palette the audience already knows,
 *   and re-hueing a firewall's block colour to win 0.4 ΔE would cost more in
 *   comprehension than it buys. Documented rather than silently accepted.
 *
 * ── Sequential ramp (confusion matrix magnitude) ─────────────────────────────
 *   #38507d → #5d9bf2, five steps, single hue (spread 5°)
 *     PASS monotone lightness · PASS adjacent ΔL ≥ 0.06
 *     PASS light-end contrast 2.31:1 vs surface · PASS single hue
 *
 * NOTE these differ from the brighter tokens in globals.css / tailwind.config.
 * Those are TEXT and pill colours, judged by WCAG text contrast, which is a
 * different check from the categorical-fill one. Same semantics, different job.
 */

import type { Decision } from './data/types';

/** Chart-surface background these were validated against. */
export const CHART_SURFACE = '#10131a';

export const DECISION_FILL: Record<Decision, string> = {
  allow: '#229a6b',
  escalate: '#c2840f',
  block: '#e0455c',
};

/** Fixed order. Assigned by entity, never cycled, never by rank. */
export const DECISION_ORDER: Decision[] = ['allow', 'escalate', 'block'];

/** Single-hue, light→dark. Index 0 is the lightest step. */
export const SEQUENTIAL = ['#38507d', '#3d619f', '#4273c2', '#4886e2', '#5d9bf2'] as const;

/** Map a 0..1 magnitude onto the ramp. Zero gets the surface, so an empty cell
 *  reads as absent rather than as "a little bit". */
export function sequentialStep(value: number, max: number): string | null {
  if (!max || value <= 0) return null;
  const t = value / max;
  const i = Math.min(SEQUENTIAL.length - 1, Math.max(0, Math.round(t * (SEQUENTIAL.length - 1))));
  return SEQUENTIAL[i];
}

/** Recessive chrome. Grid and axes must never compete with the marks. */
export const AXIS = {
  grid: 'rgba(255,255,255,0.07)',
  tick: '#6b7689',
  line: 'rgba(255,255,255,0.12)',
};
