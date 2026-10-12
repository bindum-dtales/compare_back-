import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { researchCompany, startResearch, type ResearchSteps, type ScoringSteps } from "../src/services/research.service.js";
import { getComparison } from "../src/services/company.service.js";
import { LlmError } from "../src/services/llm.service.js";
import { SearchError } from "../src/services/search.service.js";
import { CategoryError } from "../src/services/category.service.js";
import { JinaError } from "../src/services/jina.service.js";
import { db, makeCompany, researchRepo } from "./fake-db.js";
import { homepage, jinaOk, mockFetch, robots } from "./jina-fixtures.js";
import { CATEGORY, categoryAnswer, fakeLlm, fakeSearch, website } from "./discovery-fixtures.js";
import { createScoringSteps } from "../src/services/scoring/scoring.service.js";
import { createSearchSession } from "../src/services/search.service.js";
import type { CompanyResearch, CompanyRow, PillarData } from "../src/types/company.js";
import type { WebsiteResearch } from "../src/types/website.js";
import type { CompetitorSelection, SelectedCompetitor } from "../src/types/discovery.js";

const p = (...s: number[]) => (keys: string[]): PillarData => ({
  metrics: Object.fromEntries(keys.map((k, i) => [k, { score: s[i]! }])),
});

const fakeScoring = (overrides: Partial<ScoringSteps> = {}): ScoringSteps => ({
  collectSignals: async () => ({
    pillars: {
      seo: p(80, 80, 80, 80)(["technical", "content", "backlinks", "ranking"]),
      aeo: p(60, 70, 80, 90)(["structured", "directAnswer", "snippet", "crawlability"]),
      geo: p(10, 20, 30, 40)(["thirdParty", "brandScale", "freshness", "clarity"]),
    },
    sources: [{ title: "Home", domain: "x", url: "https://x/", type: "Company website", pillar: "seo" }],
    linkedin: "1,200 followers",
  }),
  generateEvidence: async () => [{ pillar: "seo", metricKey: "technical", text: "Homepage returns HTTP 200.", sentiment: "positive" }],
  ...overrides,
});

const competitor = (name: string, domain: string): SelectedCompetitor => ({
  name,
  domain,
  url: `https://${domain}/`,
  category: CATEGORY.category,
  source: "fake-search",
  discoveryEvidence: {
    sourceQueries: ["q"],
    title: name,
    snippet: "",
    method: "deterministic",
    confidence: 0.9,
    reason: "Homepage matches the category.",
    signals: { categoryRelevance: 1, homepage: true, listicle: false, searchScore: 0.5 },
  },
});

const selection = (...competitors: SelectedCompetitor[]): CompetitorSelection => ({ competitors, candidates: [], note: null });

const fakeSteps = (overrides: Partial<ResearchSteps> = {}): ResearchSteps => ({
  resolveCompany: async ({ companyName, domain }) => ({ name: companyName, domain }),
  researchWebsite: async ({ domain }) => ({ source: "jina-reader", url: `https://${domain}/`, description: "Desc" }) as WebsiteResearch,
  detectCategory: async () => CATEGORY,
  discoverCompetitors: async () => ({ searches: [{ query: "q", provider: "fake-search", resultCount: 2 }], candidates: [], rejected: [] }),
  selectCompetitors: async () => selection(competitor("Rival", "rival.com"), competitor("Other", "other.io")),
  ...overrides,
});

const queue = async (companyName: string, domain: string) =>
  ((await startResearch({ companyName, domain })) as { job: { id: string } }).job.id;

/** Records "status progress step" for every job update. */
function trackJob() {
  const seen: string[] = [];
  const original = researchRepo.updateJob;
  vi.spyOn(researchRepo, "updateJob").mockImplementation(async (id, patch) => {
    if (patch.status) seen.push(`${patch.status} ${patch.progress ?? ""} ${patch.current_step ?? ""}`.trim());
    return original(id, patch);
  });
  return seen;
}

beforeEach(() => db.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("researchCompany: website → category → competitor discovery → selection", () => {
  it("walks the stages in order with meaningful progress and stores the results", async () => {
    const id = await queue("Acme", "acme.com");
    const seen = trackJob();

    await researchCompany(id, fakeSteps());

    expect(seen).toEqual([
      "resolving 10 Resolving company",
      "researching 20 Fetching acme.com",
      "researching 30 Website research saved",
      "detecting_category 40 Detecting category",
      "finding_competitors 55 Searching for competitors",
      "finding_competitors 70 Selecting competitors",
      "finding_competitors 80 Saving competitors",
      "completed 100",
    ]);
    expect(db.jobs.get(id)).toMatchObject({ status: "completed", progress: 100, company_id: "acme", error: null });
    const acme = db.companies.get("acme")!;
    expect(acme).toMatchObject({
      domain: "acme.com",
      category: "Content Marketing Agency",
      researched_at: null, // not scored yet
      website_data: { url: "https://acme.com/" },
      discovery_data: {
        category: CATEGORY,
        competitors: [{ name: "Rival", domain: "rival.com" }, { name: "Other", domain: "other.io" }],
        searches: [{ query: "q", resultCount: 2 }],
        note: null,
        discoveredAt: expect.any(String),
      },
    });
    expect(db.companies.size).toBe(1); // competitors aren't researched (or stored as companies) yet
  });

  it("hands each stage the previous stage's output and the job's own domain", async () => {
    const id = await queue("Acme", "acme.com");
    const calls: unknown[][] = [];
    const record =
      <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
      async (...a: A) => {
        calls.push([name, ...a]);
        return fn(...a);
      };
    const base = fakeSteps();
    await researchCompany(
      id,
      fakeSteps({
        resolveCompany: async () => ({ name: "Acme Inc", domain: "acme-rebrand.io" }), // tries to swap the domain
        researchWebsite: record("website", base.researchWebsite),
        detectCategory: record("category", base.detectCategory),
        discoverCompetitors: record("discover", base.discoverCompetitors),
        selectCompetitors: record("select", base.selectCompetitors),
      }),
    );
    const target = { name: "Acme Inc", domain: "acme.com" };
    expect(calls.map((c) => c[0])).toEqual(["website", "category", "discover", "select"]);
    expect(calls[0]).toEqual(["website", target]);
    expect(calls[1]).toEqual(["category", target, expect.objectContaining({ url: "https://acme.com/" })]);
    expect(calls[2]).toEqual(["discover", target, CATEGORY]);
    expect(calls[3]?.slice(1, 2)).toEqual([target]);
    expect([...db.companies.values()].map((c) => c.domain)).toEqual(["acme.com"]);
  });

  it("completes with fewer than 2 competitors when that's all the research supports", async () => {
    const id = await queue("Acme", "acme.com");
    await researchCompany(id, fakeSteps({ selectCompetitors: async () => ({ competitors: [], candidates: [], note: "No competitor candidates were found by search." }) }));
    expect(db.jobs.get(id)?.status).toBe("completed");
    expect(db.companies.get("acme")?.discovery_data).toMatchObject({ competitors: [], note: "No competitor candidates were found by search." });
  });

  it.each([
    ["website", { researchWebsite: async () => Promise.reject(new JinaError("timeout", "Jina 45000ms")) }, "WEBSITE_RESEARCH_FAILED", "Unable to research the supplied website. The website took too long to respond."],
    ["website (Jina balance)", { researchWebsite: async () => Promise.reject(new JinaError("insufficient_balance", "Jina HTTP 402: Account balance not enough", 402)) }, "WEBSITE_RESEARCH_FAILED", "Unable to research the supplied website. The website reader (Jina) API balance is insufficient. Recharge or restore JINA_API_KEY before website research and the hidden-assets comparison can run."],
    ["category (LLM malformed)", { detectCategory: async () => Promise.reject(new LlmError("malformed_response", "bad json from groq")) }, "CATEGORY_DETECTION_FAILED", "Unable to determine the company's category."],
    ["category (low confidence)", { detectCategory: async () => Promise.reject(new CategoryError("low_confidence", "0.3")) }, "CATEGORY_DETECTION_FAILED", "Unable to determine the company's category. The website content doesn't clearly indicate what market the company is in."],
    ["search (rate limit)", { discoverCompetitors: async () => Promise.reject(new SearchError("rate_limited", "Tavily HTTP 429")) }, "COMPETITOR_SEARCH_FAILED", "Unable to search for competitors. The search service is busy. Please try again in a minute."],
    ["search (API error)", { discoverCompetitors: async () => Promise.reject(new SearchError("upstream_error", "Tavily HTTP 500 key=tvly-x")) }, "COMPETITOR_SEARCH_FAILED", "Unable to search for competitors."],
    ["selection (no LLM key)", { selectCompetitors: async () => Promise.reject(new LlmError("not_configured", "GROQ_API_KEY is not set")) }, "COMPETITOR_SELECTION_FAILED", "Unable to evaluate competitor candidates. The AI service is not configured on the server."],
    ["unexpected bug", { discoverCompetitors: async () => Promise.reject(new TypeError("x is undefined at /srv/app.js")) }, "COMPETITOR_SEARCH_FAILED", "Unable to search for competitors."],
  ] as const)("a %s failure fails the job with a safe error", async (_name, override, code, message) => {
    const id = await queue("Acme", "acme.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(researchCompany(id, fakeSteps(override as Partial<ResearchSteps>))).rejects.toThrow();
    const job = db.jobs.get(id)!;
    expect(job).toMatchObject({ status: "failed", error_code: code, error: message, completed_at: expect.any(String) });
    // Upstream messages never leak. (The Jina-balance reason names the reader and its env var on purpose:
    // fixed text the operator needs; Jina's own message and status line still never appear.)
    expect(JSON.stringify(job)).not.toMatch(/groq|tvly|Tavily|Jina HTTP|Jina \d|Account balance|srv|GROQ_API_KEY/);
  });

  it("keeps what earlier stages saved when a later stage fails", async () => {
    const id = await queue("Acme", "acme.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(researchCompany(id, fakeSteps({ discoverCompetitors: async () => Promise.reject(new SearchError("timeout", "slow")) }))).rejects.toThrow();
    expect(db.companies.get("acme")).toMatchObject({ category: "Content Marketing Agency", website_data: { url: "https://acme.com/" }, discovery_data: { category: CATEGORY, competitors: null } });
  });

  it("does not re-run a finished job", async () => {
    const id = await queue("Acme", "acme.com");
    db.jobs.set(id, { ...db.jobs.get(id)!, status: "completed" });
    const researchWebsite = vi.fn();
    await researchCompany(id, fakeSteps({ researchWebsite }));
    expect(researchWebsite).not.toHaveBeenCalled();
  });

  it("re-research reuses the company id for the same domain", async () => {
    db.companies.set("acme", makeCompany({ id: "acme", name: "Acme", domain: "acme.com" }));
    const id = await queue("ACME Corporation", "acme.com");
    await researchCompany(id, fakeSteps());
    expect(db.companies.size).toBe(1);
    expect(db.jobs.get(id)?.company_id).toBe("acme");
  });

  it("gives a same-name company on a different domain its own id", async () => {
    db.companies.set("acme", makeCompany({ id: "acme", name: "Acme", domain: "acme.com" }));
    const id = await queue("Acme", "acme.co.uk");
    await researchCompany(id, fakeSteps());
    expect(db.companies.get("acme-acme-co-uk")?.domain).toBe("acme.co.uk");
    expect(db.companies.get("acme")?.domain).toBe("acme.com");
  });

});

describe("researchCompany: scoring phase", () => {
  it("scores the target, then fetches and scores each competitor, with progress and statuses", async () => {
    const id = await queue("Acme", "acme.com");
    const seen = trackJob();
    const contexts: [string, string, string][] = [];
    const scoring = fakeScoring();
    const collectSignals = scoring.collectSignals;
    scoring.collectSignals = async (company, ctx) => {
      contexts.push([company.domain, ctx.website.url, ctx.category.category]);
      return collectSignals(company, ctx);
    };

    await researchCompany(id, fakeSteps({ scoring: () => scoring }));

    expect(seen.slice(7)).toEqual([
      "researching 86 Collecting signals for Acme", // target: website already researched
      "scoring 88 Scoring Acme",
      "synthesizing 88 Generating evidence for Acme",
      "researching 90 Fetching rival.com",
      "researching 91 Collecting signals for Rival",
      "scoring 92 Scoring Rival",
      "synthesizing 93 Generating evidence for Rival",
      "researching 94 Fetching other.io",
      "researching 95 Collecting signals for Other",
      "scoring 97 Scoring Other",
      "synthesizing 98 Generating evidence for Other",
      "completed 100",
    ]);
    expect(contexts).toEqual([
      ["acme.com", "https://acme.com/", "Content Marketing Agency"],
      ["rival.com", "https://rival.com/", "Content Marketing Agency"],
      ["other.io", "https://other.io/", "Content Marketing Agency"],
    ]);
    expect(db.jobs.get(id)).toMatchObject({ status: "completed", progress: 100, company_id: "acme" });
    expect(db.companies.get("acme")).toMatchObject({
      seo_score: 80,
      aeo_score: 75,
      geo_score: 25,
      seo_data: { metrics: { technical: { score: 80 } } },
      evidence: [{ metricKey: "technical", sentiment: "positive" }],
      sources: [{ type: "Company website" }],
      linkedin: "1,200 followers",
      researched_at: expect.any(String),
      hidden_assets: [], // later phase: left untouched
      recommendations: [],
      discovery_data: {
        competitors: [{ domain: "rival.com" }, { domain: "other.io" }],
        // Competitors are scored for this comparison, against Acme's category, and kept with it.
        competitorResults: [
          { name: "Rival", domain: "rival.com", category: "Content Marketing Agency", scores: { seo: 80, aeo: 75, geo: 25 }, evidence: [{ metricKey: "technical" }], scoredAt: expect.any(String) },
          { name: "Other", domain: "other.io", category: "Content Marketing Agency", scores: { seo: 80, aeo: 75, geo: 25 } },
        ],
      },
    });
    // No competitor gets a companies row: comparison scores never become a canonical result.
    expect([...db.companies.keys()]).toEqual(["acme"]);
  });

  it("creates one scorer per job", async () => {
    const factory = vi.fn(() => fakeScoring());
    await researchCompany(await queue("Acme", "acme.com"), fakeSteps({ scoring: factory }));
    await researchCompany(await queue("Beta", "beta.com"), fakeSteps({ scoring: factory }));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("never writes to a competitor's row, even an unfinished one (e.g. from an earlier failed run)", async () => {
    const partial = makeCompany({ id: "rival", name: "Rival Inc", domain: "rival.com", category: "Payroll Software", seo_score: 12 });
    db.companies.set("rival", partial);
    await researchCompany(await queue("Acme", "acme.com"), fakeSteps({ scoring: () => fakeScoring() }));
    expect(db.companies.get("rival")).toEqual(partial);
    // Not canonical (no completed result), so it was scored for the comparison instead.
    expect(db.companies.get("acme")!.discovery_data!.competitorResults!.map((r) => r.domain)).toEqual(["rival.com", "other.io"]);
  });

  it("skips a competitor that can't be scored and still completes the job", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const base = fakeSteps();
    await researchCompany(
      id,
      fakeSteps({
        researchWebsite: async (c) => (c.domain === "rival.com" ? Promise.reject(new JinaError("rate_limited", "Jina HTTP 429")) : base.researchWebsite(c)),
        scoring: () => fakeScoring(),
      }),
    );
    expect(db.jobs.get(id)?.status).toBe("completed");
    expect(db.companies.has("rival")).toBe(false);
    // Left out of the comparison (no alternate was found to take its place, so none is invented).
    expect(db.companies.get("acme")!.discovery_data!.competitors!.map((c) => c.domain)).toEqual(["other.io"]);
    expect(db.companies.get("acme")!.discovery_data!.note).toBe("Only 1 competitor could be researched: 1 competitor website could not be read.");
    expect(db.companies.get("acme")!.discovery_data!.competitorResults!.map((r) => r.domain)).toEqual(["other.io"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("competitor rival.com not scored"), expect.stringContaining("JinaError"));
  });

  it("fails the job when the target can't be scored, keeping discovery results", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const scoring = fakeScoring({ collectSignals: async () => Promise.reject(new SearchError("quota_exceeded", "Tavily HTTP 432")) });
    await expect(researchCompany(id, fakeSteps({ scoring: () => scoring }))).rejects.toThrow();
    expect(db.jobs.get(id)).toMatchObject({
      status: "failed",
      error_code: "SCORING_FAILED",
      error: "Unable to score the company. The search service usage limit has been reached.",
    });
    expect(db.companies.get("acme")).toMatchObject({ seo_score: null, researched_at: null, discovery_data: { competitors: [{ domain: "rival.com" }, { domain: "other.io" }] } });
  });

  it("fails on invalid sub-metric scores instead of saving them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const scoring = fakeScoring({
      collectSignals: async () => ({ pillars: { seo: { metrics: {} }, aeo: { metrics: {} }, geo: { metrics: {} } }, sources: [] }),
    });
    await expect(researchCompany(id, fakeSteps({ scoring: () => scoring }))).rejects.toThrow(RangeError);
    expect(db.jobs.get(id)?.error_code).toBe("SCORING_FAILED");
    expect(db.companies.get("acme")?.seo_score).toBeNull();
  });

  it("keeps the scores but not researched_at when evidence generation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const scoring = fakeScoring({ generateEvidence: async () => Promise.reject(new LlmError("rate_limited", "Groq HTTP 429")) });
    await expect(researchCompany(id, fakeSteps({ scoring: () => scoring }))).rejects.toThrow();
    expect(db.jobs.get(id)).toMatchObject({
      status: "failed",
      error_code: "EVIDENCE_GENERATION_FAILED",
      error: "Scores were saved, but the evidence summary could not be generated. The AI service is busy. Please try again in a minute.",
    });
    expect(db.companies.get("acme")).toMatchObject({ seo_score: 80, aeo_score: 75, geo_score: 25, evidence: [], researched_at: null });
  });

  it("a scored target is returned as existing on the next request", async () => {
    await researchCompany(await queue("Acme", "acme.com"), fakeSteps({ scoring: () => fakeScoring() }));
    const again = await startResearch({ companyName: "Acme", domain: "acme.com" });
    expect(again).toMatchObject({ status: "existing", company: { company: { id: "acme" }, pillars: { seo: { score: 80 } } } });
  });
});

const SITEMAP_HTML = '<html><head><title>Sitemap</title></head><body><div><a href="https://acme.com/blog/launch">https://acme.com/blog/launch</a><br><time>2026-09-01</time></div></body></html>';

describe("researchCompany: real evidence generation (fake LLM), one bad bullet vs a real failure", () => {
  /** The real scoring + evidence code, with the LLM, search and site reads faked. Target only (no competitors). */
  const steps = (llm: ReturnType<typeof fakeLlm>) =>
    fakeSteps({
      researchWebsite: async () => website(),
      selectCompetitors: async () => selection(),
      scoring: () =>
        createScoringSteps({
          llm,
          search: createSearchSession(fakeSearch(() => [])),
          fetchPage: async (_d, url) => ({ requestedUrl: url, url, title: null, description: null, metadata: {}, canonical: null, httpStatus: 404, body: "" }),
          // Hidden assets read the homepage too; faked so the test never reaches the real Jina.
          fetchPass: async (_d, url) => ({ requestedUrl: url, url, title: null, description: null, metadata: {}, canonical: null, httpStatus: 200, body: "<html><body><p>Home</p></body></html>" }),
          canRender: () => false,
          now: () => new Date("2026-10-04T00:00:00Z"),
        }),
    });
  const evidenceAnswer = (text: (metricKey: string) => string) =>
    fakeLlm((req) =>
      req.name === "scorecard_evidence"
        ? { evidence: (JSON.parse(req.user) as { subMetrics: { metricKey: string; checks: { id: string }[] }[] }).subMetrics.map((m) => ({ metricKey: m.metricKey, checkIds: [m.checks[0]!.id], text: text(m.metricKey) })) }
        : { recommendations: [] },
    );

  it("completes when one evidence bullet is over 300 characters; that metric gets the check-based bullet", async () => {
    const id = await queue("Acme", "acme.com");
    await researchCompany(id, steps(evidenceAnswer((k) => (k === "structured" ? "The homepage has structured data markup. ".repeat(9) : "Observed on the company homepage."))));
    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null });
    const evidence = db.companies.get("acme")!.evidence;
    expect(evidence).toHaveLength(12);
    expect(evidence.every((e) => e.text.length >= 10 && e.text.length <= 300)).toBe(true);
    expect(evidence.find((e) => e.metricKey === "structured")!.text).toMatch(/^schema\.org JSON-LD present: /); // fallback from the checks
    expect(evidence.filter((e) => e.text === "Observed on the company homepage.")).toHaveLength(11);
  });

  it.each([
    ["the model is rate limited", new LlmError("rate_limited", "Groq HTTP 429"), "Scores were saved, but the evidence summary could not be generated. The AI service is busy. Please try again in a minute."],
    ["the model returns no usable JSON", new LlmError("malformed_response", "LLM output is not valid JSON"), "Scores were saved, but the evidence summary could not be generated."],
  ])("still fails the job with a safe message when %s", async (_name, error, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const llm = fakeLlm(() => {
      throw error;
    });
    await expect(researchCompany(id, steps(llm))).rejects.toBe(error);
    expect(db.jobs.get(id)).toMatchObject({ status: "failed", error_code: "EVIDENCE_GENERATION_FAILED", error: message });
    expect(db.companies.get("acme")).toMatchObject({ seo_score: expect.any(Number), evidence: [], researched_at: null });
  });

  it("still fails the job when the response envelope itself is malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    await expect(researchCompany(id, steps(fakeLlm(() => ({ bullets: "nope" }))))).rejects.toMatchObject({ kind: "malformed_response" });
    expect(db.jobs.get(id)).toMatchObject({ status: "failed", error_code: "EVIDENCE_GENERATION_FAILED" });
  });
});

describe("researchCompany: hidden assets + recommendations", () => {
  const ASSET = { url: "https://staging.acme.com/a.png", foundIn: "https://acme.com/ · <img src>", issue: "Staging host.", kind: "staging-leak" as const, severity: "high" as const };
  const CHECK = { pages: ["https://acme.com/"], diff: { ran: false, reason: "no key", blocksCompared: null }, checkedAt: "2026-10-04T00:00:00.000Z" };
  /** A check whose raw-vs-rendered diff ran (JINA_API_KEY configured). */
  const FULL_CHECK = { ...CHECK, diff: { ran: true, reason: null, blocksCompared: 4 } };
  const REC = { impact: "high" as const, pillar: "seo" as const, title: "Do it", explanation: "Because.", metric: "SEO · Technical", current: 50, target: 100, action: "Act." };

  const full = (overrides: Partial<ScoringSteps> = {}) =>
    fakeScoring({
      detectHiddenAssets: async (c) => ({ assets: c.domain === "acme.com" ? [ASSET] : [], check: CHECK }),
      generateRecommendations: async () => [REC],
      ...overrides,
    });

  it("checks hidden assets per company, then recommends for the researched company once competitors are scored, benchmarked against them", async () => {
    const id = await queue("Acme", "acme.com");
    const seen = trackJob();
    const benchmarks: [string, string[]][] = [];
    const scoring = full({
      generateRecommendations: async (c, _s, others) => {
        benchmarks.push([c.domain, others.map((o) => o.domain)]);
        return [REC];
      },
    });
    await researchCompany(id, fakeSteps({ scoring: () => scoring }));

    expect(seen).toContain("synthesizing 89 Checking hidden assets for Acme");
    expect(seen.slice(-2)).toEqual(["synthesizing 99 Generating recommendations", "completed 100"]);
    expect(seen.indexOf("synthesizing 99 Generating recommendations")).toBeGreaterThan(seen.findIndex((x) => x.includes("Checking hidden assets for Other")));
    // Only the researched company gets recommendations (it's the only canonical result this run writes).
    expect(benchmarks).toEqual([["acme.com", ["rival.com", "other.io"]]]);
    expect(db.companies.get("acme")).toMatchObject({
      hidden_assets: [ASSET],
      recommendations: [REC],
      website_data: { url: "https://acme.com/", hiddenAssetsCheck: CHECK },
      researched_at: expect.any(String),
    });
    expect(db.companies.get("acme")!.discovery_data!.competitorResults).toMatchObject([{ domain: "rival.com", hiddenAssets: [] }, { domain: "other.io", hiddenAssets: [] }]);
    expect(db.companies.has("rival")).toBe(false);
  });

  it("keeps a competitor whose (optional) hidden-assets check fails, recorded as not checked rather than clean", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    const benchmarks: string[][] = [];
    const scoring = full({
      detectHiddenAssets: async (c) => (c.domain === "rival.com" ? Promise.reject(new JinaError("timeout", "slow")) : { assets: [], check: FULL_CHECK }),
      generateRecommendations: async (_c, _s, others) => {
        benchmarks.push(others.map((o) => o.domain));
        return [];
      },
    });
    await researchCompany(id, fakeSteps({ scoring: () => scoring }));
    expect(db.jobs.get(id)?.status).toBe("completed");
    expect(benchmarks).toEqual([["rival.com", "other.io"]]); // its scores still count
    expect(db.companies.has("rival")).toBe(false);
    expect(db.companies.get("acme")!.discovery_data!.competitorResults).toMatchObject([
      { domain: "rival.com", hiddenAssets: [], hiddenAssetsChecked: false },
      { domain: "other.io", hiddenAssets: [], hiddenAssetsChecked: true },
    ]);
    const cmp = await getComparison("acme");
    expect(cmp.competitors.map((c) => [c.domain, c.result?.hiddenAssetsChecked])).toEqual([
      ["rival.com", false],
      ["other.io", true],
    ]);
  });

  it("without JINA_API_KEY (rendered diff skipped) no company is presented as clean: empty findings read as not checked", async () => {
    const id = await queue("Acme", "acme.com");
    // CHECK: diff.ran false, as createScoringSteps records it when the reader can't render.
    await researchCompany(id, fakeSteps({ scoring: () => full({ detectHiddenAssets: async () => ({ assets: [], check: CHECK }) }) }));
    expect(db.jobs.get(id)?.status).toBe("completed");
    expect(db.companies.get("acme")).toMatchObject({ hidden_assets: [], website_data: { hiddenAssetsCheck: CHECK } }); // no placeholder result
    const cmp = await getComparison("acme");
    expect(cmp.subject.hiddenAssetsChecked).toBe(false);
    expect(cmp.subject.hiddenAssets).toEqual([]);
    expect(cmp.competitors.map((c) => [c.domain, c.result?.hiddenAssetsChecked, c.result?.hiddenAssets])).toEqual([
      ["rival.com", false, []],
      ["other.io", false, []],
    ]);
    // Findings from the regex checks are still shown when they exist.
    const id2 = ((await startResearch({ companyName: "Acme", domain: "acme.com", force: true })) as { job: { id: string } }).job.id;
    await researchCompany(id2, fakeSteps({ scoring: () => full() }));
    expect((await getComparison("acme")).subject).toMatchObject({ hiddenAssetsChecked: false, hiddenAssets: [ASSET] });
  });

  it.each([
    ["hidden assets", { detectHiddenAssets: async () => Promise.reject(new JinaError("rate_limited", "429")) }, "HIDDEN_ASSETS_FAILED", "Scores were saved, but the hidden-assets check could not be completed. The website reader is busy. Please try again in a minute."],
    ["hidden assets (Jina balance)", { detectHiddenAssets: async () => Promise.reject(new JinaError("insufficient_balance", "Jina HTTP 402", 402)) }, "HIDDEN_ASSETS_FAILED", "Scores were saved, but the hidden-assets check could not be completed. The website reader (Jina) API balance is insufficient. Recharge or restore JINA_API_KEY before website research and the hidden-assets comparison can run."],
    ["recommendations", { generateRecommendations: async () => Promise.reject(new LlmError("not_configured", "no key")) }, "RECOMMENDATIONS_FAILED", "Scores were saved, but recommendations could not be generated. The AI service is not configured on the server."],
  ] as const)("fails the job when the target's %s fail, keeping its scores and evidence", async (_name, override, code, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    await expect(researchCompany(id, fakeSteps({ scoring: () => full(override as Partial<ScoringSteps>) }))).rejects.toThrow();
    expect(db.jobs.get(id)).toMatchObject({ status: "failed", error_code: code, error: message });
    expect(db.companies.get("acme")).toMatchObject({ seo_score: 80, evidence: [{ metricKey: "technical" }], researched_at: null });
  });
});

describe("re-run (force) and keeping complete records", () => {
  const REC = { impact: "high" as const, pillar: "seo" as const, title: "Do it", explanation: "Because.", metric: "SEO · Technical", current: 50, target: 100, action: "Act." };
  const CHECK = { pages: [], diff: { ran: false, reason: "no key", blocksCompared: null }, checkedAt: "2026-10-04T00:00:00.000Z" };
  const pillarsAt = (score: number) => ({
    seo: p(score, score, score, score)(["technical", "content", "backlinks", "ranking"]),
    aeo: p(score, score, score, score)(["structured", "directAnswer", "snippet", "crawlability"]),
    geo: p(score, score, score, score)(["thirdParty", "brandScale", "freshness", "clarity"]),
  });
  /** A complete scorer whose scores, evidence and recommendations are labelled by `run`. */
  const scorer = (run: string, score: number, overrides: Partial<ScoringSteps> = {}): ScoringSteps =>
    fakeScoring({
      collectSignals: async () => ({ pillars: pillarsAt(score), sources: [{ title: run, domain: "x", url: `https://x/${run}`, type: "Company website", pillar: "seo" }] }),
      generateEvidence: async () => [{ pillar: "seo", metricKey: "technical", text: `Evidence from ${run}.`, sentiment: "positive" }],
      detectHiddenAssets: async () => ({ assets: [], check: CHECK }),
      generateRecommendations: async () => [{ ...REC, title: `Recommendation from ${run}` }],
      ...overrides,
    });
  const force = async (companyName: string, domain: string) => startResearch({ companyName, domain, force: true });
  const withoutUpdatedAt = (row: CompanyRow) => ({ ...row, updated_at: undefined });

  /** Acme researched once ("first" run) with Rival as its competitor. */
  async function researchedOnce() {
    await researchCompany(await queue("Acme", "acme.com"), fakeSteps({ selectCompetitors: async () => selection(competitor("Rival", "rival.com")), scoring: () => scorer("first", 50) }));
    const before = structuredClone(db.companies.get("acme")!);
    expect(before).toMatchObject({ seo_score: 50, researched_at: expect.any(String), evidence: [{ text: "Evidence from first." }] });
    return before;
  }

  it("normal request returns the existing result; force=true queues a new job that the pipeline runs", async () => {
    await researchedOnce();
    expect(await startResearch({ companyName: "Acme", domain: "acme.com" })).toMatchObject({ status: "existing" });
    expect(await startResearch({ companyName: "Acme", domain: "acme.com", force: false })).toMatchObject({ status: "existing" });
    const res = await force("Acme", "acme.com");
    expect(res).toMatchObject({ status: "queued", job: { domain: "acme.com", status: "queued" } });
    expect(await force("Acme", "acme.com")).toMatchObject({ status: "in_progress", job: { id: (res as { job: { id: string } }).job.id } }); // no duplicate run
  });

  it("a successful re-run replaces every part of the result: nothing from the previous run is left mixed in", async () => {
    const before = await researchedOnce();
    await new Promise((r) => setTimeout(r, 5)); // a later researched_at
    const { job } = (await force("Acme", "acme.com")) as { job: { id: string } };
    await researchCompany(job.id, fakeSteps({ selectCompetitors: async () => selection(competitor("Other", "other.io")), scoring: () => scorer("second", 70) }));

    expect(db.jobs.get(job.id)).toMatchObject({ status: "completed", company_id: "acme", error: null });
    const after = db.companies.get("acme")!;
    expect(after).toMatchObject({
      seo_score: 70,
      aeo_score: 70,
      geo_score: 70,
      evidence: [{ text: "Evidence from second." }],
      recommendations: [{ title: "Recommendation from second" }],
      sources: [{ title: "second" }],
      discovery_data: { competitors: [{ domain: "other.io" }] }, // refreshed competitors
    });
    expect(after.researched_at! > before.researched_at!).toBe(true);
    expect(JSON.stringify(after)).not.toContain("first"); // no stale evidence, recommendations or sources

    // Structurally valid for the API: every pillar scored, competitors listed.
    const api = (await startResearch({ companyName: "Acme", domain: "acme.com" })) as { status: string; company: CompanyResearch };
    expect(api.status).toBe("existing");
    expect(api.company.competitors).toEqual([{ name: "Other", domain: "other.io" }]);
    for (const pillar of ["seo", "aeo", "geo"] as const) {
      expect(api.company.pillars[pillar].score).toBe(70);
      expect(api.company.pillars[pillar].subMetrics.every((m) => m.score === 70)).toBe(true);
    }
  });

  it.each([
    ["evidence", { generateEvidence: async () => Promise.reject(new LlmError("rate_limited", "Groq HTTP 429: Rate limit reached in organization org_123")) }, "EVIDENCE_GENERATION_FAILED", "The research could not be refreshed, so the previous results were kept. The AI service is busy. Please try again in a minute."],
    ["recommendations", { generateRecommendations: async () => Promise.reject(new LlmError("timeout", "Groq: No response within 60000ms")) }, "RECOMMENDATIONS_FAILED", "The research could not be refreshed, so the previous results were kept. The AI service took too long to respond."],
  ] as const)("a failed re-run (%s) keeps the last completed result and reports a safe message", async (_stage, override, code, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await researchedOnce();
    const { job } = (await force("Acme", "acme.com")) as { job: { id: string } };
    await expect(researchCompany(job.id, fakeSteps({ selectCompetitors: async () => selection(competitor("Other", "other.io")), scoring: () => scorer("second", 70, override as Partial<ScoringSteps>) }))).rejects.toThrow();

    expect(db.jobs.get(job.id)).toMatchObject({ status: "failed", error_code: code, error: message });
    expect(db.jobs.get(job.id)!.error).not.toMatch(/org_|Groq|60000/);
    expect(withoutUpdatedAt(db.companies.get("acme")!)).toEqual(withoutUpdatedAt(before)); // scores, evidence, recommendations, competitors, researched_at: all from the first run
    // And it is still served as the completed result.
    expect(await startResearch({ companyName: "Acme", domain: "acme.com" })).toMatchObject({ status: "existing", company: { pillars: { seo: { score: 50 } } } });
  });

  it("a failed re-run that never reached scoring (category detection) also keeps the previous result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await researchedOnce();
    const { job } = (await force("Acme", "acme.com")) as { job: { id: string } };
    await expect(researchCompany(job.id, fakeSteps({ detectCategory: async () => Promise.reject(new CategoryError("low_confidence", "unclear")) }))).rejects.toThrow();
    expect(db.jobs.get(job.id)?.error_code).toBe("CATEGORY_DETECTION_FAILED");
    expect(db.companies.get("acme")).toMatchObject({ category: before.category, discovery_data: before.discovery_data, website_data: before.website_data, researched_at: before.researched_at });
  });

  it("a first-time run that fails still keeps its partial scores (nothing previous to restore)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    await expect(researchCompany(id, fakeSteps({ scoring: () => scorer("first", 50, { generateEvidence: async () => Promise.reject(new LlmError("rate_limited", "429")) }) }))).rejects.toThrow();
    expect(db.jobs.get(id)?.error).toBe("Scores were saved, but the evidence summary could not be generated. The AI service is busy. Please try again in a minute.");
    expect(db.companies.get("acme")).toMatchObject({ seo_score: 50, researched_at: null });
  });

});

describe("canonical research is never overwritten by another company's comparison", () => {
  const CHECK = { pages: [], diff: { ran: false, reason: "no key", blocksCompared: null }, checkedAt: "2026-10-04T00:00:00.000Z" };
  const REC = { impact: "high" as const, pillar: "seo" as const, title: "Do it", explanation: "Because.", metric: "SEO · Technical", current: 50, target: 100, action: "Act." };
  const at = (score: number) => ({
    seo: p(score, score, score, score)(["technical", "content", "backlinks", "ranking"]),
    aeo: p(score, score, score, score)(["structured", "directAnswer", "snippet", "crawlability"]),
    geo: p(score, score, score, score)(["thirdParty", "brandScale", "freshness", "clarity"]),
  });
  /** Each domain scores differently, so a canonical result and a comparison result can't be confused. */
  const SCORE: Record<string, number> = { "carrd.co": 40, "wix.com": 80, "duda.co": 60 };
  const categoryOf = (domain: string) => ({ ...CATEGORY, category: domain === "carrd.co" ? "Landing Page Builder" : "Website Builder" });
  const scored: string[] = [];
  const benchmarks: string[][] = [];
  const scorer = (overrides: Partial<ScoringSteps> = {}): ScoringSteps =>
    fakeScoring({
      collectSignals: async (c, ctx) => {
        scored.push(`${c.domain} as ${ctx.category.category}`);
        return { pillars: at(SCORE[c.domain] ?? 50), sources: [{ title: c.domain, domain: c.domain, url: `https://${c.domain}/`, type: "Company website", pillar: "seo" }] };
      },
      generateEvidence: async (c) => [{ pillar: "seo", metricKey: "technical", text: `Evidence for ${c.domain}.`, sentiment: "positive" }],
      detectHiddenAssets: async () => ({ assets: [], check: CHECK }),
      generateRecommendations: async (c, _s, others) => {
        benchmarks.push([c.domain, ...others.map((o) => `${o.domain}=${o.pillars.seo.metrics.technical!.score}`)]);
        return [{ ...REC, title: `For ${c.domain}` }];
      },
      ...overrides,
    });
  const research = async (name: string, domain: string, competitors: SelectedCompetitor[], opts: { force?: boolean; scoring?: ScoringSteps } = {}) => {
    const started = (await startResearch({ companyName: name, domain, force: opts.force })) as { job: { id: string } };
    await researchCompany(
      started.job.id,
      fakeSteps({ detectCategory: async (c) => categoryOf(c.domain), selectCompetitors: async () => selection(...competitors), scoring: () => opts.scoring ?? scorer() }),
    );
    return started.job.id;
  };
  const rowOf = (domain: string) => [...db.companies.values()].find((c) => c.domain === domain) ?? null;

  beforeEach(() => {
    scored.length = 0;
    benchmarks.length = 0;
  });

  it("researching Carrd creates Carrd's canonical result", async () => {
    await research("Carrd", "carrd.co", []);
    expect(rowOf("carrd.co")).toMatchObject({
      id: "carrd",
      category: "Landing Page Builder",
      seo_score: 40,
      aeo_score: 40,
      geo_score: 40,
      evidence: [{ text: "Evidence for carrd.co." }],
      recommendations: [{ title: "For carrd.co" }],
      sources: [{ domain: "carrd.co" }],
      researched_at: expect.any(String),
    });
  });

  it("researching Wix with Carrd as a competitor uses Carrd's canonical result and leaves it untouched", async () => {
    await research("Carrd", "carrd.co", []);
    const carrd = structuredClone(rowOf("carrd.co")!);
    scored.length = 0;

    await research("Wix", "wix.com", [competitor("Carrd", "carrd.co"), competitor("Duda", "duda.co")]);

    expect(rowOf("carrd.co")).toEqual(carrd); // category, scores, sub-metrics, evidence, recommendations, sources, researched_at
    expect(scored).toEqual(["wix.com as Website Builder", "duda.co as Website Builder"]); // Carrd not re-scored
    // Wix's recommendations are benchmarked against Carrd's canonical scores and Duda's comparison scores.
    expect(benchmarks.at(-1)).toEqual(["wix.com", "carrd.co=40", "duda.co=60"]);
    // Only the competitor without a canonical result is stored with Wix's comparison, and nowhere else.
    expect(rowOf("wix.com")!.discovery_data!.competitorResults!.map((r) => [r.domain, r.category, r.scores.seo])).toEqual([["duda.co", "Website Builder", 60]]);
    expect(rowOf("duda.co")).toBeNull();
  });

  it("the comparison shows both: Carrd's own result and Duda's comparison-only result", async () => {
    await research("Carrd", "carrd.co", []);
    await research("Wix", "wix.com", [competitor("Carrd", "carrd.co"), competitor("Duda", "duda.co"), competitor("Gone", "gone.io")], {
      scoring: scorer({ collectSignals: async (c) => (c.domain === "gone.io" ? Promise.reject(new JinaError("timeout", "slow")) : { pillars: at(SCORE[c.domain] ?? 50), sources: [] }) }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const cmp = await getComparison("wix");
    expect(cmp.subject.company).toMatchObject({ id: "wix", category: "Website Builder" });
    expect(cmp.competitors.map((c) => [c.domain, c.basis])).toEqual([
      ["carrd.co", "canonical"],
      ["duda.co", "comparison"],
    ]); // Gone couldn't be researched: left out, nothing filled in
    expect(cmp.competitors[0]!.result).toMatchObject({ company: { id: "carrd", category: "Landing Page Builder" }, pillars: { seo: { score: 40 } } });
    expect(cmp.competitors[1]!.result).toMatchObject({ company: { id: "wix--duda-co", domain: "duda.co", category: "Website Builder" }, pillars: { seo: { score: 60 } }, recommendations: [] });
  });

  it("comparison-only scores never become a canonical result; the competitor's own research later does", async () => {
    await research("Wix", "wix.com", [competitor("Duda", "duda.co")]);
    expect(rowOf("duda.co")).toBeNull();
    const started = await startResearch({ companyName: "Duda", domain: "duda.co" });
    expect(started).toMatchObject({ status: "queued" }); // not "existing"

    // Duda researched on its own: its canonical result, with its own category, now backs Wix's comparison.
    const ownCategory = { ...CATEGORY, category: "Agency Website Platform" };
    await researchCompany((started as { job: { id: string } }).job.id, fakeSteps({ detectCategory: async () => ownCategory, selectCompetitors: async () => selection(), scoring: () => scorer() }));
    expect(rowOf("duda.co")).toMatchObject({ category: "Agency Website Platform", seo_score: 60, researched_at: expect.any(String) });
    expect((await getComparison("wix")).competitors).toMatchObject([{ domain: "duda.co", basis: "canonical", result: { company: { id: "duda", category: "Agency Website Platform" } } }]);
  });

  it("a legacy competitor row (researched_at but no job of its own) is scored for the comparison, not reused, and left untouched", async () => {
    // As the old pipeline left Squarespace: scored as Wix's competitor, researched_at set, no job.
    const legacy = makeCompany({ id: "duda", name: "Duda", domain: "duda.co", category: "Wix's category", researched_at: "2026-10-04T09:44:17Z", seo_score: 1, aeo_score: 1, geo_score: 1 });
    db.companies.set("duda", legacy);
    await research("Wix", "wix.com", [competitor("Duda", "duda.co")]);
    expect(scored).toEqual(["wix.com as Website Builder", "duda.co as Website Builder"]);
    expect(benchmarks.at(-1)).toEqual(["wix.com", "duda.co=60"]); // its fresh comparison score, not the legacy 1
    expect(rowOf("duda.co")).toEqual(legacy);
    expect((await getComparison("wix")).competitors).toMatchObject([{ domain: "duda.co", basis: "comparison", result: { pillars: { seo: { score: 60 } } } }]);
  });

  it("researching a legacy row's company for real makes it canonical", async () => {
    db.companies.set("duda", makeCompany({ id: "duda", name: "Duda", domain: "duda.co", researched_at: "2026-10-04T09:44:17Z", seo_score: 1, aeo_score: 1, geo_score: 1 }));
    expect(await startResearch({ companyName: "Duda", domain: "duda.co" })).toMatchObject({ status: "queued" });
    await researchCompany([...db.jobs.values()].find((j) => j.company_domain === "duda.co")!.id, fakeSteps({ detectCategory: async (c) => categoryOf(c.domain), selectCompetitors: async () => selection(), scoring: () => scorer() }));
    expect(await startResearch({ companyName: "Duda", domain: "duda.co" })).toMatchObject({ status: "existing", company: { pillars: { seo: { score: 60 } } } });
  });

  it("a force re-run replaces the company's own result and still leaves competitors' canonical results alone", async () => {
    await research("Carrd", "carrd.co", []);
    const carrd = structuredClone(rowOf("carrd.co")!);
    await research("Wix", "wix.com", [competitor("Duda", "duda.co")]);
    const before = structuredClone(rowOf("wix.com")!);
    await new Promise((r) => setTimeout(r, 5));

    SCORE["wix.com"] = 90;
    try {
      await research("Wix", "wix.com", [competitor("Carrd", "carrd.co")], { force: true });
    } finally {
      SCORE["wix.com"] = 80;
    }
    const after = rowOf("wix.com")!;
    expect(after).toMatchObject({ seo_score: 90, discovery_data: { competitors: [{ domain: "carrd.co" }], competitorResults: [] } });
    expect(after.researched_at! > before.researched_at!).toBe(true);
    expect(JSON.stringify(after.discovery_data)).not.toContain("duda.co"); // the previous comparison's results are gone
    expect(rowOf("carrd.co")).toEqual(carrd);
  });

  it("a failed re-run restores the previous comparison results along with the rest of the result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await research("Wix", "wix.com", [competitor("Duda", "duda.co")]);
    const before = structuredClone(rowOf("wix.com")!);
    await expect(
      research("Wix", "wix.com", [competitor("Other", "other.io")], { force: true, scoring: scorer({ generateRecommendations: async () => Promise.reject(new LlmError("rate_limited", "429")) }) }),
    ).rejects.toThrow();
    expect({ ...rowOf("wix.com")!, updated_at: undefined }).toEqual({ ...before, updated_at: undefined });
    expect((await getComparison("wix")).competitors).toMatchObject([{ domain: "duda.co", basis: "comparison", result: { pillars: { seo: { score: 60 } } } }]);
  });
});

describe("competitor websites the reader can't fetch (Jina 402 / 403 / timeout)", () => {
  const CHECK = { pages: [], diff: { ran: false, reason: "no key", blocksCompared: null }, checkedAt: "2026-10-04T00:00:00.000Z" };
  const balance = () => new JinaError("insufficient_balance", "Jina HTTP 402: InsufficientBalanceError: Account balance not enough (key jina_secret123)", 402);
  const blocked = () => new JinaError("target_http_error", "Site responded with HTTP 403", 403);
  const slow = () => new JinaError("timeout", "Jina did not respond within 45000ms");
  const fetched: string[] = [];
  /** `fail[domain]` makes that site's read fail; every other read succeeds. */
  const steps = (fail: Record<string, () => Error>, sel: CompetitorSelection) =>
    fakeSteps({
      researchWebsite: async ({ domain }) => {
        fetched.push(domain);
        if (fail[domain]) throw fail[domain]!();
        return { source: "jina-reader", url: `https://${domain}/`, description: "Desc" } as WebsiteResearch;
      },
      selectCompetitors: async () => sel,
      scoring: () => fakeScoring({ detectHiddenAssets: async () => ({ assets: [], check: CHECK }), generateRecommendations: async () => [] }),
    });
  const pick = (...domains: string[]) => domains.map((d) => competitor(d.split(".")[0]!, d));
  const run = async (fail: Record<string, () => Error>, sel: CompetitorSelection) => {
    const id = await queue("Acme", "acme.com");
    await researchCompany(id, steps(fail, sel));
    return { job: db.jobs.get(id)!, acme: db.companies.get("acme")! };
  };
  const inComparison = (acme: CompanyRow) => acme.discovery_data!.competitors!.map((c) => c.domain);

  beforeEach(() => {
    fetched.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("the researched company's own Jina 402 still fails the job with the safe balance message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queue("Acme", "acme.com");
    await expect(researchCompany(id, steps({ "acme.com": balance }, selection()))).rejects.toThrow();
    expect(db.jobs.get(id)).toMatchObject({
      status: "failed",
      error_code: "WEBSITE_RESEARCH_FAILED",
      error: "Unable to research the supplied website. The website reader (Jina) API balance is insufficient. Recharge or restore JINA_API_KEY before website research and the hidden-assets comparison can run.",
    });
  });

  it.each([
    ["Jina 402 (no balance)", balance],
    ["the site blocks the reader (HTTP 403)", blocked],
    ["a timeout", slow],
  ])("a competitor that fails with %s is skipped; the job completes with the others", async (_name, error) => {
    const { job, acme } = await run({ "rival.com": error }, selection(...pick("rival.com", "other.io")));
    expect(job).toMatchObject({ status: "completed", error: null, error_code: null });
    expect(acme.researched_at).toEqual(expect.any(String));
    expect(inComparison(acme)).toEqual(error === balance ? [] : ["other.io"]); // after a 402 no further site is read
    expect([...db.companies.keys()]).toEqual(["acme"]);
  });

  it("after a Jina 402 no further competitor site is requested, but competitors with their own research are still used", async () => {
    // Other has its own canonical research: no read needed.
    await researchCompany(await queue("Other", "other.io"), fakeSteps({ selectCompetitors: async () => selection(), scoring: () => fakeScoring() }));
    fetched.length = 0;
    const { acme } = await run({ "rival.com": balance }, { ...selection(...pick("rival.com", "third.io", "other.io")), alternates: pick("fourth.io") });
    expect(fetched).toEqual(["acme.com", "rival.com"]); // third.io and fourth.io never requested
    expect(inComparison(acme)).toEqual(["other.io"]);
    expect(acme.discovery_data!.note).toBe("Only 1 competitor could be researched: 3 competitor websites could not be read.");
  });

  it("a blocked competitor is replaced by the next legitimate (already accepted) competitor, never by anything else", async () => {
    const accepted = (d: string) => ({ ...pick(d)[0]!, url: `https://${d}/`, title: d, snippet: "", sourceQueries: ["q"], signals: { categoryRelevance: 1, homepage: true, listicle: false, searchScore: 0.5 } });
    const sel: CompetitorSelection = {
      competitors: pick("rival.com", "other.io"),
      alternates: pick("next.io", "spare.io"),
      candidates: [
        { ...accepted("rival.com"), verdict: "selected", method: "deterministic", confidence: 1, reason: "Homepage." },
        { ...accepted("other.io"), verdict: "selected", method: "deterministic", confidence: 1, reason: "Homepage." },
        { ...accepted("next.io"), verdict: "accepted", method: "llm", classification: "direct_competitor", confidence: 0.9, reason: "Same product." },
        { ...accepted("spare.io"), verdict: "accepted", method: "llm", classification: "direct_competitor", confidence: 0.8, reason: "Same product." },
        { ...accepted("reviews.io"), verdict: "rejected", method: "llm", classification: "review_or_editorial", confidence: 0.9, reason: "Reviews." },
      ],
      note: null,
    };
    const { job, acme } = await run({ "rival.com": blocked }, sel);
    expect(job.status).toBe("completed");
    expect(inComparison(acme)).toEqual(["other.io", "next.io"]); // as many as were selected; spare.io not needed
    expect(fetched).toEqual(["acme.com", "rival.com", "other.io", "next.io"]);
    const verdicts = Object.fromEntries(acme.discovery_data!.candidates.map((c) => [c.domain, [c.verdict, c.unavailable ?? null]]));
    expect(verdicts).toEqual({
      "rival.com": ["accepted", "Not researched: its website refused the website reader."],
      "other.io": ["selected", null],
      "next.io": ["selected", null],
      "spare.io": ["accepted", null],
      "reviews.io": ["rejected", null], // filtered out by discovery: never a fallback
    });
    expect(acme.discovery_data!.note).toBeNull();
  });

  it("a timed-out competitor is replaced by the next accepted alternate too; the others' scores are kept", async () => {
    const { job, acme } = await run({ "rival.com": slow }, { ...selection(...pick("rival.com", "other.io")), alternates: pick("next.io") });
    expect(job).toMatchObject({ status: "completed", error: null });
    expect(inComparison(acme)).toEqual(["other.io", "next.io"]);
    expect(acme.discovery_data!.competitorResults!.map((r) => [r.domain, r.scores.seo])).toEqual([["other.io", 80], ["next.io", 80]]);
    expect([...db.companies.keys()]).toEqual(["acme"]);
  });

  it("when every competitor fails, the job still completes with zero competitors and nothing invented", async () => {
    const { job, acme } = await run({ "rival.com": blocked, "other.io": slow, "next.io": blocked }, { ...selection(...pick("rival.com", "other.io")), alternates: pick("next.io") });
    expect(job).toMatchObject({ status: "completed", error: null });
    expect(acme).toMatchObject({ researched_at: expect.any(String), seo_score: 80 });
    expect(inComparison(acme)).toEqual([]);
    expect(acme.discovery_data!.competitorResults).toEqual([]);
    expect(acme.discovery_data!.note).toBe("No competitor could be researched: 3 competitor websites could not be read.");
    expect([...db.companies.keys()]).toEqual(["acme"]);
    expect((await getComparison("acme")).competitors).toEqual([]);
  });

  it("no provider error text reaches the job, the stored record or the API", async () => {
    const { job, acme } = await run({ "rival.com": balance, "other.io": blocked }, selection(...pick("rival.com", "other.io")));
    const exposed = JSON.stringify([job, acme, await getComparison("acme")]);
    expect(exposed).not.toMatch(/Jina HTTP|InsufficientBalance|jina_secret|45000ms|Site responded/);
  });
});

describe("default steps end to end (Jina, Tavily and Groq mocked at the HTTP layer)", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  // A real-looking homepage with enough text for category detection.
  const html = `<html lang="en"><head><title>Acme | B2B Technical Content Marketing Agency</title></head><body><h1>Technical content</h1><p>${website().content}</p><img src="https://staging.acme.com/team.png" alt="Lorem ipsum dolor"></body></html>`;

  /**
   * `groqGate` sees each Groq call (schema name, company domain when the request names one) and may
   * answer it instead (e.g. a 429). `groq` records each call's start and end, to check they never overlap.
   */
  function mockApis({
    tavily = (_q: string) => [] as unknown[],
    groqCategory = categoryAnswer(),
    groqGate = (_name: string, _domain: string | undefined): Response | null => null,
    groq = { inFlight: 0, maxInFlight: 0, calls: [] as string[] },
    classify = (_domain: string): string => "direct_competitor",
    site = (_domain: string): Response | null => null,
  } = {}) {
    return mockFetch(async (url, init) => {
      if (url.startsWith("https://api.groq.com/")) {
        const body = JSON.parse(String(init.body));
        const name: string = body.response_format.json_schema.name;
        let domain: string | undefined;
        try {
          domain = (JSON.parse(body.messages[1].content) as { company?: { domain?: string } }).company?.domain;
        } catch {
          // Category detection's prompt is prose followed by JSON; it names no single company.
        }
        groq.calls.push(`${name} ${domain ?? ""}`.trim());
        groq.maxInFlight = Math.max(groq.maxInFlight, ++groq.inFlight);
        await new Promise((r) => setTimeout(r, 2)); // a call takes time, so overlapping calls would be seen
        groq.inFlight--;
        const gated = groqGate(name, domain);
        if (gated) return gated;
      }
      return answer(url, init);
    });

    function answer(url: string, init: RequestInit): Response {
      if (url.startsWith("https://r.jina.ai/")) {
        const target = new URL(url.replace("https://r.jina.ai/", ""));
        const domain = target.hostname.replace(/^www\./, "");
        const overridden = target.pathname === "/" ? site(domain) : null;
        if (overridden) return overridden;
        if (target.pathname === "/robots.txt") return robots(domain);
        if (target.pathname.includes("sitemap")) return jinaOk({ url: target.href, title: "Sitemap", html: SITEMAP_HTML, httpStatus: 200 });
        return homepage(domain, { html });
      }
      const body = JSON.parse(String(init.body));
      if (url === "https://api.tavily.com/search") return json({ results: tavily(body.query) });
      if (url.startsWith("https://api.groq.com/")) {
        const name = body.response_format.json_schema.name;
        const content =
          name === "company_category"
            ? groqCategory
            : name === "scorecard_evidence"
              ? { evidence: JSON.parse(body.messages[1].content).subMetrics.map((m: { metricKey: string; checks: { id: string }[] }) => ({ metricKey: m.metricKey, checkIds: [m.checks[0]!.id], text: "Observed on the company website." })) }
              : name === "scorecard_recommendations"
                ? {
                    recommendations: JSON.parse(body.messages[1].content).subMetrics.map((m: { metricKey: string; weakChecks: { id: string }[] }) => ({
                      metricKey: m.metricKey,
                      checkIds: [m.weakChecks[0]!.id],
                      title: "Fix the weak check",
                      explanation: "The check was not met on the homepage.",
                      action: "Change the site so the check passes.",
                    })),
                  }
                : { candidates: JSON.parse(body.messages[1].content).candidates.map((c: { domain: string }) => ({ domain: c.domain, name: c.domain, kind: classify(c.domain), confidence: 0.9, reason: "Same service." })) };
        return json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] });
      }
      throw new Error(`unexpected request ${url}`);
    }
  }

  /** Groq's TPM 429; Retry-After kept tiny so the test doesn't wait Groq's real window. */
  const groq429 = () =>
    new Response(JSON.stringify({ error: { message: "Rate limit reached … on tokens per minute (TPM): Limit 8000. Please try again in 2.66s.", code: "rate_limit_exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "0.01" },
    });
  const rivalSearch = (q: string) =>
    q.startsWith("top B2B")
      ? [
          { url: "https://rival.com/", title: "Rival | B2B Technical Content Marketing Agency", content: "Content agency.", score: 0.9 },
          { url: "https://maybe.io/blog/top-10", title: "Top 10 content agencies", content: "Our list", score: 0.5 },
        ]
      : [];

  it("fetches the job's domain, detects the category, searches and selects competitors", async () => {
    const fetch = mockApis({
      tavily: (q) =>
        q.startsWith("top B2B")
          ? [
              { url: "https://rival.com/", title: "Rival | B2B Technical Content Marketing Agency", content: "Content agency.", score: 0.9 },
              { url: "https://www.acme.com/about", title: "Acme", content: "Target itself", score: 0.8 },
              { url: "https://clutch.co/agencies", title: "Top agencies", content: "Directory", score: 0.7 },
              { url: "https://maybe.io/blog/top-10", title: "Top 10 content agencies", content: "Our list", score: 0.5 },
            ]
          : [],
    });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id); // defaultSteps

    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls.slice(0, 2)).toEqual(["https://r.jina.ai/https://acme.com/", "https://r.jina.ai/https://acme.com/robots.txt"]);
    const job = db.jobs.get(id)!;
    expect(job).toMatchObject({ status: "completed", error: null });
    const data = db.companies.get("acme")!.discovery_data!;
    expect(data.category.category).toBe("Content Marketing Agency");
    expect(data.competitors?.map((c) => c.domain)).toEqual(["rival.com", "maybe.io"]);
    expect(data.rejectedResults.map((r) => [r.domain, r.reason])).toEqual([
      ["acme.com", "the target company itself"],
      ["clutch.co", "directory or review site"],
    ]);
    const tavily = fetch.mock.calls.filter(([u]) => u === "https://api.tavily.com/search").map(([, i]) => JSON.parse(String(i?.body)));
    const sent = tavily.map((b) => `${b.query} ${b.include_domains ?? ""}`);
    expect(new Set(sent).size).toBe(sent.length); // no query twice in a job (per domain filter), across discovery and scoring
    const discoveryQueries = tavily.map((b) => b.query).filter((q) => /^top B2B|competitors$/.test(q));
    expect(discoveryQueries.length).toBeLessThanOrEqual(3);

    // Scoring: the target (its own row) and both competitors (Acme's comparison data only), every
    // sub-metric scored, evidence for each.
    const acme = db.companies.get("acme")!;
    expect(acme.researched_at).toEqual(expect.any(String));
    for (const pillar of ["seo", "aeo", "geo"] as const) {
      expect(acme[`${pillar}_score`]).toEqual(expect.any(Number));
      expect(Object.keys((acme[`${pillar}_data`] as { metrics: object }).metrics)).toHaveLength(4);
    }
    expect(acme.evidence).toHaveLength(12);
    expect(acme.sources[0]).toMatchObject({ type: "Company website", url: "https://acme.com/" });
    const results = acme.discovery_data!.competitorResults!;
    expect(results.map((r) => r.domain)).toEqual(["rival.com", "maybe.io"]);
    for (const r of results) {
      for (const pillar of ["seo", "aeo", "geo"] as const) {
        expect(r.scores[pillar]).toEqual(expect.any(Number));
        expect(Object.keys(r.pillars[pillar].metrics)).toHaveLength(4);
      }
      expect(r.evidence).toHaveLength(12);
      expect(r.sources[0]).toMatchObject({ type: "Company website", url: `https://${r.domain}/` });
    }
    expect([...db.companies.keys()]).toEqual(["acme"]);
    // Recommendations and hidden assets for the researched company; its record is complete.
    expect(acme.recommendations.length).toBeGreaterThan(0);
    expect(acme.recommendations[0]).toMatchObject({ title: "Fix the weak check", metric: expect.stringMatching(/^(SEO|AEO|GEO) · /), current: expect.any(Number), target: expect.any(Number) });
    expect(acme.hidden_assets.map((a) => [a.kind, a.severity])).toEqual([
      ["staging-leak", "high"],
      ["hidden-content", "high"],
    ]);
    expect(acme.website_data?.hiddenAssetsCheck).toMatchObject({ pages: ["https://acme.com/"], diff: { ran: false, reason: expect.stringMatching(/JINA_API_KEY/) } });
    const rawPass = fetch.mock.calls.find(([u, i]) => u === "https://r.jina.ai/https://acme.com/" && (i?.headers as Record<string, string>)["X-Engine"] === "direct");
    expect(rawPass).toBeDefined();
    expect(fetch.mock.calls.some(([, i]) => (i?.headers as Record<string, string> | undefined)?.["X-Engine"] === "browser")).toBe(false); // no key: no render pass
    expect(db.jobs.get(id)?.status).toBe("completed");

    // Sitemaps are read for the target (declared in its robots.txt); the category templates are searched once per job.
    expect(urls).toContain("https://r.jina.ai/https://acme.com/sitemap.xml");
    expect(tavily.filter((b) => b.query.startsWith("best ")).length).toBe(1);
  });
  it("waits out temporary Groq 429s instead of dropping a competitor; LLM calls never overlap", async () => {
    const seen = new Map<string, number>();
    const groq = { inFlight: 0, maxInFlight: 0, calls: [] as string[] };
    mockApis({
      tavily: rivalSearch,
      groq,
      // Two 429s in a row for Rival's evidence (once dropped Onepage), one for Acme's recommendations.
      groqGate: (name, domain) => {
        const key = `${name} ${domain}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (key === "scorecard_evidence rival.com" && n <= 2) return groq429();
        if (key === "scorecard_recommendations acme.com" && n === 1) return groq429();
        return null;
      },
    });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id);

    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null });
    expect(db.companies.get("acme")!.discovery_data!.competitors!.map((c) => c.domain)).toEqual(["rival.com", "maybe.io"]);
    const acme = db.companies.get("acme")!;
    expect(acme).toMatchObject({ researched_at: expect.any(String), evidence: expect.arrayContaining([expect.objectContaining({ text: "Observed on the company website." })]) });
    expect(acme.recommendations.length).toBeGreaterThan(0);
    const results = acme.discovery_data!.competitorResults!;
    expect(results.map((r) => r.domain)).toEqual(["rival.com", "maybe.io"]); // nobody dropped
    for (const r of results) expect(r.evidence).toHaveLength(12);
    expect(groq.calls.filter((c) => c === "scorecard_evidence rival.com")).toHaveLength(3); // 429, 429, answered
    expect(groq.calls.filter((c) => c === "scorecard_recommendations acme.com")).toHaveLength(2); // 429, answered
    expect(groq.maxInFlight).toBe(1);
  });

  it("a competitor whose call stays rate limited is left out: nothing invented, nothing replaced, the target completes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const groq = { inFlight: 0, maxInFlight: 0, calls: [] as string[] };
    mockApis({ tavily: rivalSearch, groq, groqGate: (name, domain) => (name === "scorecard_evidence" && domain === "maybe.io" ? groq429() : null) });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id);

    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null, company_id: "acme" });
    expect(groq.calls.filter((c) => c === "scorecard_evidence maybe.io")).toHaveLength(4); // 1 call + 3 rate-limit retries
    const acme = db.companies.get("acme")!;
    expect(acme).toMatchObject({ researched_at: expect.any(String) });
    expect(acme.recommendations.length).toBeGreaterThan(0);
    // No substitute competitor (none was accepted beyond these two), and no extra company rows.
    expect(acme.discovery_data!.competitors!.map((c) => c.domain)).toEqual(["rival.com"]);
    expect([...db.companies.keys()]).toEqual(["acme"]);
    // Maybe has no scores anywhere (shown as not scored); Rival's comparison result is complete.
    expect(acme.discovery_data!.competitorResults!.map((r) => r.domain)).toEqual(["rival.com"]);
  });
  it("only classifier-confirmed direct competitors are selected: a category-matching homepage, gallery or review site is not; canonical results are reused untouched", async () => {
    // Rival has its own (canonical) research; Other doesn't.
    await researchCompany(await queue("Rival", "rival.com"), fakeSteps({ selectCompetitors: async () => selection(), scoring: () => fakeScoring() }));
    const rival = structuredClone(db.companies.get("rival")!);
    const fetch = mockApis({
      tavily: (q) =>
        q.startsWith("top B2B")
          ? [
              { url: "https://onepagelove.com", title: "One Page Love — One Page Website Inspiration and Templates", content: "One Page websites, curated.", score: 0.95 },
              // Formerly accepted without the classifier: a homepage whose title matches every category term.
              { url: "https://contentmag.com/", title: "ContentMag | B2B Technical Content Marketing Agency News", content: "News about content agencies.", score: 0.9 },
              { url: "https://rival.com/", title: "Rival | B2B Technical Content Marketing Agency", content: "Content agency.", score: 0.85 },
              { url: "https://other.io/", title: "Other | B2B Technical Content Marketing Agency", content: "Content agency.", score: 0.8 },
              { url: "https://pipes.com/blog/x", title: "Fixing pipes", content: "Leaks", score: 0.2 },
            ]
          : [],
      classify: (d) => (d === "contentmag.com" ? "review_or_editorial" : "direct_competitor"),
    });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id);

    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null });
    const acme = db.companies.get("acme")!;
    const data = acme.discovery_data!;
    // Only 2 legitimate competitors: no padding up to 4.
    expect(data.competitors!.map((c) => [c.domain, c.discoveryEvidence.method])).toEqual([
      ["rival.com", "llm"],
      ["other.io", "llm"],
    ]);
    expect(data.note).toBeNull();
    expect(data.rejectedResults).toContainEqual(expect.objectContaining({ domain: "onepagelove.com", reason: "gallery or showcase site" }));
    expect(data.candidates.find((c) => c.domain === "contentmag.com")).toMatchObject({ verdict: "rejected", method: "llm", classification: "review_or_editorial" });
    expect(data.candidates.find((c) => c.domain === "pipes.com")).toMatchObject({ verdict: "rejected", method: "deterministic" });
    for (const c of data.candidates.filter((x) => x.verdict !== "rejected")) expect(c).toMatchObject({ method: "llm", classification: "direct_competitor" });
    // Rival's canonical result is reused (its site isn't read again) and its row is unchanged; Other is comparison-only.
    expect(db.companies.get("rival")).toEqual(rival);
    expect(fetch.mock.calls.some(([u]) => String(u) === "https://r.jina.ai/https://rival.com/")).toBe(false);
    expect(data.competitorResults!.map((r) => r.domain)).toEqual(["other.io"]);
    expect([...db.companies.keys()].sort()).toEqual(["acme", "rival"]);
    expect((await getComparison("acme")).competitors.map((c) => [c.domain, c.basis])).toEqual([
      ["rival.com", "canonical"],
      ["other.io", "comparison"],
    ]);
  });

  it("completes with zero competitors when the classifier confirms none; nothing is invented", async () => {
    mockApis({ tavily: rivalSearch, classify: () => "not_a_competitor" });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id);

    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null });
    const data = db.companies.get("acme")!.discovery_data!;
    expect(data.competitors).toEqual([]);
    expect(data.note).toBe("No legitimate competitors could be identified from the search results.");
    expect(data.competitorResults ?? []).toEqual([]);
    expect([...db.companies.keys()]).toEqual(["acme"]);
  });

  it("a competitor whose site blocks Jina (403) is replaced by the next accepted competitor; review sites never are", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agency = (d: string, score: number) => ({ url: `https://${d}/`, title: `${d.split(".")[0]} | B2B Technical Content Marketing Agency`, content: "Content agency.", score });
    const fetch = mockApis({
      tavily: (q) =>
        q.startsWith("top B2B")
          ? [
              agency("rival.com", 0.9),
              agency("other.io", 0.85),
              agency("third.io", 0.8),
              agency("fourth.io", 0.75),
              agency("fifth.io", 0.7),
              { url: "https://content-agencies.cybernews.com/", title: "Best B2B Content Agencies in 2026 (Tested)", content: "Reviews.", score: 0.95 },
              { url: "https://agencyroundup.io/blog/best-content-agencies", title: "12 Best Content Marketing Agencies for B2B", content: "Our list.", score: 0.9 },
            ]
          : [],
      classify: (d) => (d === "agencyroundup.io" ? "review_or_editorial" : "direct_competitor"),
      // Third's homepage answers 403 to the reader.
      site: (d) => (d === "third.io" ? homepage(d, { httpStatus: 403 }) : null),
    });
    const id = await queue("Acme", "acme.com");

    await researchCompany(id);

    expect(db.jobs.get(id)).toMatchObject({ status: "completed", error: null });
    const acme = db.companies.get("acme")!;
    const data = acme.discovery_data!;
    expect(data.competitors!.map((c) => c.domain)).toEqual(["rival.com", "other.io", "fourth.io", "fifth.io"]);
    expect(data.competitorResults!.map((r) => r.domain)).toEqual(["rival.com", "other.io", "fourth.io", "fifth.io"]);
    expect(data.candidates.find((c) => c.domain === "third.io")).toMatchObject({ verdict: "accepted", unavailable: "Not researched: its website refused the website reader." });
    expect(data.candidates.find((c) => c.domain === "agencyroundup.io")).toMatchObject({ verdict: "rejected", classification: "review_or_editorial" });
    expect(data.rejectedResults.find((r) => r.domain === "content-agencies.cybernews.com")).toMatchObject({ reason: "directory or review site" });
    // One reader request for the blocked site (a 403 is not retried), none for the review sites.
    const reads = fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("https://r.jina.ai/https://"));
    expect(reads.filter((u) => u === "https://r.jina.ai/https://third.io/")).toHaveLength(1);
    expect(reads.some((u) => /cybernews|agencyroundup/.test(u))).toBe(false);
    expect(JSON.stringify([db.jobs.get(id), acme])).not.toMatch(/HTTP 403|Site responded/);
  });
});
