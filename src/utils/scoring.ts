// Spec §4: a pillar score is the plain average of its four sub-metrics.
// No weights, no composite across pillars.
import { PILLAR_METRICS, PILLARS, type Pillar, type PillarData } from "../types/company.js";

export function assertScore(score: unknown, label = "score"): asserts score is number {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError(`${label} must be a number between 0 and 100, got ${String(score)}`);
  }
}

export function calculatePillarScore(metrics: readonly number[]): number {
  if (metrics.length !== 4) throw new RangeError(`a pillar needs exactly 4 sub-metrics, got ${metrics.length}`);
  metrics.forEach((m, i) => assertScore(m, `sub-metric ${i}`));
  return metrics.reduce((a, b) => a + b, 0) / 4;
}

export function calculateCompanyScores(data: Record<Pillar, PillarData>): Record<Pillar, number> {
  return Object.fromEntries(
    PILLARS.map((pillar) => {
      const scores = PILLAR_METRICS[pillar].map(({ key }) => {
        const score = data[pillar]?.metrics?.[key]?.score;
        assertScore(score, `${pillar}.${key}`);
        return score;
      });
      return [pillar, calculatePillarScore(scores)];
    }),
  ) as Record<Pillar, number>;
}
