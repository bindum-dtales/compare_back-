import { describe, expect, it } from "vitest";
import { calculateCompanyScores, calculatePillarScore } from "../src/utils/scoring.js";
import type { Pillar, PillarData } from "../src/types/company.js";

const pillar = (entries: Record<string, number>): PillarData => ({
  metrics: Object.fromEntries(Object.entries(entries).map(([k, score]) => [k, { score }])),
});

const full: Record<Pillar, PillarData> = {
  seo: pillar({ technical: 84, content: 76, backlinks: 64, ranking: 81 }),
  aeo: pillar({ structured: 70, directAnswer: 66, snippet: 61, crawlability: 88 }),
  geo: pillar({ thirdParty: 58, brandScale: 54, freshness: 82, clarity: 78 }),
};

describe("calculatePillarScore", () => {
  it("is the plain average of four sub-metrics", () => {
    expect(calculatePillarScore([84, 76, 64, 81])).toBe(76.25);
    expect(calculatePillarScore([0, 0, 0, 0])).toBe(0);
    expect(calculatePillarScore([100, 100, 100, 100])).toBe(100);
  });

  it("rejects the wrong number of sub-metrics", () => {
    expect(() => calculatePillarScore([1, 2, 3])).toThrow(RangeError);
    expect(() => calculatePillarScore([1, 2, 3, 4, 5])).toThrow(RangeError);
  });

  it("rejects out-of-range or non-numeric scores", () => {
    expect(() => calculatePillarScore([101, 50, 50, 50])).toThrow(RangeError);
    expect(() => calculatePillarScore([-1, 50, 50, 50])).toThrow(RangeError);
    expect(() => calculatePillarScore([NaN, 50, 50, 50])).toThrow(RangeError);
  });
});

describe("calculateCompanyScores", () => {
  it("scores each pillar independently with no composite", () => {
    const scores = calculateCompanyScores(full);
    expect(scores).toEqual({ seo: 76.25, aeo: 71.25, geo: 68 });
    expect(Object.keys(scores)).toEqual(["seo", "aeo", "geo"]);
  });

  it("requires every named sub-metric", () => {
    const missing = { ...full, aeo: pillar({ structured: 70, directAnswer: 66, snippet: 61 }) };
    expect(() => calculateCompanyScores(missing)).toThrow(/aeo\.crawlability/);
  });

  it("ignores unknown extra metrics rather than averaging them in", () => {
    const extra = { ...full, seo: pillar({ technical: 84, content: 76, backlinks: 64, ranking: 81, bogus: 0 }) };
    expect(calculateCompanyScores(extra).seo).toBe(76.25);
  });
});
