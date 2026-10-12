// Recommendations (spec §1 "turning the gaps into prioritized, specific recommendations, benchmarked
// against the client's actual competitors"; §3 "one per actionable finding"; §5 recommendation text
// is LLM-written).
//
// Deterministic, from the scoring checks already collected:
//  - one candidate per sub-metric with weak checks (measured, value < 1); unknown checks never count;
//  - current = the sub-metric score; target = its score if those checks were fully met (rubric);
//  - impact = how far the best other company in the comparison set scores above it on that
//    sub-metric: ≥ 20 high, ≥ 10 medium, else low (the dashboard's existing thresholds,
//    front/lib/mock-data/build.ts). With no scored competitor, the points recoverable
//    (target − current) are used instead.
// The LLM only words title / explanation / action, citing the weak checks; a cited id outside them
// or a number not in the facts drops the wording for a deterministic one built from the checks.

import { z } from "zod";
import { getLlmProvider, type LlmProvider } from "./llm.service.js";
import { scoreChecks, type Check } from "./scoring/rubric.js";
import { numbers } from "./scoring/evidence.js";
import { PILLAR_METRICS, PILLARS, type Pillar, type PillarData, type RecommendationItem } from "../types/company.js";

export const IMPACT_GAP = { high: 20, medium: 10 } as const;

const PILLAR_LABEL: Record<Pillar, string> = { seo: "SEO", aeo: "AEO", geo: "GEO" };

export interface BenchmarkCompany {
  name: string;
  domain: string;
  pillars: Record<Pillar, PillarData>;
}

export interface Candidate {
  pillar: Pillar;
  key: string;
  label: string;
  current: number;
  target: number;
  impact: RecommendationItem["impact"];
  /** Best other company on this sub-metric; null with no scored competitor. */
  leader: { name: string; score: number } | null;
  weak: Check[];
}

const checksOf = (data: PillarData, key: string): Check[] => ((data.metrics[key]?.signals ?? {}) as { checks?: Check[] }).checks ?? [];

export function impactFor(points: number): RecommendationItem["impact"] {
  return points >= IMPACT_GAP.high ? "high" : points >= IMPACT_GAP.medium ? "medium" : "low";
}

/** Sub-metrics with weak checks, with their deterministic numbers, highest impact and gain first. */
export function recommendationCandidates(pillars: Record<Pillar, PillarData>, others: BenchmarkCompany[]): Candidate[] {
  const out: Candidate[] = [];
  for (const pillar of PILLARS) {
    for (const { key, label } of PILLAR_METRICS[pillar]) {
      const checks = checksOf(pillars[pillar], key);
      const weak = checks.filter((c) => c.value !== null && c.value < 1);
      const current = pillars[pillar].metrics[key]?.score;
      if (!weak.length || current === undefined) continue;
      const target = scoreChecks(checks.map((c) => (weak.includes(c) ? { ...c, value: 1 } : c)));
      const scored = others
        .map((o) => ({ name: o.name, score: o.pillars[pillar].metrics[key]?.score }))
        .filter((o): o is { name: string; score: number } => typeof o.score === "number");
      const leader = scored.length ? scored.reduce((a, b) => (b.score > a.score ? b : a)) : null;
      const impact = impactFor(leader ? leader.score - current : target - current);
      out.push({ pillar, key, label, current, target, impact, leader, weak });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.impact] - rank[b.impact] || b.target - b.current - (a.target - a.current));
}

export const recommendationSchema = z.object({
  recommendations: z
    .array(
      z.object({
        metricKey: z.string(),
        checkIds: z.array(z.string()).min(1).max(6),
        title: z.string().trim().min(5).max(90),
        explanation: z.string().trim().min(10).max(400),
        action: z.string().trim().min(10).max(300),
      }),
    )
    .max(12),
});

const SYSTEM = `You write the recommendations section of an SEO / AEO / GEO scorecard for one company.

You get the sub-metrics where the company has weak checks. Each has the company's score, the best competitor's score on it (or null), and the weak checks: id, label, value (0 = not met, between 0 and 1 = partly met) and a detail saying what was observed.

Write exactly one recommendation per sub-metric:
- metricKey: exactly as given.
- checkIds: the ids of the weak checks it addresses (only ids listed under that sub-metric).
- title: a short imperative, max ~10 words, e.g. "Add FAQPage schema to the homepage".
- explanation: one or two factual sentences: what the checks found missing, and how the company compares with the best competitor when one is given. Only facts from the input.
- action: one concrete next step that would make the cited checks pass.
Do not use numbers that are not in the input. Do not promise rankings, traffic or citations. When a sub-metric is marked as a proxy, do not claim more than it measured.`;

function factsText(c: Candidate) {
  return [c.current, c.target, c.leader?.name ?? "", c.leader?.score ?? "", c.leader ? c.leader.score - c.current : "", ...c.weak.flatMap((w) => [w.label, w.detail])].join(" ");
}

function fallback(c: Candidate): Pick<RecommendationItem, "title" | "explanation" | "action"> {
  const versus = c.leader ? ` against ${c.leader.score} for ${c.leader.name}` : "";
  return {
    title: `Improve ${PILLAR_LABEL[c.pillar]} ${c.label}: ${c.weak[0]!.label}`.slice(0, 90),
    explanation: `${c.label} scores ${c.current}${versus}. ${c.weak.map((w) => `${w.label}: ${w.detail}`).join("; ")}.`.slice(0, 400),
    action: `Make these checks pass: ${c.weak.map((w) => w.label).join("; ")}.`.slice(0, 300),
  };
}

export interface RecommendationInput {
  company: { name: string; domain: string };
  pillars: Record<Pillar, PillarData>;
  /** The other scored companies in the comparison set. */
  others: BenchmarkCompany[];
}

export async function generateRecommendations({ company, pillars, others }: RecommendationInput, llm?: LlmProvider): Promise<RecommendationItem[]> {
  const candidates = recommendationCandidates(pillars, others);
  if (!candidates.length) return [];

  const provider = llm ?? getLlmProvider();
  const out = await provider.generateObject({
    name: "scorecard_recommendations",
    system: SYSTEM,
    user: JSON.stringify({
      company,
      subMetrics: candidates.map((c) => {
        const proxy = (pillars[c.pillar].metrics[c.key]?.signals as { proxy?: string } | undefined)?.proxy ?? null;
        return {
          pillar: c.pillar,
          metricKey: c.key,
          label: c.label,
          score: c.current,
          bestCompetitor: c.leader,
          proxy,
          weakChecks: c.weak.map(({ id, label, value, detail }) => ({ id, label, value: Math.round(value! * 100) / 100, detail })),
        };
      }),
    }),
    schema: recommendationSchema,
    // ≤ 12 items (~0.6–0.9k output tokens measured); the cap counts against Groq TPM.
    reasoningEffort: "low",
    maxCompletionTokens: 3072,
  });

  return candidates.map((c): RecommendationItem => {
    const weakIds = new Set(c.weak.map((w) => w.id));
    const known = new Set(numbers(factsText(c)));
    const worded = out.recommendations.find((r) => {
      if (r.metricKey !== c.key) return false;
      const cited = r.checkIds.filter((id) => weakIds.has(id));
      return cited.length > 0 && numbers(`${r.title} ${r.explanation} ${r.action}`).every((n) => known.has(n));
    });
    const text = worded ? { title: worded.title, explanation: worded.explanation, action: worded.action } : fallback(c);
    return {
      impact: c.impact,
      pillar: c.pillar,
      ...text,
      metric: `${PILLAR_LABEL[c.pillar]} · ${c.label}`,
      current: c.current,
      target: c.target,
      checkIds: worded ? [...new Set(worded.checkIds.filter((id) => weakIds.has(id)))] : c.weak.map((w) => w.id),
    };
  });
}
