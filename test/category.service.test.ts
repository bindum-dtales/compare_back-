import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { CategoryError, detectCategory, MAX_EVIDENCE, MAX_EVIDENCE_CHECKED } from "../src/services/category.service.js";
import { LlmError } from "../src/services/llm.service.js";
import { StageError, toJobError } from "../src/services/job-errors.js";
import { categoryAnswer, fakeLlm, kittlAnswer, kittlWebsite, website } from "./discovery-fixtures.js";

const input = (w = website()) => ({ companyName: "Acme Content", domain: "acme.com", website: w });

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { kind: string };
  }
  throw new Error("expected a rejection");
};

describe("detectCategory", () => {
  it("returns a validated category grounded in website evidence", async () => {
    const llm = fakeLlm(() => categoryAnswer());
    const result = await detectCategory(input(), llm);

    expect(result).toEqual({
      category: "Content Marketing Agency",
      subcategory: "B2B Technical Content Marketing Agency",
      confidence: 0.88,
      rationale: expect.stringContaining("B2B technical content marketing agency"),
      evidence: ["B2B technical content marketing agency", "developer documentation"],
      model: "fake:fake-model",
      detectedAt: expect.any(String),
    });
    // The model sees the collected facts, and is told not to score.
    const sent = JSON.parse(llm.calls[0]!.user.replace(/^[^{]*/, ""));
    expect(sent).toMatchObject({
      companyName: "Acme Content",
      domain: "acme.com",
      title: "Acme Content | B2B Technical Content Marketing Agency",
      metaDescription: "Technical content marketing for B2B software companies.",
      headings: ["h1: Technical content that converts", "h2: Developer documentation"],
      structuredData: [{ type: "Organization", name: "Acme Content", description: "A B2B content marketing agency." }],
      visibleText: expect.stringContaining("developer documentation"),
    });
    expect(llm.calls[0]!.system).toMatch(/Do not score SEO, AEO or GEO/);
  });

  it("keeps only evidence quotes that really occur in the website text", async () => {
    const llm = fakeLlm(() => categoryAnswer({ evidence: ["“B2B technical content marketing agency.”", "award-winning global leader"] }));
    expect((await detectCategory(input(), llm)).evidence).toEqual(["B2B technical content marketing agency"]);
  });

  it("rejects a category with no supporting quote in the website text", async () => {
    const llm = fakeLlm(() => categoryAnswer({ evidence: ["award-winning global leader in widgets"] }));
    const err = await rejection(detectCategory(input(), llm));
    expect(err).toBeInstanceOf(CategoryError);
    expect(err.kind).toBe("unsupported");
  });

  it("rejects a low-confidence category", async () => {
    const llm = fakeLlm(() => categoryAnswer({ confidence: 0.3 }));
    expect((await rejection(detectCategory(input(), llm))).kind).toBe("low_confidence");
  });

  it("rejects a one-word generic category as too broad", async () => {
    const llm = fakeLlm(() => categoryAnswer({ category: "Internet" }));
    expect((await rejection(detectCategory(input(), llm))).kind).toBe("too_broad");
  });

  it("fails without calling the model when the website has too little content", async () => {
    const llm = fakeLlm(() => categoryAnswer());
    const thin = website({ title: null, description: null, headings: [], structuredData: { types: [], items: [], invalidBlocks: 0 }, content: "Coming soon", wordCount: 2 });
    expect((await rejection(detectCategory(input(thin), llm))).kind).toBe("insufficient_evidence");
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["not JSON", () => "The category is marketing."],
    ["missing fields", () => ({ category: "Content Marketing Agency" })],
    ["confidence out of range", () => categoryAnswer({ confidence: 1.7 })],
    ["empty output", () => ""],
  ])("rejects malformed model output: %s", async (_name, answer) => {
    const err = await rejection(detectCategory(input(), fakeLlm(answer)));
    expect(err).toBeInstanceOf(LlmError);
    expect(["malformed_response", "empty_response"]).toContain(err.kind);
  });

  it("drops a subcategory that just repeats the category", async () => {
    const llm = fakeLlm(() => categoryAnswer({ subcategory: "content marketing agency" }));
    expect((await detectCategory(input(), llm)).subcategory).toBeNull();
  });

  it("reports a missing LLM key as not configured", async () => {
    const key = env.GROQ_API_KEY;
    env.GROQ_API_KEY = undefined;
    try {
      expect((await rejection(detectCategory(input()))).kind).toBe("not_configured");
    } finally {
      env.GROQ_API_KEY = key;
    }
  });
});

describe("detectCategory: response size and shape (Kittl failure)", () => {
  // Distinct quotes that all occur in the fixture website's text.
  const QUOTES = [
    "B2B technical content marketing agency", "developer documentation", "Technical content that converts",
    "technical blog posts", "product marketing content", "plans your content strategy", "software companies",
  ];

  it("accepts exactly MAX_EVIDENCE (5) quotes, keeping all of them", async () => {
    expect(MAX_EVIDENCE).toBe(5);
    const result = await detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: QUOTES.slice(0, 5) })));
    expect(result.evidence).toEqual(QUOTES.slice(0, 5));
  });

  it("accepts more than 5 valid quotes, keeping the first 5", async () => {
    const result = await detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: QUOTES })));
    expect(QUOTES.length).toBeGreaterThan(MAX_EVIDENCE);
    expect(result.evidence).toEqual(QUOTES.slice(0, MAX_EVIDENCE));
  });

  it("never fails on the number of quotes alone: a long list keeps its first verified quotes", async () => {
    const many = [...QUOTES, ...Array(30).fill("developer documentation")];
    const result = await detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: many })));
    expect(result.evidence).toEqual(QUOTES.slice(0, MAX_EVIDENCE));
    // Only the first MAX_EVIDENCE_CHECKED are read: valid quotes buried after them don't count.
    const buried = [...Array(MAX_EVIDENCE_CHECKED).fill("award-winning global leader"), "developer documentation"];
    const err = await rejection(detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: buried }))));
    expect(err.kind).toBe("unsupported");
  });

  it("drops invalid quotes (not on the page, too short, not text) and duplicates, keeping the valid ones", async () => {
    const result = await detectCategory(
      input(),
      fakeLlm(() => categoryAnswer({ evidence: ["", "  ", "ab", "award-winning global leader", "developer documentation", "Developer  Documentation.", "technical blog posts"] })),
    );
    expect(result.evidence).toEqual(["developer documentation", "technical blog posts"]);
  });

  it("accepts the largest valid response", async () => {
    const llm = fakeLlm(() =>
      categoryAnswer({ category: "C".repeat(80), subcategory: "S".repeat(100), confidence: 1, rationale: "R".repeat(400), evidence: [...QUOTES, ...QUOTES] }),
    );
    const result = await detectCategory(input(), llm);
    expect(result).toMatchObject({ category: "C".repeat(80), subcategory: "S".repeat(100), rationale: "R".repeat(400) });
    expect(result.evidence).toHaveLength(MAX_EVIDENCE);
  });

  it("asks for 1–5 continuous quotes and a one-sentence rationale", async () => {
    const llm = fakeLlm(() => categoryAnswer());
    await detectCategory(input(), llm);
    expect(llm.calls[0]!.system).toMatch(/evidence: 1–5 short phrases/);
    expect(llm.calls[0]!.system).toMatch(/do not join phrases or use "…", and do not add more than 5/);
    expect(llm.calls[0]!.system).toMatch(/rationale: one short factual sentence \(at most 40 words\)/);
  });

  it("succeeds on Kittl's real response (7 quotes against the limit of 5), keeping the first 5 verified quotes", async () => {
    const answer = kittlAnswer();
    expect(answer.evidence).toHaveLength(7);
    const result = await detectCategory({ companyName: "Kittl", domain: "kittl.com", website: kittlWebsite() }, fakeLlm(() => answer));
    expect(result).toMatchObject({ category: "AI Design Platform", subcategory: "AI-Powered Graphic Design Tool for Brands and Sellers", confidence: 0.96 });
    // "AI‑Powered…" (non-breaking hyphen) matches the page's "AI-Powered…" and is stored with a plain hyphen;
    // the 6th quote is verified but over the limit; the "…"-joined 7th is not on the page.
    expect(result.evidence).toEqual([
      "Kittl | The AI-First Design Platform for Creators",
      "AI-Powered Design for Ambitious Brands",
      "AI Image Generator Turn ideas into polished images",
      "AI Vector Generator Create clean, editable vector artwork",
      "AI Video Generator Generate and animate using Video AI",
    ]);
  });

  it.each([
    ["U+2010 hyphen", "\u2010"],
    ["U+2011 non-breaking hyphen", "\u2011"],
    ["U+2012 figure dash", "\u2012"],
    ["U+2013 en dash", "\u2013"],
    ["U+2014 em dash", "\u2014"],
    ["U+2015 horizontal bar", "\u2015"],
    ["U+2212 minus sign", "\u2212"],
    ["U+FE63 small hyphen-minus", "\uFE63"],
    ["U+FF0D full-width hyphen-minus", "\uFF0D"],
  ])("matches a quote written with a %s against the page's hyphen", async (_name, dash) => {
    const result = await detectCategory(
      { companyName: "Kittl", domain: "kittl.com", website: kittlWebsite() },
      fakeLlm(() => ({ ...kittlAnswer(), evidence: [`AI${dash}Powered Design for Ambitious Brands`, `Listing${dash}ready mockups`] })),
    );
    expect(result.evidence).toEqual(["AI-Powered Design for Ambitious Brands", "Listing-ready mockups"]);
  });

  it("matches a page written with Unicode dashes, soft hyphens or non-breaking spaces", async () => {
    const w = website({ content: `${website().content} Our AI\u2011powered\u00a0content engine uses co\u00adauthor workflows.` });
    const result = await detectCategory(input(w), fakeLlm(() => categoryAnswer({ evidence: ["AI-powered content engine", "coauthor workflows"] })));
    expect(result.evidence).toEqual(["AI-powered content engine", "coauthor workflows"]);
  });

  it("drops an over-long evidence quote on its own, keeping the valid ones", async () => {
    const long = `${website().content.slice(0, 250)}`; // verbatim, but no longer a short phrase
    const result = await detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: [long, "developer documentation"] })));
    expect(long.length).toBeGreaterThan(200);
    expect(result.evidence).toEqual(["developer documentation"]);
  });

  it("fails safely as unsupported when every quote is over-long or not on the page", async () => {
    const err = await rejection(detectCategory(input(), fakeLlm(() => categoryAnswer({ evidence: [website().content.slice(0, 250), "award-winning global leader"] }))));
    expect(err).toBeInstanceOf(CategoryError);
    expect(err.kind).toBe("unsupported");
  });

  it.each([
    ["no quotes", () => categoryAnswer({ evidence: [] })],
    ["quotes that aren't text", () => categoryAnswer({ evidence: ["developer documentation", 42] })],
    ["evidence that isn't a list", () => categoryAnswer({ evidence: "developer documentation" })],
    ["a non-numeric confidence", () => categoryAnswer({ confidence: "high" })],
    ["a negative confidence", () => categoryAnswer({ confidence: -0.1 })],
    ["a too-short category", () => categoryAnswer({ category: "AI" })],
    ["a missing category", () => categoryAnswer({ category: undefined })],
    ["an over-long rationale", () => categoryAnswer({ rationale: "R".repeat(401) })],
    ["an over-long category", () => categoryAnswer({ category: "C".repeat(81) })],
    ["truncated JSON", () => JSON.stringify(categoryAnswer()).slice(0, 60)],
  ])("rejects a malformed response: %s", async (_name, answer) => {
    const err = await rejection(detectCategory(input(), fakeLlm(answer)));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("malformed_response");
  });

  it("ignores unexpected extra fields and never stores them", async () => {
    const result = await detectCategory(input(), fakeLlm(() => categoryAnswer({ reasoning: "x".repeat(5000), notes: ["extra"] })));
    expect(Object.keys(result).sort()).toEqual(["category", "confidence", "detectedAt", "evidence", "model", "rationale", "subcategory"]);
  });

  it("passes an LLM rate limit through as rate_limited", async () => {
    const llm = fakeLlm(() => {
      throw new LlmError("rate_limited", "Groq HTTP 429: Rate limit reached for model openai/gpt-oss-120b", 429);
    });
    expect((await rejection(detectCategory(input(), llm))).kind).toBe("rate_limited");
  });

  it("job errors are safe: fixed wording, no provider or schema details", async () => {
    const fail = async (answer: () => unknown) => {
      try {
        await detectCategory(input(), fakeLlm(answer));
      } catch (e) {
        return toJobError(new StageError("CATEGORY_DETECTION_FAILED", e));
      }
      throw new Error("expected a failure");
    };
    const malformed = await fail(() => categoryAnswer({ rationale: "R".repeat(401) }));
    expect(malformed).toEqual({ code: "CATEGORY_DETECTION_FAILED", message: "Unable to determine the company's category." });
    const limited = await fail(() => {
      throw new LlmError("rate_limited", "Groq HTTP 429: Rate limit reached for model openai/gpt-oss-120b in organization org_123", 429);
    });
    expect(limited.message).toBe("Unable to determine the company's category. The AI service is busy. Please try again in a minute.");
    const unsupported = await fail(() => categoryAnswer({ evidence: ["award-winning global leader"] }));
    expect(unsupported.message).toBe("Unable to determine the company's category. The website content doesn't clearly indicate what market the company is in.");
    for (const { message } of [malformed, limited, unsupported]) expect(message).not.toMatch(/groq|429|org_|schema|validation|rationale|evidence/i);
  });
});
