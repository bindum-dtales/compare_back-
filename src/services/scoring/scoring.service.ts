// Scoring phase (spec §4/§5): for one company, collect every sub-metric's signals and score them
// with the rubric (rubric.ts), then word the evidence (evidence.ts). Same depth for the target and
// each competitor, so scores are comparable.
//
//   site facts (homepage + robots.txt from website research, sitemap via Jina) → 8 sub-metrics
//   web search (one session per job)                                          → 4 sub-metrics
//
// Create one per job (createScoringSteps): the search session dedupes the category "best X"
// queries that every company in the job shares.
//
// Also the report steps that build on the scores: hidden assets (../hidden-assets.ts, spec §7) and
// recommendations (../recommendations.ts).

import { canRender, fetchSitePage, JinaError, type JinaPage } from "../jina.service.js";
import { findHiddenAssets } from "../hidden-assets.js";
import { generateRecommendations } from "../recommendations.js";
import { createSearchSession, getSearchProvider, type SearchSession } from "../search.service.js";
import { generateEvidence } from "./evidence.js";
import { collectSitemap } from "./sitemap.js";
import * as site from "./site-metrics.js";
import * as web from "./search-metrics.js";
import type { MetricResult } from "./rubric.js";
import type { LlmProvider } from "../llm.service.js";
import type { CollectedSignals, ResolvedCompany, ScoringContext, ScoringSteps } from "../research.service.js";
import type { PillarData, SourceItem } from "../../types/company.js";

export interface ScoringDeps {
  search?: SearchSession;
  llm?: LlmProvider;
  /** Reads a page of the company's own site (sitemaps). Defaults to Jina. */
  fetchPage?: (domain: string, url: string) => Promise<JinaPage>;
  /**
   * Hidden-assets passes over the homepage: "raw" = HTML without JavaScript (Jina direct engine),
   * "visible" = text after JavaScript and CSS (Jina browser engine, innerText). Defaults to Jina.
   */
  fetchPass?: (domain: string, url: string, pass: "raw" | "visible") => Promise<JinaPage>;
  /** Whether the "visible" pass is available (Jina renders only with an API key). */
  canRender?: () => boolean;
  now?: () => Date;
}

const toPillar = (metrics: Record<string, MetricResult>): PillarData => ({
  metrics: Object.fromEntries(
    Object.entries(metrics).map(([key, { score, checks, notMeasured, proxy }]) => [key, { score, signals: { checks, notMeasured, ...(proxy ? { proxy } : {}) } }]),
  ),
});

function dedupeSources(sources: SourceItem[]): SourceItem[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.pillar} ${s.url}`;
    return !seen.has(k) && !!seen.add(k);
  });
}

export function createScoringSteps(deps: ScoringDeps = {}): ScoringSteps {
  // Created on first use so a missing search key fails inside the scoring stage, not at job start.
  let session = deps.search;
  const search = () => (session ??= createSearchSession(getSearchProvider()));
  const fetchPage = deps.fetchPage ?? ((domain: string, url: string) => fetchSitePage({ domain, url }));
  const now = deps.now ?? (() => new Date());
  const fetchPass =
    deps.fetchPass ??
    ((domain: string, url: string, pass: "raw" | "visible") =>
      fetchSitePage(pass === "raw" ? { domain, url, format: "html", engine: "direct" } : { domain, url, format: "text", engine: "browser" }));
  const renderAvailable = deps.canRender ?? canRender;

  return {
    async collectSignals(company: ResolvedCompany, { website, category }: ScoringContext): Promise<CollectedSignals> {
      const { domain } = company;
      const sitemap = await collectSitemap(domain, website, (url) => fetchPage(domain, url));
      const facts: site.SiteFacts = { domain, website, sitemap, now: now() };

      const s = search();
      const backlinks = await web.backlinks(company, s);
      const ranking = await web.ranking(company, category, s);
      const thirdParty = await web.thirdParty(company, s);
      const brandScale = await web.brandScale(company, website, s);

      const own: SourceItem[] = [
        { title: website.title ?? domain, domain, url: website.finalUrl, type: "Company website", pillar: "seo" },
        ...(website.robotsTxt?.found ? [{ title: "robots.txt", domain, url: `https://${domain}/robots.txt`, type: "Company website" as const, pillar: "aeo" as const }] : []),
        ...(sitemap.found ? sitemap.fetched.map((url) => ({ title: "Sitemap", domain, url, type: "Company website" as const, pillar: "geo" as const })) : []),
      ];

      return {
        pillars: {
          seo: toPillar({ technical: site.technical(facts), content: site.content(facts), backlinks: backlinks.metric, ranking: ranking.metric }),
          aeo: toPillar({ structured: site.structured(facts), directAnswer: site.directAnswer(facts), snippet: site.snippet(facts), crawlability: site.crawlability(facts) }),
          geo: toPillar({ thirdParty: thirdParty.metric, brandScale: brandScale.metric, freshness: site.freshness(facts), clarity: site.clarity(facts) }),
        },
        sources: dedupeSources([...own, ...backlinks.sources, ...ranking.sources, ...thirdParty.sources, ...brandScale.sources]),
        linkedin: brandScale.linkedin,
      };
    },

    generateEvidence: (company, signals) => generateEvidence({ company: { name: company.name, domain: company.domain }, pillars: signals.pillars }, deps.llm),

    async detectHiddenAssets(company, { website }) {
      // The homepage as requested (always on the company's domain), not wherever it redirected.
      const pageUrl = website.url;
      const raw = await fetchPass(company.domain, pageUrl, "raw");
      let visibleText: string | null = null;
      let reason: string | null = null;
      if (!renderAvailable()) {
        reason = "JINA_API_KEY is not set: the reader can't render pages, so raw HTML wasn't compared with the rendered page.";
      } else {
        try {
          visibleText = (await fetchPass(company.domain, pageUrl, "visible")).body;
        } catch (e) {
          reason = `The rendered page could not be read (${e instanceof JinaError ? e.kind : "error"}), so raw HTML wasn't compared with it.`;
        }
      }
      const { assets, blocksCompared } = findHiddenAssets({ pageUrl, rawHtml: raw.body, visibleText });
      return {
        assets,
        check: { pages: [pageUrl], diff: { ran: visibleText !== null, reason, blocksCompared }, checkedAt: now().toISOString() },
      };
    },

    generateRecommendations: (company, signals, others) =>
      generateRecommendations({ company: { name: company.name, domain: company.domain }, pillars: signals.pillars, others }, deps.llm),
  };
}
