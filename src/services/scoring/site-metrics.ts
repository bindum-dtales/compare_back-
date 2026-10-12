// Sub-metrics computed from the company's own site (homepage facts, robots.txt, sitemap).
// Pure and deterministic. Each check is a signal named for that metric in spec §4/§5.

import { isSameSite } from "../jina.service.js";
import { normalizeDomain } from "../../utils/domain.js";
import { CAPS, MAX_ANSWER_WORDS, MIN_ANSWER_WORDS, RECENT_DAYS, count, metric, pass, unknown, type MetricResult } from "./rubric.js";
import { isAllowed, parseRobots } from "./robots.js";
import { CONTENT_PATH, type SitemapFacts } from "./sitemap.js";
import type { WebsiteHeading, WebsiteResearch } from "../../types/website.js";

export interface SiteFacts {
  domain: string;
  website: WebsiteResearch;
  sitemap: SitemapFacts;
  now: Date;
}

const DAY_MS = 86_400_000;
const countWords = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const daysAgo = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY_MS;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Spec §5 AEO crawlability: "robots.txt rules targeting GPTBot, ClaudeBot, PerplexityBot, and CCBot". */
export const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot"] as const;
const SEARCH_CRAWLERS = ["Googlebot", "Bingbot"] as const;

/** schema.org types Google can show as a rich result (FAQ, how-to, article, breadcrumb, product, review…). */
const RICH_RESULT_TYPES = new Set([
  "FAQPage", "QAPage", "HowTo", "Article", "BlogPosting", "NewsArticle", "TechArticle", "BreadcrumbList", "Product",
  "Review", "AggregateRating", "Event", "Recipe", "VideoObject", "SoftwareApplication", "Course", "JobPosting", "Dataset",
]);
const ARTICLE_TYPES = ["Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle"];

const QUESTION = /\?\s*$|^(what|how|why|when|where|who|which|can|could|does|do|is|are|should|will)\b/i;
const NOT_A_POST = new Set(["page", "tag", "tags", "category", "categories", "author", "authors", "feed", "rss"]);

const isNoindex = (metaRobots: string | null) => !!metaRobots && /\b(noindex|none)\b/i.test(metaRobots);

/** Path segments of a URL, including hash routes ("/#/blogs/post" → ["blogs", "post"]). */
function segments(url: string): string[] {
  try {
    const u = new URL(url);
    const path = u.hash.startsWith("#/") ? `${u.pathname}${u.hash.slice(1)}` : u.pathname;
    return path.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/** An owned-content page: under a blog/resources/case-studies section, below the section index. */
export function isContentPage(url: string): boolean {
  const segs = segments(url);
  const i = segs.findIndex((s) => CONTENT_PATH.test(`/${s}/`));
  return i >= 0 && i < segs.length - 1 && !segs.slice(i + 1).some((s) => NOT_A_POST.has(s.toLowerCase()));
}

const isContentSection = (url: string) => segments(url).some((s) => CONTENT_PATH.test(`/${s}/`));

export function isQuestionHeading(h: WebsiteHeading) {
  return QUESTION.test(h.text);
}

export function hasConciseAnswer(h: WebsiteHeading) {
  if (!h.followingText) return false;
  const n = countWords(h.followingText);
  return n >= MIN_ANSWER_WORDS && n <= MAX_ANSWER_WORDS;
}

/** Which of `agents` robots.txt blocks from "/"; null when robots.txt couldn't be fetched (unknown). */
function blockedAgents(website: WebsiteResearch, agents: readonly string[]): string[] | null {
  const robots = website.robotsTxt;
  if (!robots) return null;
  if (!robots.found) return [];
  const groups = parseRobots(robots.content ?? "");
  return agents.filter((a) => !isAllowed(groups, a, "/"));
}

const robotsDetail = (website: WebsiteResearch, blocked: string[]) =>
  blocked.length ? `robots.txt disallows ${blocked.join(", ")} from /` : website.robotsTxt?.found ? "Allowed by robots.txt" : "No robots.txt: nothing is disallowed";

// --- SEO -------------------------------------------------------------------------------

export function technical({ domain, website, sitemap }: SiteFacts): MetricResult {
  const status = website.httpStatus;
  const blocked = blockedAgents(website, SEARCH_CRAWLERS);
  const crawlersLabel = "robots.txt lets search engines (Googlebot, Bingbot) crawl the homepage";
  return metric(
    [
      status === null
        ? unknown("technical.reachable", "Homepage returns HTTP 2xx", "The reader did not report the HTTP status")
        : pass("technical.reachable", "Homepage returns HTTP 2xx", status >= 200 && status < 300, `HTTP ${status}`),
      pass("technical.indexable", "Homepage is not marked noindex", !isNoindex(website.metaRobots), website.metaRobots ? `meta robots: ${website.metaRobots}` : "No meta robots tag (indexable by default)"),
      pass(
        "technical.canonical",
        "Canonical URL set on the company's own domain",
        !!website.canonical && isSameSite(website.canonical, domain),
        website.canonical ? `canonical: ${website.canonical}` : "No canonical link",
      ),
      blocked
        ? pass("technical.searchCrawlers", crawlersLabel, blocked.length === 0, robotsDetail(website, blocked))
        : unknown("technical.searchCrawlers", crawlersLabel, "robots.txt could not be fetched"),
      !sitemap.found && sitemap.failed
        ? unknown("technical.sitemap", "XML sitemap available", "The sitemap could not be fetched")
        : pass("technical.sitemap", "XML sitemap available", sitemap.found, sitemap.found ? `${plural(sitemap.entries.length, "URL")} in ${sitemap.fetched.join(", ")}` : "No sitemap found"),
    ],
    { notMeasured: ["JS-render fallback (headless render diffed against raw HTML): pages are read only through the reader's render"] },
  );
}

export function content({ domain, website, sitemap, now }: SiteFacts): MetricResult {
  const linked = website.links.filter((l) => l.internal || isSameSite(l.url, domain)).map((l) => l.url);
  const urls = [...new Set([...sitemap.entries.map((e) => e.url), ...linked])];
  const section = urls.find(isContentSection);
  const pages = urls.filter(isContentPage);

  const dated = sitemap.entries.filter((e) => isContentPage(e.url) && e.lastmod);
  const lastYear = dated.filter((e) => daysAgo(e.lastmod!, now) <= 365).length;
  const cadence =
    !sitemap.found && sitemap.failed
      ? unknown("content.cadence", "Content pages updated in the last 12 months", "The sitemap could not be fetched")
      : dated.length
        ? count("content.cadence", "Content pages updated in the last 12 months", lastYear, CAPS.contentPagesLastYear, `${lastYear} of ${plural(dated.length, "dated content page")} updated in the last 12 months (cap ${CAPS.contentPagesLastYear})`)
        : pass("content.cadence", "Content pages updated in the last 12 months", false, "No content pages with update dates in the sitemap");

  return metric(
    [
      pass("content.section", "Owned content section (blog, resources, case studies)", !!section, section ? `Found: ${section}` : "No blog, resources or case-study section linked or in the sitemap"),
      count("content.pages", "Owned content pages", pages.length, CAPS.contentPages, `${plural(pages.length, "content page")} in the sitemap and homepage links (cap ${CAPS.contentPages})`),
      cadence,
    ],
    { notMeasured: ["Pages beyond the sitemap and homepage links (no full-site crawl)"] },
  );
}

// --- AEO -------------------------------------------------------------------------------

export function structured({ website }: SiteFacts): MetricResult {
  const types = website.structuredData.types;
  const articles = types.filter((t) => ARTICLE_TYPES.includes(t));
  return metric(
    [
      pass("structured.jsonld", "schema.org JSON-LD present", types.length > 0, types.length ? `Types: ${types.join(", ")}` : "No JSON-LD on the homepage"),
      pass("structured.faq", "FAQPage schema", types.includes("FAQPage"), types.includes("FAQPage") ? "FAQPage found" : "No FAQPage schema"),
      pass("structured.article", "Article schema", articles.length > 0, articles.length ? `Found: ${articles.join(", ")}` : "No Article schema"),
    ],
    { notMeasured: ["Schema on inner pages: only the homepage is parsed"] },
  );
}

export function directAnswer({ website }: SiteFacts): MetricResult {
  const questions = website.headings.filter(isQuestionHeading);
  const answered = questions.filter(hasConciseAnswer);
  return metric([
    count(
      "directAnswer.questions",
      "Question-style headings",
      questions.length,
      CAPS.questionHeadings,
      questions.length ? `${plural(questions.length, "question heading")}, e.g. "${questions[0]!.text}" (cap ${CAPS.questionHeadings})` : "No question-style headings",
    ),
    questions.length
      ? count(
          "directAnswer.concise",
          `Question headings immediately followed by a concise answer (${MIN_ANSWER_WORDS}–${MAX_ANSWER_WORDS} words)`,
          answered.length,
          questions.length,
          `${answered.length} of ${plural(questions.length, "question heading")} answered concisely`,
        )
      : pass("directAnswer.concise", `Question headings immediately followed by a concise answer (${MIN_ANSWER_WORDS}–${MAX_ANSWER_WORDS} words)`, false, "No question headings to answer"),
  ]);
}

export function snippet({ website }: SiteFacts): MetricResult {
  const rich = website.structuredData.types.filter((t) => RICH_RESULT_TYPES.has(t));
  const answered = website.headings.filter((h) => isQuestionHeading(h) && hasConciseAnswer(h));
  return metric(
    [
      pass("snippet.richResultSchema", "Rich-result eligible schema", rich.length > 0, rich.length ? `Found: ${rich.join(", ")}` : "No rich-result schema types"),
      pass("snippet.answerBlock", "A question heading with a concise answer (featured-snippet shape)", answered.length > 0, answered.length ? `e.g. "${answered[0]!.text}"` : "None found"),
    ],
    {
      notMeasured: ["Actual featured-snippet / People Also Ask positions"],
      proxy: "No Search Console or SERP-feature source connected: inferred from structured data and direct-answer formatting, as the prototype did.",
    },
  );
}

export function crawlability({ website }: SiteFacts): MetricResult {
  const blocked = blockedAgents(website, AI_CRAWLERS);
  return metric([
    pass("crawlability.noindex", "No noindex directive", !isNoindex(website.metaRobots), website.metaRobots ? `meta robots: ${website.metaRobots}` : "No meta robots tag"),
    ...AI_CRAWLERS.map((a) =>
      blocked
        ? pass(`crawlability.${a.toLowerCase()}`, `${a} may crawl the site`, !blocked.includes(a), robotsDetail(website, blocked.filter((b) => b === a)))
        : unknown(`crawlability.${a.toLowerCase()}`, `${a} may crawl the site`, "robots.txt could not be fetched"),
    ),
  ]);
}

// --- GEO -------------------------------------------------------------------------------

export function freshness({ website, sitemap, now }: SiteFacts): MetricResult {
  const year = now.getUTCFullYear();
  const dates = sitemap.entries.map((e) => e.lastmod).filter((d): d is string => !!d);
  const newest = dates.length ? dates.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null;
  const recentContent = sitemap.entries.filter((e) => isContentPage(e.url) && e.lastmod && daysAgo(e.lastmod, now) <= RECENT_DAYS).length;
  const sitemapUnknown = !sitemap.found && sitemap.failed;

  return metric(
    [
      pass(
        "freshness.copyright",
        "Copyright notice shows the current year",
        website.copyrightYear !== null && website.copyrightYear >= year,
        website.copyrightYear !== null ? `© ${website.copyrightYear}` : "No copyright year found on the homepage",
      ),
      sitemapUnknown
        ? unknown("freshness.lastModified", `Site updated in the last ${RECENT_DAYS} days (sitemap lastmod)`, "The sitemap could not be fetched")
        : pass(
            "freshness.lastModified",
            `Site updated in the last ${RECENT_DAYS} days (sitemap lastmod)`,
            !!newest && daysAgo(newest, now) <= RECENT_DAYS,
            newest ? `Newest sitemap lastmod: ${newest}` : "No lastmod dates in the sitemap",
          ),
      sitemapUnknown
        ? unknown("freshness.cadence", `Content published or updated in the last ${RECENT_DAYS} days`, "The sitemap could not be fetched")
        : count(
            "freshness.cadence",
            `Content published or updated in the last ${RECENT_DAYS} days`,
            recentContent,
            CAPS.contentPagesRecent,
            `${plural(recentContent, "content page")} updated in the last ${RECENT_DAYS} days (cap ${CAPS.contentPagesRecent})`,
          ),
    ],
    { notMeasured: ["HTTP Last-Modified header: the reader does not return response headers"] },
  );
}

export function clarity({ domain, website }: SiteFacts): MetricResult {
  const label = domain.split(".")[0]!;
  const finalDomain = normalizeDomain(website.finalUrl);
  const subdomains = new Set<string>();
  const otherDomains = new Set<string>();
  for (const l of website.links) {
    const host = normalizeDomain(l.url);
    if (!host || host === domain) continue;
    if (host.endsWith(`.${domain}`)) subdomains.add(host);
    else if (host.split(".").slice(0, -1).includes(label)) otherDomains.add(host);
  }
  const fragment = (n: number) => Math.max(0, 1 - n / CAPS.extraBrandHosts);
  return metric(
    [
      pass(
        "clarity.noRedirect",
        "Homepage stays on the company's domain (no redirect to another brand domain)",
        !!finalDomain && isSameSite(website.finalUrl, domain),
        finalDomain && !isSameSite(website.finalUrl, domain) ? `Redirects to ${finalDomain}` : `Served from ${finalDomain ?? domain}`,
      ),
      {
        id: "clarity.subdomains",
        label: "Content not split across sub-domains",
        value: fragment(subdomains.size),
        detail: subdomains.size ? `Links to ${[...subdomains].join(", ")} (0 at ${CAPS.extraBrandHosts})` : "No other sub-domains linked from the homepage",
      },
      {
        id: "clarity.otherDomains",
        label: "No separate brand domains",
        value: fragment(otherDomains.size),
        detail: otherDomains.size ? `Links to ${[...otherDomains].join(", ")} (0 at ${CAPS.extraBrandHosts})` : `No other "${label}" domains linked from the homepage`,
      },
    ],
    { notMeasured: ["Cross-reference against known product URLs: no product-URL inventory source"] },
  );
}
