import { toStrictJsonSchema } from "../src/services/llm.service.js";
// Every structured research call sets its own reasoning effort and token cap (Groq counts the cap
// against its tokens-per-minute limit), and the provider sends exactly what each request asks for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GroqProvider, GROQ_DEFAULTS } from "../src/services/providers/groq.provider.js";
import { detectCategory } from "../src/services/category.service.js";
import { selectCompetitors } from "../src/services/competitor.service.js";
import { generateEvidence } from "../src/services/scoring/evidence.js";
import { generateRecommendations } from "../src/services/recommendations.js";
import { CATEGORY, categoryAnswer, fakeLlm, website } from "./discovery-fixtures.js";
import { mockFetch } from "./jina-fixtures.js";
import { PILLAR_METRICS, type Pillar, type PillarData } from "../src/types/company.js";

afterEach(() => vi.unstubAllGlobals());

describe("GroqProvider request options", () => {
  const schema = z.object({ ok: z.boolean() });
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), { status: 200 });
  const groq = new GroqProvider("gsk-secret", "openai/gpt-oss-120b", { timeoutMs: 1_000, retryDelayMs: 0 });

  it("sends the request's reasoning effort and token cap, keeping strict JSON and temperature 0", async () => {
    const fetch = mockFetch(ok);
    await groq.generateObject({ name: "t", system: "s", user: "u", schema, reasoningEffort: "low", maxCompletionTokens: 3072 });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
      max_completion_tokens: 3072,
      temperature: 0,
      include_reasoning: false,
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
  });

  it("falls back to the provider defaults when a request sets none", async () => {
    const fetch = mockFetch(ok);
    await groq.generateObject({ name: "t", system: "s", user: "u", schema });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ reasoning_effort: GROQ_DEFAULTS.reasoningEffort, max_completion_tokens: GROQ_DEFAULTS.maxCompletionTokens });
  });
});

describe("structured research calls use low reasoning with a sized token cap", () => {
  const options = (llm: ReturnType<typeof fakeLlm>) => llm.calls.map((c) => [c.name, c.reasoningEffort, c.maxCompletionTokens]);

  it("category detection", async () => {
    const llm = fakeLlm(() => categoryAnswer());
    await detectCategory({ companyName: "Acme Content", domain: "acme.com", website: website() }, llm);
    expect(options(llm)).toEqual([["company_category", "low", 1024]]);
  });

  it("competitor classification", async () => {
    const llm = fakeLlm(() => ({ candidates: [{ domain: "maybe.io", name: "Maybe", kind: "direct_competitor", confidence: 0.9, reason: "Same service." }] }));
    const candidate = { name: "maybe.io", domain: "maybe.io", url: "https://maybe.io/blog", title: "Blog", snippet: "Content agency blog", sourceQueries: ["q"], signals: { categoryRelevance: 0.3, homepage: false, listicle: false, searchScore: 0.5 } };
    await selectCompetitors({ target: { name: "Acme", domain: "acme.com" }, targetDescription: null, category: CATEGORY, discovery: { searches: [], candidates: [candidate], rejected: [] } }, llm);
    expect(options(llm)).toEqual([["competitor_classification", "low", 2048]]);
    // Groq's strict decoder is given the classification labels, so it can't answer outside them.
    const sent = toStrictJsonSchema(llm.calls[0]!.schema) as { properties: { candidates: { items: { properties: { kind: unknown } } } } };
    expect(sent.properties.candidates.items.properties.kind).toEqual({ type: "string", enum: ["direct_competitor", "review_or_editorial", "directory_or_marketplace", "not_a_competitor"] });
  });

  const pillars = (): Record<Pillar, PillarData> => {
    const p = (pillar: Pillar): PillarData => ({
      metrics: Object.fromEntries(PILLAR_METRICS[pillar].map(({ key }) => [key, { score: 50, signals: { checks: [{ id: `${key}.x`, label: "x", value: 0.5, detail: "d" }], notMeasured: [] } }])),
    });
    return { seo: p("seo"), aeo: p("aeo"), geo: p("geo") };
  };

  it("evidence", async () => {
    const llm = fakeLlm(() => ({ evidence: [] }));
    await generateEvidence({ company: { name: "Acme", domain: "acme.com" }, pillars: pillars() }, llm);
    expect(options(llm)).toEqual([["scorecard_evidence", "low", 3072]]);
  });

  it("recommendations", async () => {
    const llm = fakeLlm(() => ({ recommendations: [] }));
    await generateRecommendations({ company: { name: "Acme", domain: "acme.com" }, pillars: pillars(), others: [] }, llm);
    expect(options(llm)).toEqual([["scorecard_recommendations", "low", 3072]]);
  });
});
