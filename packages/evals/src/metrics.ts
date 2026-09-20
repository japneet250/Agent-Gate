import type { Decision } from '@agentgate/shared-types';

export const DECISIONS: Decision[] = ['allow', 'escalate', 'block'];

export type ClassMetrics = {
  decision: Decision;
  support: number;
  predicted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
};

export type Metrics = {
  total: number;
  correct: number;
  accuracy: number;
  perClass: ClassMetrics[];
  macroF1: number;
  weightedF1: number;
  /** confusion[expected][predicted] */
  confusion: Record<Decision, Record<Decision, number>>;
};

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

export function computeMetrics(
  pairs: Array<{ expected: Decision; predicted: Decision }>,
): Metrics {
  const confusion = Object.fromEntries(
    DECISIONS.map((e) => [e, Object.fromEntries(DECISIONS.map((p) => [p, 0]))]),
  ) as Metrics['confusion'];

  for (const { expected, predicted } of pairs) confusion[expected][predicted]++;

  const perClass = DECISIONS.map((d): ClassMetrics => {
    const truePositives = confusion[d][d];
    const support = DECISIONS.reduce((n, p) => n + confusion[d][p], 0);
    const predictedCount = DECISIONS.reduce((n, e) => n + confusion[e][d], 0);
    const falsePositives = predictedCount - truePositives;
    const falseNegatives = support - truePositives;
    const precision = ratio(truePositives, predictedCount);
    const recall = ratio(truePositives, support);
    return {
      decision: d,
      support,
      predicted: predictedCount,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1: ratio(2 * precision * recall, precision + recall),
    };
  });

  const total = pairs.length;
  const correct = DECISIONS.reduce((n, d) => n + confusion[d][d], 0);

  // Macro-averages only over classes that actually appear in this slice --
  // otherwise a safe-only subset scores 0.33 for being perfect.
  const present = perClass.filter((c) => c.support > 0 || c.predicted > 0);

  return {
    total,
    correct,
    accuracy: ratio(correct, total),
    perClass,
    macroF1: ratio(
      present.reduce((n, c) => n + c.f1, 0),
      present.length,
    ),
    weightedF1: ratio(
      perClass.reduce((n, c) => n + c.f1 * c.support, 0),
      total,
    ),
    confusion,
  };
}
