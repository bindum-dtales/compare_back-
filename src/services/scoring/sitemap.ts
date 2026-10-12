// Sitemap collection (spec §5: "site crawl plus sitemap parsing; count posts and publish dates",
// "sitemap lastmod"). Sitemaps are read through Jina, which renders an XML sitemap as HTML:
// one `<a href="loc">` + `<time>lastmod</time>` per entry, titled "Sitemap" or "Sitemap Index".
// Raw XML (<loc>/<lastmod>) is parsed too.

import { isSameSite } from "../jina.service.js";
import type { JinaPage } from "../jina.service.js";
import type { WebsiteResearch } from "../../types/website.js";

export interface SitemapEntry {
  url: string;
  /** ISO date string as published; null when the sitemap gives none. */
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: "index" | "urlset";
  entries: SitemapEntry[];
}

/** Owned-content sections named by the spec (blog, resources, case studies) and their usual synonyms. */
export const CONTENT_PATH = /\/(blogs?|articles?|resources?|insights?|news|guides?|case-stud(?:y|ies)|posts?|stories|learn|library)(\/|$)/i;

/** Sitemap fetches per company: an index plus one child keeps a job inside Jina's keyless rate limit. */
export const MAX_SITEMAP_FETCHES = 2;
const MAX_ENTRIES = 5_000;
const MAX_SKIPPED_RECORDED = 20;

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const validDate = (s: string | undefined) => (s && !Number.isNaN(Date.parse(s)) ? s : null);

/** Null when the page isn't a sitemap (e.g. an SPA answering every path with its index.html). */
export function parseSitemap(body: string, title: string | null = null): ParsedSitemap | null {
  const entries: SitemapEntry[] = [];
  const pageTitle = (title ?? /<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? "").trim();
  const xml = /<urlset\b|<sitemapindex\b/i.test(body);
  if (!xml && !/^sitemap( index)?$/i.test(pageTitle)) return null;
  const index = /<sitemapindex\b/i.test(body) || /^sitemap index$/i.test(pageTitle);

  // Raw XML.
  for (const m of body.matchAll(/<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[1]!)?.[1];
    if (loc) entries.push({ url: decode(loc), lastmod: validDate(/<lastmod>([\s\S]*?)<\/lastmod>/i.exec(m[1]!)?.[1]?.trim()) });
  }
  // Jina's rendering.
  if (!entries.length) {
    for (const m of body.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*(?:<br\s*\/?>\s*)?(?:<time>([^<]*)<\/time>)?/gi)) {
      entries.push({ url: decode(m[1]!), lastmod: validDate(m[2]?.trim()) });
    }
  }
  return { kind: index ? "index" : "urlset", entries: entries.slice(0, MAX_ENTRIES) };
}

export interface SitemapFacts {
  /** Sitemap URLs requested, in order. */
  fetched: string[];
  /** Declared or found sitemaps we did not fetch: other hosts, or over the per-company limit. */
  skipped: { url: string; reason: string }[];
  /** True when at least one sitemap was read. */
  found: boolean;
  /** True when a fetch failed, so absence can't be concluded. */
  failed: boolean;
  /** Page entries (index entries excluded), deduplicated. */
  entries: SitemapEntry[];
}

export type FetchPage = (url: string) => Promise<JinaPage>;

/**
 * Reads the sitemaps declared in robots.txt (or /sitemap.xml when none are declared), following
 * one level of sitemap index, preferring a child that looks like a content sitemap.
 */
export async function collectSitemap(domain: string, website: WebsiteResearch, fetchPage: FetchPage): Promise<SitemapFacts> {
  const facts: SitemapFacts = { fetched: [], skipped: [], found: false, failed: false, entries: [] };
  const declared = website.robotsTxt?.sitemaps ?? [];
  const queue = declared.length ? [...declared] : [`https://${domain}/sitemap.xml`];
  const seen = new Map<string, SitemapEntry>();

  const skip = (url: string, reason: string) => {
    if (facts.skipped.length < MAX_SKIPPED_RECORDED) facts.skipped.push({ url, reason });
  };

  while (queue.length) {
    const url = queue.shift()!;
    if (!isSameSite(url, domain)) {
      skip(url, "not on the company's domain");
      continue;
    }
    if (facts.fetched.length >= MAX_SITEMAP_FETCHES) {
      skip(url, "sitemap fetch limit reached");
      continue;
    }
    facts.fetched.push(url);
    let page: JinaPage;
    try {
      page = await fetchPage(url);
    } catch (e) {
      console.warn("[scoring] sitemap unavailable:", url, e instanceof Error ? e.name : "error");
      facts.failed = true;
      continue;
    }
    if (page.httpStatus !== null && page.httpStatus >= 400) continue; // no sitemap there
    const parsed = parseSitemap(page.body, page.title);
    if (!parsed?.entries.length) continue;
    facts.found = true;
    if (parsed.kind === "index") {
      // Content sitemaps first, then the declared order.
      const children = [...parsed.entries].sort((a, b) => Number(CONTENT_PATH.test(b.url) || /post|blog/i.test(b.url)) - Number(CONTENT_PATH.test(a.url) || /post|blog/i.test(a.url)));
      queue.unshift(...children.map((c) => c.url));
    } else {
      for (const e of parsed.entries) if (!seen.has(e.url)) seen.set(e.url, e);
    }
  }
  facts.entries = [...seen.values()];
  return facts;
}
