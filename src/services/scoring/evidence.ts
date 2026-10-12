// Evidence bullets (spec §3 "bullet-point findings that back up the scores, each traceable to a
// source"; §5: turning raw signals into evidence text is the step that stays LLM-driven).
//
// The model only words the findings; it never scores. Guards, all deterministic:
//  - each bullet must cite check ids of the metric it describes; unknown ids are dropped, and a
//    bullet citing none is dropped;
//  - every number in a bullet must appear in that metric's facts, else the bullet is dropped;
//  - sentiment comes from the cited checks' results, not from the model;
//  - each bullet must meet evidenceBulletSchema (text 10–300 chars, 1–6 check ids); one that doesn't
//    is rejected on its own, not the whole response;
//  - a metric left without a valid bullet gets one built from its check details, which also meets
//    evidenceBulletSchema (text truncated to 300 chars, at most 6 check ids).

import { z } from "zod";
import { getLlmProvider, type LlmProvider } from "../llm.service.js";
import { PILLAR_METRICS, PILLARS, type EvidenceItem, type Pillar, type PillarData } from "../../types/company.js";
import type { Check, MetricResult } from "./rubric.js";

const MAX_CHECK_IDS = 6;

/** What every evidence bullet must satisfy, from the model and in what we return. */
export const evidenceBulletSchema = z.object({
  metricKey: z.string(),
  checkIds: z.array(z.string()).min(1).max(MAX_CHECK_IDS),
  text: z.string().trim().min(10).max(300),
});

/**
 * The model's response: a well-formed envelope is required (anything else fails the request as
 * malformed), but bullet constraints are checked per bullet with evidenceBulletSchema, so one
 * over-long or empty bullet can't discard the other eleven.
 */
export const evidenceSchema = z.object({
  evidence: z.array(z.object({ metricKey: z.string(), checkIds: z.array(z.string()), text: z.string() })),
});

/** At most two bullets per sub-metric are considered (one is asked for). */
const MAX_BULLETS = 24;

const SYSTEM = `You write the evidence bullets for an SEO / AEO / GEO scorecard of one company.

You get every sub-metric with its 0-100 score and the checks that produced it: each check has an id, a label, a value (1 = met, 0 = not met, between = partial, null = could not be measured) and a detail saying what was observed.

Write exactly one bullet per sub-metric:
- metricKey: the sub-metric's key, exactly as given.
- checkIds: the ids of the checks the bullet is based on (only ids listed under that sub-metric).
- text: one factual sentence (max ~30 words) stating what was observed, using only the details given. Name concrete findings (schema types, URLs, counts, crawler names). Do not restate the score, do not recommend fixes, do not speculate, and do not use numbers that are not in the details. When the sub-metric is marked as a proxy, the sentence must not claim more than the proxy measured.`;

interface MetricFacts {
  pillar: Pillar;
  key: string;
  label: string;
  score: number;
  checks: Check[];
  proxy?: string;
  notMeasured: string[];
}

function metricFacts(pillars: Record<Pillar, PillarData>): MetricFacts[] {
  return PILLARS.flatMap((pillar) =>
    PILLAR_METRICS[pillar].map(({ key, label }) => {
      const m = pillars[pillar].metrics[key];
      const s = (m?.signals ?? {}) as Partial<Pick<MetricResult, "checks" | "notMeasured" | "proxy">>;
      return { pillar, key, label, score: m?.score ?? 0, checks: s.checks ?? [], proxy: s.proxy, notMeasured: s.notMeasured ?? [] };
    }),
  );
}

export const numbers = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, ""));

/** Every number in `text` occurs in the metric's facts (score, labels, details). */
export function numbersGrounded(text: string, facts: MetricFacts): boolean {
  const known = new Set(numbers([String(facts.score), ...facts.checks.flatMap((c) => [c.label, c.detail])].join(" ")));
  return numbers(text).every((n) => known.has(n));
}

export function sentimentOf(checks: Check[]): EvidenceItem["sentiment"] {
  const values = checks.map((c) => c.value).filter((v): v is number => v !== null);
  if (values.length && values.every((v) => v === 1)) return "positive";
  if (values.length && values.every((v) => v === 0)) return "negative";
  return "neutral";
}

/** Deterministic bullet from the check details, for a metric the model gave no valid bullet for. */
export function fallbackText(facts: MetricFacts): string {
  const measured = facts.checks.filter((c) => c.value !== null);
  const parts = (measured.length ? measured : facts.checks).slice(0, 3).map((c) => `${c.label}: ${c.detail}`);
  if (!parts.length) return `${facts.label}: no scoring checks were recorded.`;
  // Collapsed whitespace, so the length rule is checked on the text as it will be stored.
  const text = `${parts.join("; ")}.`.replace(/\s+/g, " ").trim().slice(0, 300).trim();
  // Very short check details still make a valid bullet (≥ 10 chars): name the sub-metric.
  return text.length >= 10 ? text : `${facts.label}: ${text}`.slice(0, 300);
}

/**
 * The check-based bullet, guaranteed to meet evidenceBulletSchema whatever the check details hold:
 * at most MAX_CHECK_IDS cited checks (none only when the metric recorded none), text 10–300 chars.
 */
function fallbackItem(f: MetricFacts): EvidenceItem {
  const parsed = evidenceBulletSchema.shape.text.safeParse(fallbackText(f));
  const text = parsed.success ? parsed.data : `${f.label}: the check details could not be summarized.`;
  return { pillar: f.pillar, metricKey: f.key, text, sentiment: sentimentOf(f.checks), checkIds: f.checks.slice(0, MAX_CHECK_IDS).map((c) => c.id) };
}

export interface EvidenceInput {
  company: { name: string; domain: string };
  pillars: Record<Pillar, PillarData>;
}

export async function generateEvidence({ company, pillars }: EvidenceInput, llm?: LlmProvider): Promise<EvidenceItem[]> {
  const facts = metricFacts(pillars);
  const provider = llm ?? getLlmProvider();
  const out = await provider.generateObject({
    name: "scorecard_evidence",
    system: SYSTEM,
    user: JSON.stringify({
      company,
      subMetrics: facts.map((f) => ({
        pillar: f.pillar,
        metricKey: f.key,
        label: f.label,
        score: f.score,
        proxy: f.proxy ?? null,
        checks: f.checks.map(({ id, label, value, detail }) => ({ id, label, value: value === null ? null : Math.round(value * 100) / 100, detail })),
      })),
    }),
    schema: evidenceSchema,
    // 12 bullets (~0.9–1.5k output tokens measured, reasoning included); the cap counts against Groq TPM.
    reasoningEffort: "low",
    maxCompletionTokens: 3072,
  });

  const bullets = out.evidence.slice(0, MAX_BULLETS).flatMap((b) => {
    const parsed = evidenceBulletSchema.safeParse(b);
    return parsed.success ? [parsed.data] : [];
  });

  return facts.map((f): EvidenceItem => {
    const byId = new Map(f.checks.map((c) => [c.id, c]));
    for (const bullet of bullets.filter((e) => e.metricKey === f.key)) {
      const cited = [...new Set(bullet.checkIds)].filter((id) => byId.has(id));
      if (!cited.length || !numbersGrounded(bullet.text, f)) continue;
      return { pillar: f.pillar, metricKey: f.key, text: bullet.text, sentiment: sentimentOf(cited.map((id) => byId.get(id)!)), checkIds: cited };
    }
    return fallbackItem(f);
  });
}
