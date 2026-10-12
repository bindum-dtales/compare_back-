import { describe, expect, it } from "vitest";
import { generateRecommendations, impactFor, recommendationCandidates, type BenchmarkCompany } from "../src/services/recommendations.js";
import { LlmError } from "../src/services/llm.service.js";
import { fakeLlm } from "./discovery-fixtures.js";
import { PILLAR_METRICS, PILLARS, type Pillar, type PillarData } from "../src/types/company.js";
import type { Check } from "../src/services/scoring/rubric.js";

const check = (id: string, value: number | null, detail = "observed"): Check => ({ id, label: `${id} label`, value, detail });

/** All checks pass, except the given metrics' checks. */
function pillars(custom: Record<string, { score: number; checks: Check[]; proxy?: string }> = {}): Record<Pillar, PillarData> {
  const pillar = (p: Pillar): PillarData => ({
    metrics: Object.fromEntries(
      PILLAR_METRICS[p].map(({ key }) => {
        const m = custom[key] ?? { score: 100, checks: [check(`${key}.ok`, 1)] };
        return [key, { score: m.score, signals: { checks: m.checks, notMeasured: [], ...(m.proxy ? { proxy: m.proxy } : {}) } }];
      }),
    ),
  });
  return { seo: pillar("seo"), aeo: pillar("aeo"), geo: pillar("geo") };
}

const TARGET = pillars({
  technical: { score: 60, checks: [check("technical.reachable", 1), check("technical.indexable", 0, "meta robots: noindex"), check("technical.sitemap", 0, "No sitemap found"), check("technical.searchCrawlers", null), check("technical.canonical", 1)] },
  structured: { score: 33, checks: [check("structured.jsonld", 1), check("structured.faq", 0, "No FAQPage schema"), check("structured.article", 0)] },
  backlinks: { score: 20, checks: [check("backlinks.mentions", 0.2, "2 sites in the top 10")], proxy: "No backlink API connected." },
});
/** A competitor scoring the given sub-metrics, and 0 on every other one. */
const rival = (scores: Record<string, number>): BenchmarkCompany => ({
  name: "Rival",
  domain: "rival.com",
  pillars: pillars(
    Object.fromEntries(PILLARS.flatMap((p) => PILLAR_METRICS[p].map(({ key }) => [key, { score: scores[key] ?? 0, checks: [check(`${key}.x`, (scores[key] ?? 0) / 100)] }]))),
  ),
});

describe("recommendationCandidates", () => {
  it("one per sub-metric with weak measured checks; unknown checks are ignored; target = score with those checks met", () => {
    const c = recommendationCandidates(TARGET, []);
    expect(c.map((x) => [x.key, x.current, x.target, x.weak.map((w) => w.id)])).toEqual([
      ["backlinks", 20, 100, ["backlinks.mentions"]],
      ["structured", 33, 100, ["structured.faq", "structured.article"]],
      ["technical", 60, 100, ["technical.indexable", "technical.sitemap"]],
    ]);
  });

  it("impact = gap to the best competitor on that sub-metric (≥20 high, ≥10 medium, else low)", () => {
    const c = recommendationCandidates(TARGET, [rival({ technical: 85, structured: 40, backlinks: 10 }), { ...rival({ technical: 70 }), name: "Other" }]);
    const by = Object.fromEntries(c.map((x) => [x.key, x]));
    expect(by.technical).toMatchObject({ impact: "high", leader: { name: "Rival", score: 85 } }); // 25 behind
    expect(by.structured).toMatchObject({ impact: "low", leader: { name: "Rival", score: 40 } }); // 7 behind
    expect(by.backlinks).toMatchObject({ impact: "low", leader: { name: "Rival", score: 10 } }); // ahead of everyone
  });

  it("orders by impact, then by points recoverable", () => {
    const c = recommendationCandidates(TARGET, [rival({ technical: 75, structured: 50, backlinks: 25 })]);
    expect(c.map((x) => [x.key, x.impact])).toEqual([
      ["structured", "medium"], // 17 behind, 67 points recoverable
      ["technical", "medium"], // 15 behind, 40 points recoverable
      ["backlinks", "low"],
    ]);
  });

  it("without a scored competitor, uses the points recoverable", () => {
    expect(impactFor(20)).toBe("high");
    expect(impactFor(19)).toBe("medium");
    expect(impactFor(9)).toBe("low");
    expect(recommendationCandidates(TARGET, []).every((x) => x.impact === "high" && x.leader === null)).toBe(true);
  });

  it("returns nothing when every measured check passes", () => {
    expect(recommendationCandidates(pillars(), [])).toEqual([]);
  });
});

describe("generateRecommendations", () => {
  const answer = (overrides: Record<string, Partial<Record<string, unknown>>> = {}) =>
    fakeLlm((req) => ({
      recommendations: (JSON.parse(req.user).subMetrics as { metricKey: string; weakChecks: { id: string }[] }[]).map((m) => ({
        metricKey: m.metricKey,
        checkIds: m.weakChecks.map((w) => w.id),
        title: `Fix ${m.metricKey}`,
        explanation: "The homepage misses what the checks look for.",
        action: "Change the homepage so the checks pass.",
        ...overrides[m.metricKey],
      })),
    }));

  it("keeps the deterministic numbers and impact, and uses the model's wording", async () => {
    const llm = answer();
    const recs = await generateRecommendations({ company: { name: "Acme", domain: "acme.com" }, pillars: TARGET, others: [rival({ technical: 90 })] }, llm);
    expect(recs[0]).toEqual({
      impact: "high",
      pillar: "seo",
      title: "Fix technical",
      explanation: "The homepage misses what the checks look for.",
      metric: "SEO · Technical",
      current: 60,
      target: 100,
      action: "Change the homepage so the checks pass.",
      checkIds: ["technical.indexable", "technical.sitemap"],
    });
    const input = JSON.parse(llm.calls[0]!.user);
    expect(input.subMetrics.find((m: { metricKey: string }) => m.metricKey === "technical")).toMatchObject({ score: 60, bestCompetitor: { name: "Rival", score: 90 } });
    expect(input.subMetrics.find((m: { metricKey: string }) => m.metricKey === "backlinks").proxy).toBe("No backlink API connected.");
  });

  it("falls back to wording built from the checks when the model cites other checks or invents numbers", async () => {
    const llm = answer({
      technical: { checkIds: ["structured.faq"] },
      structured: { explanation: "Adding FAQ schema lifts traffic by 40%." },
    });
    const recs = await generateRecommendations({ company: { name: "Acme", domain: "acme.com" }, pillars: TARGET, others: [] }, llm);
    const by = Object.fromEntries(recs.map((r) => [r.metric, r]));
    expect(by["SEO · Technical"]).toMatchObject({
      title: "Improve SEO Technical: technical.indexable label",
      explanation: "Technical scores 60. technical.indexable label: meta robots: noindex; technical.sitemap label: No sitemap found.",
      action: "Make these checks pass: technical.indexable label; technical.sitemap label.",
      checkIds: ["technical.indexable", "technical.sitemap"],
    });
    expect(by["AEO · Structured"]!.explanation).toBe("Structured scores 33. structured.faq label: No FAQPage schema; structured.article label: observed.");
    expect(by["SEO · Backlinks"]!.title).toBe("Fix backlinks");
  });

  it("does not call the model when nothing is weak", async () => {
    const llm = answer();
    expect(await generateRecommendations({ company: { name: "Acme", domain: "acme.com" }, pillars: pillars(), others: [] }, llm)).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("propagates model failures", async () => {
    const llm = fakeLlm(() => {
      throw new LlmError("timeout", "slow");
    });
    await expect(generateRecommendations({ company: { name: "Acme", domain: "acme.com" }, pillars: TARGET, others: [] }, llm)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("covers every pillar's metrics by key", () => {
    // Guard: the candidate order and metric labels come from PILLAR_METRICS, the API contract.
    expect(PILLARS.flatMap((p) => PILLAR_METRICS[p].map((m) => m.key))).toHaveLength(12);
  });
});
