import { describe, expect, it, vi } from "vitest";
import { createScoringSteps } from "../src/services/scoring/scoring.service.js";
import { createSearchSession, SearchError } from "../src/services/search.service.js";
import { JinaError, type JinaPage } from "../src/services/jina.service.js";
import { calculateCompanyScores } from "../src/utils/scoring.js";
import { CATEGORY, fakeLlm, fakeSearch, result, website } from "./discovery-fixtures.js";
import { PILLAR_METRICS, PILLARS } from "../src/types/company.js";

const NOW = new Date("2026-10-04T00:00:00Z");
const ACME = { name: "Acme Content", domain: "acme.com" };

const SITEMAP = (url: string): JinaPage => ({
  requestedUrl: url,
  url,
  title: "Sitemap",
  description: null,
  metadata: {},
  canonical: null,
  httpStatus: 200,
  body: '<div><a href="https://acme.com/blog/launch">x</a><br><time>2026-09-15</time></div><div><a href="https://acme.com/">x</a><br><time>2026-09-30</time></div>',
});

const acmeSite = website({
  copyrightYear: 2026,
  structuredData: { types: ["Organization", "FAQPage", "BreadcrumbList"], items: [], invalidBlocks: 0 },
  headings: [{ level: 2, text: "What does Acme Content do?", followingText: "Acme Content writes technical content for B2B software companies." }],
  robotsTxt: { found: true, httpStatus: 200, sitemaps: ["https://acme.com/sitemap.xml"], content: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /" },
  links: [
    { url: "https://acme.com/blog", text: "Blog", internal: true },
    { url: "https://www.linkedin.com/company/acme-content", text: "LinkedIn", internal: false },
  ],
});

function search() {
  return fakeSearch((q) => {
    if (q === '"Acme Content"') return [result("https://clutch.co/profile/acme-content", "Acme Content | Clutch", ""), result("https://news.io/a", "News", "Acme Content wins award")];
    if (q.startsWith("best ")) return [result("https://roundup.io/best", "Best agencies", "Acme Content and Rival")];
    if (q.endsWith("LinkedIn")) return [result("https://www.linkedin.com/company/acme-content", "Acme Content | LinkedIn", "Acme Content | 2,500 followers")];
    return [];
  });
}

const steps = (overrides: Parameters<typeof createScoringSteps>[0] = {}) =>
  createScoringSteps({ search: createSearchSession(search()), fetchPage: async (_d, url) => SITEMAP(url), now: () => NOW, llm: fakeLlm(() => ({ evidence: [] })), ...overrides });

describe("createScoringSteps().collectSignals", () => {
  it("produces all 12 sub-metrics with checks, which the §4 scorer accepts", async () => {
    const signals = await steps().collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    for (const pillar of PILLARS) {
      expect(Object.keys(signals.pillars[pillar].metrics)).toEqual(PILLAR_METRICS[pillar].map((m) => m.key));
      for (const m of Object.values(signals.pillars[pillar].metrics)) {
        expect(m.score).toBeGreaterThanOrEqual(0);
        expect(m.score).toBeLessThanOrEqual(100);
        expect((m.signals as { checks: unknown[] }).checks.length).toBeGreaterThan(0);
      }
    }
    const scores = calculateCompanyScores(signals.pillars);
    expect(scores.seo).toBeGreaterThan(0);
    expect(signals.pillars.aeo.metrics.crawlability!.score).toBe(80); // GPTBot blocked
    expect(signals.pillars.geo.metrics.thirdParty!.score).toBe(25); // Clutch only
    expect(signals.pillars.geo.metrics.freshness!.signals).toMatchObject({ notMeasured: [expect.stringMatching(/Last-Modified/)] });
    expect(signals.pillars.seo.metrics.backlinks!.signals).toMatchObject({ proxy: expect.stringMatching(/No backlink API/) });
    expect(signals.linkedin).toBe("2,500 followers");
  });

  it("is deterministic for the same inputs", async () => {
    const a = await steps().collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    const b = await steps().collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    expect(a).toEqual(b);
  });

  it("lists the company's own pages and the third-party pages used as sources, without duplicates", async () => {
    const { sources } = await steps().collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    expect(sources.map((s) => [s.type, s.pillar, s.url])).toEqual([
      ["Company website", "seo", "https://acme.com/"],
      ["Company website", "aeo", "https://acme.com/robots.txt"],
      ["Company website", "geo", "https://acme.com/sitemap.xml"],
      ["Search result", "seo", "https://clutch.co/profile/acme-content"],
      ["Search result", "seo", "https://news.io/a"],
      ["Search result", "seo", "https://roundup.io/best"],
      ["Clutch", "geo", "https://clutch.co/profile/acme-content"],
      ["LinkedIn", "geo", "https://www.linkedin.com/company/acme-content"],
    ]);
  });

  it("only reads sitemaps on the company's domain, through the injected reader", async () => {
    const fetchPage = vi.fn(async (_d: string, url: string) => SITEMAP(url));
    const site = { ...acmeSite, robotsTxt: { ...acmeSite.robotsTxt!, sitemaps: ["https://cdn.example.net/sitemap.xml", "https://acme.com/sitemap.xml"] } };
    await steps({ fetchPage }).collectSignals(ACME, { website: site, category: CATEGORY });
    expect(fetchPage.mock.calls).toEqual([["acme.com", "https://acme.com/sitemap.xml"]]);
  });

  it("scores with the sitemap left out when it can't be fetched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const signals = await steps({ fetchPage: async () => Promise.reject(new JinaError("timeout", "slow")) }).collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    expect(signals.pillars.seo.metrics.technical!.signals).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ id: "technical.sitemap", value: null })]) });
  });

  it("fails when web search fails (no partial scorecard)", async () => {
    const failing = fakeSearch(() => Promise.reject(new SearchError("not_configured", "TAVILY_API_KEY is not set")));
    await expect(steps({ search: createSearchSession(failing) }).collectSignals(ACME, { website: acmeSite, category: CATEGORY })).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("shares one search session across the companies of a job", async () => {
    const provider = search();
    const scoring = steps({ search: createSearchSession(provider) });
    await scoring.collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    await scoring.collectSignals({ name: "Rival", domain: "rival.com" }, { website: website({ url: "https://rival.com/", finalUrl: "https://rival.com/" }), category: CATEGORY });
    const queries = provider.search.mock.calls.map(([q]) => q);
    expect(queries.filter((q) => q.startsWith("best "))).toHaveLength(1);
    expect(queries).toHaveLength(3 + 3 + 3); // ranking ×3 once, then backlinks + third-party + LinkedIn per company
  });
});

describe("createScoringSteps().generateEvidence", () => {
  it("words the collected signals through the LLM", async () => {
    const llm = fakeLlm(() => ({ evidence: [{ metricKey: "crawlability", checkIds: ["crawlability.gptbot"], text: "robots.txt disallows GPTBot from the whole site." }] }));
    const scoring = steps({ llm });
    const signals = await scoring.collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    const evidence = await scoring.generateEvidence(ACME, signals);
    expect(evidence).toHaveLength(12);
    expect(evidence.find((e) => e.metricKey === "crawlability")).toMatchObject({ pillar: "aeo", text: "robots.txt disallows GPTBot from the whole site.", sentiment: "negative" });
  });
});

describe("createScoringSteps().detectHiddenAssets (spec §7 two passes)", () => {
  const LONG = "A client testimonial that only exists in the markup and never renders for visitors";
  const RAW = `<html><body><section id="quotes"><p>${LONG}</p></section><p>Visible copy that every visitor can read on the homepage today</p></body></html>`;
  const page = (url: string, body: string): JinaPage => ({ requestedUrl: url, url, title: null, description: null, metadata: {}, canonical: null, httpStatus: 200, body });

  it("with rendering available: diffs the raw HTML against the rendered text of the requested homepage", async () => {
    const fetchPass = vi.fn(async (_d: string, url: string, pass: "raw" | "visible") => page(url, pass === "raw" ? RAW : "Visible copy that every visitor can read on the homepage today"));
    const site = { ...acmeSite, finalUrl: "https://www.acme.com/en/" };
    const { assets, check } = await steps({ fetchPass, canRender: () => true }).detectHiddenAssets!(ACME, { website: site });
    expect(fetchPass.mock.calls).toEqual([
      ["acme.com", "https://acme.com/", "raw"],
      ["acme.com", "https://acme.com/", "visible"],
    ]);
    expect(assets).toEqual([expect.objectContaining({ url: "https://acme.com/#quotes", kind: "hidden-content", severity: "medium" })]);
    expect(check).toEqual({ pages: ["https://acme.com/"], diff: { ran: true, reason: null, blocksCompared: 2 }, checkedAt: NOW.toISOString() });
  });

  it("without rendering: no render request, regex checks only, and the skipped diff is recorded", async () => {
    const fetchPass = vi.fn(async (_d: string, url: string) => page(url, `${RAW}<img src="https://staging.acme.com/x.png">`));
    const { assets, check } = await steps({ fetchPass, canRender: () => false }).detectHiddenAssets!(ACME, { website: acmeSite });
    expect(fetchPass).toHaveBeenCalledTimes(1);
    expect(assets.map((a) => a.kind)).toEqual(["staging-leak"]);
    expect(check.diff).toEqual({ ran: false, reason: expect.stringMatching(/JINA_API_KEY is not set/), blocksCompared: null });
  });

  it("records a failed render pass as a diff that didn't run", async () => {
    const fetchPass = async (_d: string, url: string, pass: "raw" | "visible") => (pass === "raw" ? page(url, RAW) : Promise.reject(new JinaError("timeout", "slow")));
    const { assets, check } = await steps({ fetchPass, canRender: () => true }).detectHiddenAssets!(ACME, { website: acmeSite });
    expect(assets).toEqual([]);
    expect(check.diff).toEqual({ ran: false, reason: "The rendered page could not be read (timeout), so raw HTML wasn't compared with it.", blocksCompared: null });
  });

  it("fails when the raw HTML can't be fetched (nothing can be checked)", async () => {
    const fetchPass = async () => Promise.reject(new JinaError("rate_limited", "429"));
    await expect(steps({ fetchPass }).detectHiddenAssets!(ACME, { website: acmeSite })).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("createScoringSteps().generateRecommendations", () => {
  it("recommends from the company's weak checks, benchmarked against the others", async () => {
    const llm = fakeLlm((req) =>
      req.name === "scorecard_recommendations" ? { recommendations: [{ metricKey: "crawlability", checkIds: ["crawlability.gptbot"], title: "Allow GPTBot in robots.txt", explanation: "robots.txt disallows GPTBot from the whole site.", action: "Remove the GPTBot Disallow rule." }] } : { evidence: [] },
    );
    const scoring = steps({ llm });
    const signals = await scoring.collectSignals(ACME, { website: acmeSite, category: CATEGORY });
    const recs = await scoring.generateRecommendations!(ACME, signals, [{ name: "Rival", domain: "rival.com", pillars: signals.pillars }]);
    expect(recs.find((r) => r.metric === "AEO · Crawlability")).toMatchObject({ title: "Allow GPTBot in robots.txt", current: 80, target: 100, impact: "low", checkIds: ["crawlability.gptbot"] });
    expect(recs.every((r) => r.current < r.target)).toBe(true);
  });
});
