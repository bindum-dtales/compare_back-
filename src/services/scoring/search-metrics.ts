// Sub-metrics that need the open web: SEO backlinks + ranking, GEO third-party presence + brand scale.
//
// No backlink, SERP or LinkedIn API is connected, so these use the spec §5 "how the prototype
// gets it" method through the search provider, and say so in `proxy`. Whether a result is
// about the company is decided deterministically (name or domain in the title, snippet or URL).

import { normalizeDomain } from "../../utils/domain.js";
import { isSameSite } from "../jina.service.js";
import { categoryNoun } from "../competitor.service.js";
import { nonCompanyReason } from "../candidates.js";
import { CAPS, count, metric, pass, type MetricResult } from "./rubric.js";
import type { SearchResult, SearchSession } from "../search.service.js";
import type { CategoryResult } from "../../types/discovery.js";
import type { Pillar, SourceItem, SourceType } from "../../types/company.js";
import type { WebsiteResearch } from "../../types/website.js";

export interface Company {
  name: string;
  domain: string;
}

export interface SearchMetric {
  metric: MetricResult;
  sources: SourceItem[];
}

const RESULTS = 10;

const words = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()} `;

/** The result names the company: its full name or its domain, as whole words, in title, snippet or URL. */
export function mentionsCompany(company: Company, ...texts: string[]): boolean {
  const hay = words(texts.join(" "));
  const name = words(company.name);
  return (name.trim().length >= 3 && hay.includes(name)) || hay.includes(words(company.domain));
}

const mentionedIn = (company: Company, r: SearchResult) => mentionsCompany(company, r.title, r.snippet, r.url);

function source(r: SearchResult, type: SourceType, pillar: Pillar): SourceItem {
  return { title: r.title || r.url, domain: normalizeDomain(r.url) ?? "", url: r.url, type, pillar };
}

const quote = (s: string) => `"${s.replace(/"/g, "")}"`;

// --- SEO backlinks ---------------------------------------------------------------------

/** Third-party pages naming the brand in the top results for its exact name (social profiles and search engines don't count). */
export async function backlinks(company: Company, session: SearchSession): Promise<SearchMetric> {
  const results = await session.search(quote(company.name), { maxResults: RESULTS, excludeDomains: [company.domain] });
  const citing = new Map<string, SearchResult>();
  for (const r of results) {
    const host = normalizeDomain(r.url);
    if (!host || isSameSite(r.url, company.domain) || citing.has(host)) continue;
    const kind = nonCompanyReason(host);
    if (kind === "social profile" || kind === "search engine") continue;
    if (mentionedIn(company, r)) citing.set(host, r);
  }
  return {
    metric: metric(
      [
        count(
          "backlinks.mentions",
          "Third-party sites citing the brand",
          citing.size,
          CAPS.mentioningDomains,
          citing.size ? `${citing.size} sites in the top ${RESULTS}: ${[...citing.keys()].join(", ")} (cap ${CAPS.mentioningDomains})` : `No third-party site names the brand in the top ${RESULTS} results`,
        ),
      ],
      {
        notMeasured: ["Referring-domain counts and link authority (Ahrefs / Semrush backlink API not connected)"],
        proxy: "No backlink API connected: counts third-party sites naming the brand in web search, the prototype's method.",
      },
    ),
    sources: [...citing.values()].map((r) => source(r, "Search result", "seo")),
  };
}

// --- SEO ranking -----------------------------------------------------------------------

/**
 * Spec §5: "a fixed set of query templates per category" for "best X" roundups and comparison
 * content; §6 names the "best X" / "top X providers" styles. Distinct from discovery's queries.
 */
export function rankingQueries(category: Pick<CategoryResult, "category">): string[] {
  return [`best ${categoryNoun(category.category)}`, `top ${category.category} providers`, `${category.category} comparison`];
}

/** One check per template: a third-party roundup/comparison page in the results names the company. */
export async function ranking(company: Company, category: CategoryResult, session: SearchSession): Promise<SearchMetric> {
  const sources: SourceItem[] = [];
  const checks = [];
  for (const [i, query] of rankingQueries(category).entries()) {
    // Same options for every company, so the job's session sends each template once.
    const results = await session.search(query, { maxResults: RESULTS });
    const hit = results.find((r) => !isSameSite(r.url, company.domain) && mentionedIn(company, r));
    const own = results.findIndex((r) => isSameSite(r.url, company.domain));
    if (hit) sources.push(source(hit, "Search result", "seo"));
    checks.push(
      pass(
        `ranking.template${i + 1}`,
        `Named in a roundup or comparison for "${query}"`,
        !!hit,
        hit ? `"${hit.title}" (${hit.url})` : `Not named in the top ${RESULTS} results${own >= 0 ? ` (own site is result #${own + 1})` : ""}`,
      ),
    );
  }
  return {
    metric: metric(checks, { notMeasured: ["Mentions beyond the result title and snippet (full articles are not fetched)", "Keyword positions (no rank-tracking API connected)"] }),
    sources,
  };
}

// --- GEO third-party presence ----------------------------------------------------------

/** Spec §4: "the review and comparison sites (G2, Capterra, Clutch, GoodFirms) that AI engines draw citations from". */
export const REVIEW_PLATFORMS: { domain: string; name: string; type: SourceType }[] = [
  { domain: "g2.com", name: "G2", type: "G2" },
  { domain: "capterra.com", name: "Capterra", type: "Search result" },
  { domain: "clutch.co", name: "Clutch", type: "Clutch" },
  { domain: "goodfirms.co", name: "GoodFirms", type: "Search result" },
];

export async function thirdParty(company: Company, session: SearchSession): Promise<SearchMetric> {
  const results = await session.search(quote(company.name), { maxResults: RESULTS, includeDomains: REVIEW_PLATFORMS.map((p) => p.domain) });
  const sources: SourceItem[] = [];
  const checks = REVIEW_PLATFORMS.map((p) => {
    const hit = results.find((r) => isSameSite(r.url, p.domain) && mentionedIn(company, r));
    if (hit) sources.push(source(hit, p.type, "geo"));
    return pass(`thirdParty.${p.name.toLowerCase()}`, `Listed on ${p.name}`, !!hit, hit ? hit.url : `No ${p.name} page for the company in search results`);
  });
  return {
    metric: metric(checks, {
      notMeasured: ["AI-citation tracking (Peec AI / Ahrefs Brand Radar not connected)", "Review counts and ratings"],
      proxy: "No review-platform APIs connected: searches the four platforms for the company's page, the prototype's method.",
    }),
    sources,
  };
}

// --- GEO brand scale -------------------------------------------------------------------

const LINKEDIN_COMPANY = /linkedin\.com\/company\/([^/?#]+)/i;

/** "12,345 followers", "1.2K followers", "3M followers" → number; null if absent. */
export function parseFollowers(text: string): number | null {
  const m = /(\d[\d,.]*)\s*([kKmM])?\+?\s*followers\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = m[2]?.toLowerCase() === "k" ? 1_000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(n * mult);
}

const followerScore = (n: number) => Math.min(Math.log10(n + 1) / Math.log10(CAPS.linkedinFollowers + 1), 1);

export interface BrandScaleMetric extends SearchMetric {
  /** For companies.linkedin: the follower count, or a note when it couldn't be found (spec §3). */
  linkedin: string;
}

/** LinkedIn following as an authority proxy (spec §4), from the company page linked on its site and/or found by search. */
export async function brandScale(company: Company, website: WebsiteResearch, session: SearchSession): Promise<BrandScaleMetric> {
  const linked = website.links.map((l) => LINKEDIN_COMPANY.exec(l.url)?.[1]?.toLowerCase()).find(Boolean) ?? null;
  const results = await session.search(`${company.name} LinkedIn`, { maxResults: 5, includeDomains: ["linkedin.com"] });
  const pages = results.filter((r) => {
    const slug = LINKEDIN_COMPANY.exec(r.url)?.[1]?.toLowerCase();
    return !!slug && (slug === linked || mentionsCompany(company, r.title));
  });
  const withCount = pages.map((r) => ({ r, n: parseFollowers(`${r.title} ${r.snippet}`) })).find((x) => x.n !== null);
  const pageUrl = withCount?.r.url ?? pages[0]?.url ?? (linked ? `https://www.linkedin.com/company/${linked}` : null);
  const followers = withCount?.n ?? null;

  // Following is what's scored (spec §4), not whether a page exists. Like every search-based
  // signal here, a count that can't be found in search scores 0; the detail says which case it is.
  const checks = [
    followers !== null
      ? { id: "brandScale.linkedinFollowers", label: "LinkedIn followers", value: followerScore(followers), detail: `${followers.toLocaleString("en-US")} followers on ${pageUrl} (log scale, full marks at ${CAPS.linkedinFollowers.toLocaleString("en-US")})` }
      : pass("brandScale.linkedinFollowers", "LinkedIn followers", false, pageUrl ? `Page ${pageUrl} found, but no follower count in search results` : "No LinkedIn company page linked from the site or found by search"),
  ];
  const sourceResult = withCount?.r ?? pages[0];
  return {
    metric: metric(checks, {
      notMeasured: ["Follower counts on other social networks (no data source connected)"],
      proxy: "No LinkedIn API connected: follower count read from search results for the company page, the prototype's method.",
    }),
    sources: sourceResult ? [source(sourceResult, "LinkedIn", "geo")] : [],
    linkedin: followers !== null ? `${followers.toLocaleString("en-US")} followers` : pageUrl ? "LinkedIn page found; follower count not available" : "No LinkedIn company page found",
  };
}
