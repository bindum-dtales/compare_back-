// Deterministic candidate handling: search results → deduplicated company candidates with
// explainable signals, and a first-pass classification. Pure functions, no I/O.

import { normalizeDomain } from "../utils/domain.js";
import type { SearchResult } from "./search.service.js";
import type { CandidateSignals, CategoryResult, CompetitorCandidate, RejectedResult } from "../types/discovery.js";

// Sites whose search results are about other companies, not a company competing in the
// category: search engines, social networks, directories/review/listing sites, marketplaces,
// publishers and encyclopedias. Matched on the domain and all its subdomains.
// Only sites that are never a competing company belong here; vendors that are competitors in
// some categories (HubSpot, Semrush…) are left to evaluation.
const NOT_A_COMPANY: Record<string, string[]> = {
  "search engine": ["google.com", "bing.com", "duckduckgo.com", "yahoo.com", "baidu.com", "yandex.com", "ask.com", "ecosia.org", "brave.com"],
  "social profile": [
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "pinterest.com",
    "reddit.com", "quora.com", "threads.net", "github.com", "behance.net", "dribbble.com", "medium.com", "substack.com",
  ],
  "directory or review site": [
    "clutch.co", "g2.com", "capterra.com", "goodfirms.co", "designrush.com", "sortlist.com", "themanifest.com", "agencyspotter.com",
    "upcity.com", "expertise.com", "topdevelopers.co", "techreviewer.co", "selectedfirms.co", "appfutura.com", "trustpilot.com",
    "yelp.com", "glassdoor.com", "indeed.com", "crunchbase.com", "zoominfo.com", "owler.com", "tracxn.com", "cbinsights.com",
    "softwareadvice.com", "getapp.com", "trustradius.com", "sourceforge.net", "alternativeto.net", "producthunt.com", "wellfound.com", "builtin.com", "f6s.com", "ambitionbox.com", "justdial.com",
    "yellowpages.com", "bbb.org", "manta.com", "dnb.com", "gartner.com", "forrester.com",
    // Software review / "best X" testing sites (seen in website-builder and SaaS searches).
    "cybernews.com", "tooltester.com", "emailtooltester.com", "websiteplanet.com", "sitebuilderreport.com", "expertmarket.com",
    "websitebuilderexpert.com", "top10.com", "saasworthy.com", "slashdot.org", "saashub.com", "softwaresuggest.com", "featuredcustomers.com",
  ],
  marketplace: ["upwork.com", "fiverr.com", "freelancer.com", "toptal.com", "peopleperhour.com", "amazon.com", "ebay.com"],
  "publication or encyclopedia": [
    "wikipedia.org", "forbes.com", "techcrunch.com", "entrepreneur.com", "inc.com", "businessinsider.com", "hbr.org",
    "wired.com", "theverge.com", "zdnet.com", "cnbc.com", "bloomberg.com", "reuters.com", "nytimes.com", "economictimes.indiatimes.com",
    "yourstory.com", "inc42.com",
    "techradar.com", "pcmag.com", "cnet.com", "tomsguide.com", "techrepublic.com", "makeuseof.com", "digitaltrends.com", "lifewire.com",
    "engadget.com", "mashable.com", "thenextweb.com", "venturebeat.com", "nerdwallet.com", "investopedia.com", "g2crowd.com",
  ],
  // Free hosting subdomains: no independent company identity.
  "hosted site": ["blogspot.com", "wordpress.com", "wixsite.com", "webflow.io", "github.io", "vercel.app", "netlify.app", "notion.site", "carrd.co", "medium.com"],
};

const isUnder = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

// Hostnames that name a review/ranking/listing site rather than a company: a subdomain such as
// "reviews.example.com" or "best-website-builders.example.com", or a hyphenated domain such as
// "website-builder-reviews.com". Whole words only: "topdesk.com" or "bestbuy.com" don't match.
const REVIEW_SUBDOMAIN_WORDS = new Set(["review", "reviews", "best", "top", "compare", "comparison", "comparisons", "ranking", "rankings", "alternative", "alternatives", "directory", "listing", "listings", "vs"]);
const REVIEW_DOMAIN_WORDS = new Set(["review", "reviews", "ranking", "rankings", "alternatives", "comparison", "comparisons", "directory"]);

function reviewHostname(domain: string): boolean {
  const labels = domain.split(".");
  // Registrable label = the one before the public suffix (approximated: before the last 1–2 labels).
  const suffixLength = labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? 2 : 1;
  const registrable = labels.length - suffixLength - 1;
  return labels.slice(0, registrable + 1).some((label, i) => {
    const words = label.split("-");
    if (i < registrable) return words.some((w) => REVIEW_SUBDOMAIN_WORDS.has(w));
    return words.length > 1 && words.some((w) => REVIEW_DOMAIN_WORDS.has(w));
  });
}

// --- Galleries, showcases, template collections, directories -------------------------------
//
// Sites whose business is listing other companies' sites, designs, templates or products. Unlike
// NOT_A_COMPANY these are category-aware: they are competitors of each other, so none of this
// applies when the researched category is itself such a site ("Website Inspiration Gallery",
// "Digital Asset Marketplace", "AI Tools Directory").

/** Category words that mark the researched company as a gallery/directory/marketplace itself. */
const LISTING_CATEGORY_TERMS = new Set(["gallery", "showcase", "inspiration", "directory", "marketplace", "template", "theme", "listing", "award", "collection", "curation"]);

export const isListingCategory = (terms: string[]) => terms.some((t) => LISTING_CATEGORY_TERMS.has(t));

// Well-known sites of this kind (domain and all its subdomains). Hard-rejected before evaluation.
const THIRD_PARTY_SITES: Record<string, string[]> = {
  "gallery or showcase site": [
    "onepagelove.com", "awwwards.com", "siteinspire.com", "land-book.com", "lapa.ninja", "landingfolio.com", "saaslandingpage.com",
    "godly.website", "httpster.net", "cssdesignawards.com", "minimal.gallery", "mobbin.com",
  ],
  "template marketplace": ["themeforest.net", "envato.com", "codecanyon.net", "templatemonster.com", "creativemarket.com", "ui8.net"],
  "directory or listing site": ["theresanaiforthat.com", "futurepedia.io", "toolify.ai", "stackshare.io", "betalist.com"],
};

// Hostnames that name a gallery/showcase: a subdomain ("inspiration.example.com"), a hyphenated
// domain ("web-design-gallery.com") or the .gallery TLD. Whole words only, like reviewHostname.
const GALLERY_HOST_WORDS = new Set(["gallery", "galleries", "showcase", "showcases", "inspiration", "inspo"]);

function galleryHostname(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.at(-1) === "gallery") return true;
  const suffixLength = labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? 2 : 1;
  const registrable = labels.length - suffixLength - 1;
  return labels.slice(0, registrable + 1).some((label, i) => {
    const words = label.split("-");
    return (i < registrable || words.length > 1) && words.some((w) => GALLERY_HOST_WORDS.has(w));
  });
}

/** Why a domain is a third-party gallery/template/directory site rather than a competitor, or null. */
export function thirdPartySiteReason(domain: string, terms: string[]): string | null {
  if (isListingCategory(terms)) return null;
  for (const [reason, roots] of Object.entries(THIRD_PARTY_SITES)) if (roots.some((r) => isUnder(domain, r))) return reason;
  if (galleryHostname(domain)) return "gallery or showcase site";
  return null;
}

/** Why a domain can't be a competitor, or null. The listed roots are also Tavily's exclude list. */
export function nonCompanyReason(domain: string): string | null {
  if (/(^|\.)google\.[a-z.]+$/.test(domain)) return "search engine";
  for (const [reason, roots] of Object.entries(NOT_A_COMPANY)) if (roots.some((r) => isUnder(domain, r))) return reason;
  if (reviewHostname(domain)) return "review or listing site";
  return null;
}

export const EXCLUDED_DOMAINS = [...new Set(Object.values(NOT_A_COMPANY).flat())];

// --- Category terms --------------------------------------------------------------------

const STOPWORDS = new Set([
  "and", "or", "of", "for", "the", "a", "an", "to", "in", "on", "with", "by", "&", "company", "companies", "firm", "firms",
  "provider", "providers", "service", "services", "solution", "solutions", "business", "businesses",
]);

/** Crude singular stem so "agencies" matches "agency" and "platforms" matches "platform". */
const stem = (w: string) => (w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w);

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function categoryTerms(category: Pick<CategoryResult, "category" | "subcategory">): string[] {
  return [...new Set(words(`${category.category} ${category.subcategory ?? ""}`).filter((w) => !STOPWORDS.has(w)).map(stem))];
}

// A title that reads as an article about products, not a product: lists ("Top 10 …", "Best website
// builders in 2026"), reviews and tests ("… Reviewed", "300+ hours of testing"), comparisons and
// alternatives. A vendor's own marketing title ("Website Builder – Create a Website | Wix") doesn't.
const LISTICLE = new RegExp(
  [
    String.raw`\b(top|best)\s+\d+\b`,
    String.raw`\b\d+\+?\s+(best|top|leading|great|free)\b`,
    String.raw`^\W*(the\s+)?(\d+\s+)?(best|top)\b`, // starts with "Best …" / "The top …"
    String.raw`\b(best|top)\b[^|–—]{0,60}\b(in|of|for)\s+(\w+\s+)?20\d\d\b`, // "best website builders in October 2026"
    String.raw`\blist of\b`,
    String.raw`\balternatives?\b`,
    String.raw`\bvs\.?\s`,
    String.raw`\bversus\b`,
    String.raw`\bcompetitors\b`,
    String.raw`\breviews?\b`,
    String.raw`\breviewed\b`,
    String.raw`\branking`,
    String.raw`\branked\b`,
    String.raw`\btested\b`,
    String.raw`\b(expert|hands-on|months of|hours of)\s+(testing|tests)\b`,
    String.raw`\bcompared\b`,
    String.raw`\bbuyer'?s guide\b`,
  ].join("|"),
  "i",
);

// A URL path for content about products rather than a product page: reviews, rankings, "best/top X",
// comparisons, alternatives, directories, blog/news articles. On a company's own domain such a page
// can still belong to a competitor (Simvoly's "best website builder" post), so it is a signal for the
// classifier, not a rejection.
const EDITORIAL_PATH = /(^|\/)(reviews?|best|top|alternatives?|compare|comparisons?|vs|versus|directory|directories|lists?|rankings?|blog|blogs|news|articles?|guides?|resources)(\/|$)|(^|\/|-)(best|top)-|-(vs|versus)-|-(alternatives?|reviews?|comparisons?)(\/|$|-)/i;

// A result that reads as a site listing other sites, designs, templates or products: "Website
// Inspiration", "… Gallery", "Showcase", "Directory", "a collection of 500 templates", "websites,
// curated", "submit your site". Not a rejection on its own (a vendor's own gallery page, like
// framer.com/gallery, can read the same): it keeps the result from being accepted without the
// classifier, which judges the company that owns the domain.
const DIRECTORY_TITLE = /\b(inspiration|inspo|showcases?|galler(y|ies)|director(y|ies)|awards)\b/i;
const DIRECTORY_TEXT = new RegExp(
  [
    String.raw`\b(websites?|sites?|web ?design|designs?|ui|ux|landing pages?|logos?)\s+(inspiration|galler(y|ies)|showcases?)\b`,
    String.raw`\b(sites|websites|designs|examples|landing pages|tools|startups|apps|resources),?\s+(curated|hand-?picked)\b`,
    String.raw`\b(curated|hand-?picked)\s+(\w+\s+){0,2}(sites|websites|designs|examples|landing pages|collection|list|directory|tools|startups|apps|resources)\b`,
    String.raw`\b(directory|marketplace|collection|showcase|gallery|database)\s+of\s+(the\s+)?(\w+\s+){0,3}(websites|sites|tools|apps|templates|themes|startups|companies|products|software|agencies|designs|resources)\b`,
    String.raw`\bsubmit\s+(your|a)\s+(site|website|tool|startup|app|product|listing)\b`,
    String.raw`\b(website|design|template|theme)s?\s+marketplace\b`,
  ].join("|"),
  "i",
);
const DIRECTORY_PATH = /(^|\/)(galler(y|ies)|showcases?|inspiration)(\/|$)/i;

export function signalsFor(result: SearchResult, terms: string[]): CandidateSignals {
  const text = new Set(words(`${result.title} ${result.snippet}`).map(stem));
  const hits = terms.filter((t) => text.has(t)).length;
  let path = "/";
  try {
    path = new URL(result.url).pathname;
  } catch {
    // unreachable: callers pass URLs that already normalized
  }
  return {
    categoryRelevance: terms.length ? Math.round((hits / terms.length) * 100) / 100 : 0,
    homepage: path === "/" || path === "",
    listicle: LISTICLE.test(result.title),
    editorialPage: EDITORIAL_PATH.test(path),
    directoryLike:
      !isListingCategory(terms) &&
      (DIRECTORY_TITLE.test(result.title) || DIRECTORY_TEXT.test(`${result.title}\n${result.snippet.slice(0, 500)}`) || DIRECTORY_PATH.test(path)),
    searchScore: result.score,
  };
}

// --- Names -----------------------------------------------------------------------------

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Company name from a result title: the title segment ("Acme | Home", "Home - Acme") that
 * matches the domain's first label, else the domain itself. Never invented.
 */
export function nameFromTitle(title: string, domain: string): string {
  const label = compact(domain.split(".")[0]!);
  const segments = title.split(/\s+[|\-–—:·•]\s+/).map((s) => s.trim()).filter(Boolean);
  const match = segments.find((s) => {
    const c = compact(s);
    return c.length >= 2 && c.length <= label.length + 12 && (c.includes(label) || label.includes(c));
  });
  return match ?? domain;
}

// --- Extraction ------------------------------------------------------------------------

export interface TaggedResult extends SearchResult {
  query: string;
}

/**
 * Search results → candidates. Drops invalid URLs, IPs/localhost (normalizeDomain rejects
 * them), the target (and its subdomains), non-company sites; merges duplicate domains,
 * keeping the best-scored result as the representative.
 */
export function extractCandidates(
  results: TaggedResult[],
  targetDomain: string,
  category: Pick<CategoryResult, "category" | "subcategory">,
): { candidates: CompetitorCandidate[]; rejected: RejectedResult[] } {
  const terms = categoryTerms(category);
  const byDomain = new Map<string, CompetitorCandidate>();
  const rejected: RejectedResult[] = [];

  for (const r of results) {
    const domain = /^https?:\/\//i.test(r.url) ? normalizeDomain(r.url) : null;
    const reject = (reason: string) => rejected.push({ url: r.url, domain, reason, query: r.query });
    if (!domain) {
      reject("invalid URL");
      continue;
    }
    if (isUnder(domain, targetDomain) || isUnder(targetDomain, domain)) {
      reject("the target company itself");
      continue;
    }
    const nonCompany = nonCompanyReason(domain) ?? thirdPartySiteReason(domain, terms);
    if (nonCompany) {
      reject(nonCompany);
      continue;
    }

    const existing = byDomain.get(domain);
    if (existing) {
      if (!existing.sourceQueries.includes(r.query)) existing.sourceQueries.push(r.query);
      const better = (r.score ?? 0) > (existing.signals.searchScore ?? 0);
      const signals = signalsFor(r, terms);
      // Prefer the homepage as the representative result, then the higher score.
      if ((signals.homepage && !existing.signals.homepage) || (signals.homepage === existing.signals.homepage && better)) {
        Object.assign(existing, { url: r.url, title: r.title, snippet: r.snippet, name: nameFromTitle(r.title, domain), signals });
      }
      continue;
    }
    byDomain.set(domain, {
      name: nameFromTitle(r.title, domain),
      domain,
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      sourceQueries: [r.query],
      signals: signalsFor(r, terms),
    });
  }
  return { candidates: [...byDomain.values()], rejected };
}

// --- First-pass classification -----------------------------------------------------------

export type Triage = { kind: "classify" } | { kind: "rejected"; reason: string };

/**
 * Deterministic rejection only: an inner page with no category signal at all. Everything else goes to
 * the LLM classifier, which judges the company that owns the domain; nothing is accepted here. A
 * homepage whose title names the category is not enough to be a competitor (onepagelove.com, "One
 * Page Website Inspiration and Templates", was accepted for Carrd that way).
 */
export function triage(c: CompetitorCandidate): Triage {
  if (c.signals.categoryRelevance === 0 && !c.signals.homepage) return { kind: "rejected", reason: "An inner page whose title and description share no terms with the category." };
  return { kind: "classify" };
}

/** Order for evaluation and selection: stronger category match, homepages, then search rank. */
export const rank = (c: CompetitorCandidate) =>
  c.signals.categoryRelevance +
  (c.signals.homepage ? 0.3 : 0) -
  (c.signals.listicle ? 0.2 : 0) -
  (c.signals.editorialPage ? 0.1 : 0) -
  (c.signals.directoryLike ? 0.2 : 0) +
  0.2 * (c.signals.searchScore ?? 0);
