// Extra website text for category detection, collected only when the homepage facts are too thin
// to ground a category on (fewer than MIN_WORDS words).
//
// Seen on thejewelleryshow.in, a single-page app: Jina's HTML read returns the app shell (an empty
// <div id="root">), and its cached text read is the same shell, so the homepage has a title, a meta
// description and nothing else. An uncached text read renders the app and has the real content.
//
// Bounded, in order, stopping as soon as there is enough text:
//  1. the homepage's visible text, read once more uncached (with the links Jina saw after rendering);
//  2. at most MAX_EXTRA_PAGES pages of the same domain that look like About / Products / Services /
//     Exhibitors / Events pages, chosen from links found on the homepage, read in parallel.
// Every read goes through fetchSitePage (same-site only, timeout, one retry for transient errors).
// Failures are logged and skipped: with too little text, detectCategory still fails as
// insufficient_evidence. Nothing collected here is stored in website_data or used for scoring.

import { fetchSitePage, JinaError, type JinaOptions, type JinaPage } from "./jina.service.js";
import { categoryCorpus, categoryEvidence, MIN_WORDS, type CategoryPage } from "./category.service.js";
import { normalizeDomain } from "../utils/domain.js";
import type { WebsiteResearch } from "../types/website.js";

export const MAX_EXTRA_PAGES = 2;
/** Per read; the uncached render took 6–38s in testing. */
const READ_TIMEOUT_MS = 40_000;
/** Text kept per page before the category step's own budget applies. */
const MAX_PAGE_CHARS = 20_000;

// Earlier groups rank first. Matched against the URL path and the link text, whole words.
const RELEVANT: RegExp[] = [
  /\b(about|about[\s_-]?us|who[\s_-]?we[\s_-]?are|our[\s_-]?story|company)\b/i,
  /\b(products?|services?|solutions?|what[\s_-]?we[\s_-]?do|offerings?|catalog(ue)?|collections?)\b/i,
  /\b(exhibitors?|exhibitions?|exhibit|events?|shows?|upcoming[\s_-]?\w*)\b/i,
];
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|mp4|mp3|xml|json|txt|css|js)$/i;

/** Jina's provider-side refusals: more reads would fail the same way, so stop. */
const PROVIDER_DOWN = new Set(["insufficient_balance", "upstream_error", "rate_limited", "network", "invalid_domain"]);

const wordsOf = (companyName: string, domain: string, website: WebsiteResearch, pages: CategoryPage[]) =>
  categoryCorpus(categoryEvidence(companyName, domain, website, pages)).words;

const pageOk = (p: JinaPage) => (p.httpStatus === null || p.httpStatus < 400) && p.body.trim().length > 0;

/**
 * Up to `max` same-domain pages worth reading for the category, best first. Only http(s) URLs on
 * exactly `domain` (subdomains and other sites are skipped), never the homepage itself, no files,
 * one URL per path (query strings and fragments dropped).
 */
export function relevantPages(domain: string, links: { url: string; text: string }[], max = MAX_EXTRA_PAGES): string[] {
  const ranked = new Map<string, number>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) continue;
    if (normalizeDomain(url.hostname) !== domain) continue;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || NOT_A_PAGE.test(path)) continue;
    const page = `https://${domain}${path}`;
    const label = `${safeDecode(path).replace(/[/_-]+/g, " ")} ${link.text}`;
    const rank = RELEVANT.findIndex((re) => re.test(label));
    if (rank >= 0 && rank < (ranked.get(page) ?? Infinity)) ranked.set(page, rank);
  }
  return [...ranked].sort((a, b) => a[1] - b[1]).slice(0, max).map(([url]) => url);
}

function safeDecode(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const failureKind = (e: unknown) => (e instanceof JinaError ? e.kind : "error");

/** Extra pages for detectCategory; empty when the homepage already has enough text. */
export async function collectCategoryPages(companyName: string, domain: string, website: WebsiteResearch, opts: JinaOptions = {}): Promise<CategoryPage[]> {
  if (wordsOf(companyName, domain, website, []) >= MIN_WORDS) return [];
  const read = { timeoutMs: READ_TIMEOUT_MS, ...opts };
  const pages: CategoryPage[] = [];
  const homepage = `https://${domain}/`;

  let rendered: JinaPage | null = null;
  try {
    rendered = await fetchSitePage({ domain, url: homepage, format: "text", fresh: true, withLinks: true }, read);
  } catch (e) {
    console.warn("[category] rendered homepage unavailable for", domain, failureKind(e));
    if (PROVIDER_DOWN.has(failureKind(e))) return pages;
  }
  if (rendered && pageOk(rendered)) pages.push({ url: homepage, text: rendered.body.slice(0, MAX_PAGE_CHARS) });
  if (wordsOf(companyName, domain, website, pages) >= MIN_WORDS) return pages;

  const urls = relevantPages(domain, [...website.links, ...(rendered?.links ?? [])]);
  const reads = await Promise.allSettled(urls.map((url) => fetchSitePage({ domain, url, format: "text", fresh: true }, read)));
  reads.forEach((r, i) => {
    if (r.status === "fulfilled" && pageOk(r.value)) pages.push({ url: urls[i]!, text: r.value.body.slice(0, MAX_PAGE_CHARS) });
    else if (r.status === "rejected") console.warn("[category] page unavailable for", domain, failureKind(r.reason));
  });
  return pages;
}
