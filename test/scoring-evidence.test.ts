import { describe, expect, it } from "vitest";
import { evidenceBulletSchema, generateEvidence, sentimentOf } from "../src/services/scoring/evidence.js";
import { LlmError } from "../src/services/llm.service.js";
import { fakeLlm } from "./discovery-fixtures.js";
import { PILLAR_METRICS, PILLARS, type Pillar, type PillarData } from "../src/types/company.js";
import type { Check } from "../src/services/scoring/rubric.js";

const check = (id: string, value: number | null, detail: string): Check => ({ id, label: id, value, detail });

/** Every metric with one passing check, except a few with richer facts. */
function pillars(): Record<Pillar, PillarData> {
  const special: Record<string, Check[]> = {
    technical: [check("technical.reachable", 1, "HTTP 200"), check("technical.indexable", 0, "meta robots: noindex")],
    backlinks: [check("backlinks.mentions", 0.3, "3 sites in the top 10: a.io, b.io, c.io (cap 10)")],
  };
  const pillar = (p: Pillar): PillarData => ({
    metrics: Object.fromEntries(PILLAR_METRICS[p].map(({ key }) => [key, { score: 50, signals: { checks: special[key] ?? [check(`${key}.x`, 1, "Found")], notMeasured: [] } }])),
  });
  return { seo: pillar("seo"), aeo: pillar("aeo"), geo: pillar("geo") };
}

const COMPANY = { name: "Acme", domain: "acme.com" };

describe("sentimentOf", () => {
  it("comes from the cited checks' results", () => {
    expect(sentimentOf([check("a", 1, ""), check("b", 1, "")])).toBe("positive");
    expect(sentimentOf([check("a", 0, ""), check("b", null, "")])).toBe("negative");
    expect(sentimentOf([check("a", 1, ""), check("b", 0, "")])).toBe("neutral");
    expect(sentimentOf([check("a", 0.5, "")])).toBe("neutral");
    expect(sentimentOf([check("a", null, "")])).toBe("neutral");
  });
});

describe("generateEvidence", () => {
  it("returns one bullet per sub-metric, in pillar order, with sentiment from the cited checks", async () => {
    const llm = fakeLlm((req) => {
      const input = JSON.parse(req.user) as { subMetrics: { metricKey: string; checks: { id: string }[] }[] };
      return {
        evidence: input.subMetrics.map((m) => ({
          metricKey: m.metricKey,
          checkIds: m.metricKey === "technical" ? ["technical.indexable"] : [m.checks[0]!.id],
          text: m.metricKey === "backlinks" ? "3 third-party sites name the brand, including a.io." : "Observed on the homepage.",
        })),
      };
    });
    const out = await generateEvidence({ company: COMPANY, pillars: pillars() }, llm);
    expect(out).toHaveLength(12);
    expect(out.map((e) => e.metricKey)).toEqual(PILLARS.flatMap((p) => PILLAR_METRICS[p].map((m) => m.key)));
    expect(out[0]).toEqual({ pillar: "seo", metricKey: "technical", text: "Observed on the homepage.", sentiment: "negative", checkIds: ["technical.indexable"] });
    expect(out[2]).toMatchObject({ metricKey: "backlinks", text: "3 third-party sites name the brand, including a.io.", sentiment: "neutral" });
    // The model saw the checks, not a request to score.
    expect(llm.calls[0]!.name).toBe("scorecard_evidence");
    expect(JSON.parse(llm.calls[0]!.user).subMetrics[0].checks[1]).toEqual({ id: "technical.indexable", label: "technical.indexable", value: 0, detail: "meta robots: noindex" });
  });

  it("drops bullets with invented numbers, foreign or unknown check ids, and falls back to the check details", async () => {
    const llm = fakeLlm(() => ({
      evidence: [
        { metricKey: "backlinks", checkIds: ["backlinks.mentions"], text: "Over 500 sites link to the brand." }, // 500 not in the facts
        { metricKey: "technical", checkIds: ["structured.x"], text: "Has structured data on the page." }, // another metric's check
        { metricKey: "content", checkIds: ["made.up"], text: "Publishes a lot of content." },
        { metricKey: "nonsense", checkIds: ["content.x"], text: "Unknown metric key here." },
        { metricKey: "structured", checkIds: ["structured.x"], text: "JSON-LD markup was found." },
      ],
    }));
    const out = await generateEvidence({ company: COMPANY, pillars: pillars() }, llm);
    const by = Object.fromEntries(out.map((e) => [e.metricKey, e]));
    expect(by.backlinks).toMatchObject({ text: "backlinks.mentions: 3 sites in the top 10: a.io, b.io, c.io (cap 10).", checkIds: ["backlinks.mentions"] });
    expect(by.technical).toMatchObject({ text: "technical.reachable: HTTP 200; technical.indexable: meta robots: noindex.", sentiment: "neutral" });
    expect(by.content!.text).toBe("content.x: Found.");
    expect(by.structured!.text).toBe("JSON-LD markup was found.");
    expect(out).toHaveLength(12);
  });

  it("propagates LLM failures (the stage fails; scores are already saved)", async () => {
    const llm = fakeLlm(() => {
      throw new LlmError("rate_limited", "429");
    });
    await expect(generateEvidence({ company: COMPANY, pillars: pillars() }, llm)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("rejects a malformed response envelope (not JSON, no evidence array, wrong field types)", async () => {
    for (const out of ["Sure! Here are the bullets…", { bullets: [] }, { evidence: "none" }, { evidence: [{ metricKey: "technical", checkIds: "technical.x", text: "A sentence here." }] }]) {
      const llm = fakeLlm(() => out);
      await expect(generateEvidence({ company: COMPANY, pillars: pillars() }, llm)).rejects.toMatchObject({ kind: "malformed_response" });
    }
  });
});

describe("generateEvidence: per-bullet validation (one bad bullet never fails the request)", () => {
  /** One valid bullet per metric, with `patch` applied to the given metrics. */
  const answer = (patch: Record<string, Partial<{ checkIds: string[]; text: string }>> = {}) =>
    fakeLlm((req) => ({
      evidence: (JSON.parse(req.user) as { subMetrics: { metricKey: string; checks: { id: string }[] }[] }).subMetrics.map((m) => ({
        metricKey: m.metricKey,
        checkIds: [m.checks[0]!.id],
        text: `Observed for ${m.metricKey} on the homepage.`,
        ...patch[m.metricKey],
      })),
    }));
  const run = (llm: ReturnType<typeof fakeLlm>) => generateEvidence({ company: COMPANY, pillars: pillars() }, llm);
  const byKey = (out: Awaited<ReturnType<typeof generateEvidence>>) => Object.fromEntries(out.map((e) => [e.metricKey, e]));
  const satisfiesSchema = (out: Awaited<ReturnType<typeof generateEvidence>>) =>
    out.every((e) => evidenceBulletSchema.safeParse({ metricKey: e.metricKey, checkIds: e.checkIds, text: e.text }).success);

  it("keeps a bullet of exactly 300 characters", async () => {
    const text = `${"The homepage exposes JSON-LD markup with Organization schema. ".repeat(6)}`.slice(0, 299) + "."; // no numbers: grounding
    expect(text).toHaveLength(300);
    const out = byKey(await run(answer({ structured: { text } })));
    expect(out.structured!.text).toBe(text);
  });

  it("rejects only a bullet over 300 characters, using the check-based fallback for that metric", async () => {
    const long = "The homepage exposes JSON-LD markup. ".repeat(10); // 370 chars
    const out = await run(answer({ structured: { text: long } }));
    expect(out).toHaveLength(12);
    expect(byKey(out).structured).toMatchObject({ text: "structured.x: Found.", checkIds: ["structured.x"] });
    expect(satisfiesSchema(out)).toBe(true);
  });

  it("keeps the valid bullets when several are invalid (too long, too short, no check ids)", async () => {
    const out = byKey(
      await run(
        answer({
          technical: { text: "x".repeat(301) },
          content: { text: "Too short" },
          snippet: { checkIds: [] },
          freshness: { checkIds: ["freshness.x", "a", "b", "c", "d", "e", "f"] }, // 7 ids
        }),
      ),
    );
    expect(out.technical!.text).toBe("technical.reachable: HTTP 200; technical.indexable: meta robots: noindex.");
    expect(out.content!.text).toBe("content.x: Found.");
    expect(out.snippet!.text).toBe("snippet.x: Found.");
    expect(out.freshness!.text).toBe("freshness.x: Found.");
    for (const k of ["backlinks", "ranking", "structured", "directAnswer", "crawlability", "thirdParty", "brandScale", "clarity"]) {
      expect(out[k]!.text).toBe(`Observed for ${k} on the homepage.`);
    }
  });

  it("uses a later valid bullet for the same metric when the first one is invalid", async () => {
    const llm = fakeLlm(() => ({
      evidence: [
        { metricKey: "structured", checkIds: ["structured.x"], text: "y".repeat(400) },
        { metricKey: "structured", checkIds: ["structured.x"], text: "JSON-LD markup was found on the homepage." },
      ],
    }));
    expect(byKey(await run(llm)).structured!.text).toBe("JSON-LD markup was found on the homepage.");
  });

  it("falls back for every metric when every bullet is invalid, and the result always meets the schema", async () => {
    const llm = fakeLlm(() => ({ evidence: [{ metricKey: "technical", checkIds: [], text: "x" }] }));
    const out = await run(llm);
    expect(out).toHaveLength(12);
    expect(satisfiesSchema(out)).toBe(true);
  });

  it("truncates an over-long fallback to 300 characters", async () => {
    const p = pillars();
    p.seo.metrics.technical!.signals = { checks: [check("technical.reachable", 0, "d".repeat(500))], notMeasured: [] };
    const out = byKey(await generateEvidence({ company: COMPANY, pillars: p }, fakeLlm(() => ({ evidence: [] }))));
    expect(out.technical!.text.length).toBeLessThanOrEqual(300);
    expect(out.technical!.checkIds).toEqual(["technical.reachable"]);
  });

  it("pads a fallback built from very short check details to a valid length", async () => {
    const p = pillars();
    p.aeo.metrics.snippet!.signals = { checks: [check("s", 0, "d")], notMeasured: [] };
    const out = byKey(await generateEvidence({ company: COMPANY, pillars: p }, fakeLlm(() => ({ evidence: [] }))));
    expect(out.snippet!.text).toBe("Snippet: s: d.");
  });

  it("caps a fallback's cited checks at the schema's 6, so a metric with many checks still meets it", async () => {
    const p = pillars();
    p.aeo.metrics.crawlability!.signals = { checks: Array.from({ length: 9 }, (_, i) => check(`crawlability.c${i}`, 1, "Allowed by robots.txt")), notMeasured: [] };
    const out = await generateEvidence({ company: COMPANY, pillars: p }, fakeLlm(() => ({ evidence: [] })));
    expect(byKey(out).crawlability!.checkIds).toHaveLength(6);
    expect(satisfiesSchema(out)).toBe(true);
  });

  it("never fails the job on check details that are only whitespace", async () => {
    const p = pillars();
    p.geo.metrics.clarity!.signals = { checks: [check("", null, "   \n\t  ")], notMeasured: [] };
    const out = byKey(await generateEvidence({ company: COMPANY, pillars: p }, fakeLlm(() => ({ evidence: [] }))));
    expect(out.clarity!.text.length).toBeGreaterThanOrEqual(10);
    expect(out.clarity!.text.length).toBeLessThanOrEqual(300);
  });

  it("writes a valid fallback for a metric with no recorded checks", async () => {
    const p = pillars();
    p.seo.metrics.ranking!.signals = { checks: [], notMeasured: [] };
    const out = byKey(await generateEvidence({ company: COMPANY, pillars: p }, fakeLlm(() => ({ evidence: [] }))));
    expect(out.ranking!.text).toBe("Ranking: no scoring checks were recorded.");
  });
});
