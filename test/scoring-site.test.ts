import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPS, count, metric, pass, scoreChecks, unknown } from "../src/services/scoring/rubric.js";
import { isAllowed, parseRobots } from "../src/services/scoring/robots.js";
import { collectSitemap, parseSitemap, type SitemapFacts } from "../src/services/scoring/sitemap.js";
import * as site from "../src/services/scoring/site-metrics.js";
import { fetchSitePage, JinaError, type JinaPage } from "../src/services/jina.service.js";
import { mockFetch } from "./jina-fixtures.js";
import { website } from "./discovery-fixtures.js";
import type { WebsiteResearch } from "../src/types/website.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-10-04T00:00:00Z");
const noSitemap: SitemapFacts = { fetched: ["https://acme.com/sitemap.xml"], skipped: [], found: false, failed: false, entries: [] };
const sitemapOf = (entries: SitemapFacts["entries"], extra: Partial<SitemapFacts> = {}): SitemapFacts => ({ ...noSitemap, found: true, entries, ...extra });
const facts = (w: Partial<WebsiteResearch> = {}, sitemap: SitemapFacts = noSitemap): site.SiteFacts => ({ domain: "acme.com", website: website(w), sitemap, now: NOW });
const robotsFile = (content: string) => ({ found: true, httpStatus: 200, sitemaps: [], content });
const values = (m: { checks: { id: string; value: number | null }[] }) => Object.fromEntries(m.checks.map((c) => [c.id, c.value]));

describe("rubric", () => {
  it("averages measured checks equally and leaves unknown ones out", () => {
    expect(scoreChecks([pass("a", "A", true, ""), pass("b", "B", false, "")])).toBe(50);
    expect(scoreChecks([pass("a", "A", true, ""), unknown("b", "B", "fetch failed")])).toBe(100);
    expect(scoreChecks([count("a", "A", 5, 20, ""), pass("b", "B", true, "")])).toBe(63); // (0.25 + 1) / 2
  });

  it("caps count checks at 1", () => {
    expect(count("a", "A", 50, 20, "").value).toBe(1);
  });

  it("refuses to score a metric with nothing measured", () => {
    expect(() => metric([unknown("a", "A", "?")])).toThrow(RangeError);
  });
});

describe("robots.txt rules", () => {
  const groups = parseRobots(`
User-agent: *
Disallow: /admin
Allow: /

User-agent: GPTBot
User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /private
Allow: /private/public$

# comment
User-agent: PerplexityBot
Disallow:
`);

  it("groups consecutive user-agents and applies the most specific group", () => {
    expect(isAllowed(groups, "GPTBot")).toBe(false);
    expect(isAllowed(groups, "ccbot")).toBe(false); // case-insensitive
    expect(isAllowed(groups, "ClaudeBot")).toBe(true); // own group, no rule for /
    expect(isAllowed(groups, "Googlebot")).toBe(true); // falls back to *
    expect(isAllowed(groups, "Googlebot", "/admin/x")).toBe(false);
  });

  it("uses the longest match, Allow on ties, wildcards and $ anchors", () => {
    expect(isAllowed(groups, "ClaudeBot", "/private/x")).toBe(false);
    expect(isAllowed(groups, "ClaudeBot", "/private/public")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /*.pdf$"), "x", "/a/b.pdf")).toBe(false);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /\nAllow: /"), "x", "/")).toBe(true);
  });

  it("treats an empty Disallow and no matching group as allowed", () => {
    expect(isAllowed(groups, "PerplexityBot")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: OtherBot\nDisallow: /"), "GPTBot")).toBe(true);
  });
});

describe("sitemap parsing", () => {
  it("reads Jina's rendering of a sitemap (links + <time> lastmod)", () => {
    const html =
      '<html><head><title>Sitemap</title></head><body><div><a href="https://acme.com/blog/a">https://acme.com/blog/a</a><br><time>2026-09-01</time></div>' +
      '<div><a href="https://acme.com/about?x=1&amp;y=2">x</a><br><time></time></div></body></html>';
    expect(parseSitemap(html, "Sitemap")).toEqual({
      kind: "urlset",
      entries: [
        { url: "https://acme.com/blog/a", lastmod: "2026-09-01" },
        { url: "https://acme.com/about?x=1&y=2", lastmod: null },
      ],
    });
  });

  it("reads raw XML urlsets and sitemap indexes", () => {
    expect(parseSitemap("<urlset><url><loc>https://acme.com/</loc><lastmod>2026-01-02</lastmod></url></urlset>")).toEqual({
      kind: "urlset",
      entries: [{ url: "https://acme.com/", lastmod: "2026-01-02" }],
    });
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://acme.com/post-sitemap.xml</loc></sitemap></sitemapindex>")?.kind).toBe("index");
    expect(parseSitemap('<html><head><title>Sitemap Index</title></head><body><a href="https://acme.com/s1.xml">s</a></body></html>')?.kind).toBe("index");
  });

  it("does not mistake an SPA's index.html for a sitemap", () => {
    expect(parseSitemap('<html><head><title>Acme</title></head><body><a href="https://acme.com/x">x</a></body></html>', "Acme")).toBeNull();
  });
});

describe("collectSitemap", () => {
  const page = (url: string, body: string, title = "Sitemap", httpStatus = 200): JinaPage => ({ requestedUrl: url, url, title, description: null, metadata: {}, canonical: null, httpStatus, body });
  const urlset = (...urls: [string, string?][]) => urls.map(([u, d]) => `<div><a href="${u}">${u}</a><br><time>${d ?? ""}</time></div>`).join("");
  const withRobots = (...sitemaps: string[]) => website({ robotsTxt: { found: true, httpStatus: 200, sitemaps, content: "" } });

  it("tries /sitemap.xml when robots.txt declares none", async () => {
    const fetchPage = vi.fn(async (url: string) => page(url, urlset(["https://acme.com/blog/a", "2026-09-01"])));
    const facts = await collectSitemap("acme.com", website(), fetchPage);
    expect(fetchPage).toHaveBeenCalledWith("https://acme.com/sitemap.xml");
    expect(facts).toMatchObject({ found: true, failed: false, entries: [{ url: "https://acme.com/blog/a", lastmod: "2026-09-01" }] });
  });

  it("follows an index to its content sitemap first, within the fetch limit, skipping other hosts", async () => {
    const fetchPage = vi.fn(async (url: string) =>
      url.endsWith("/sitemap_index.xml")
        ? page(url, urlset(["https://acme.com/page-sitemap.xml"], ["https://acme.com/post-sitemap.xml"], ["https://cdn.other.net/x.xml"]), "Sitemap Index")
        : page(url, urlset(["https://acme.com/blog/post"])),
    );
    const facts = await collectSitemap("acme.com", withRobots("https://www.acme.com/sitemap_index.xml"), fetchPage);
    expect(facts.fetched).toEqual(["https://www.acme.com/sitemap_index.xml", "https://acme.com/post-sitemap.xml"]);
    expect(facts.skipped).toEqual([
      { url: "https://acme.com/page-sitemap.xml", reason: "sitemap fetch limit reached" },
      { url: "https://cdn.other.net/x.xml", reason: "not on the company's domain" },
    ]);
    expect(facts.entries.map((e) => e.url)).toEqual(["https://acme.com/blog/post"]);
  });

  it("records a failed fetch as unknown, and a 404 or non-sitemap as absent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await collectSitemap("acme.com", website(), async () => Promise.reject(new JinaError("timeout", "slow")));
    expect(failed).toMatchObject({ found: false, failed: true });
    const missing = await collectSitemap("acme.com", website(), async (url) => page(url, "Not found", "404", 404));
    expect(missing).toMatchObject({ found: false, failed: false });
    const spa = await collectSitemap("acme.com", website(), async (url) => page(url, '<a href="https://acme.com/x">x</a>', "Acme"));
    expect(spa).toMatchObject({ found: false, failed: false });
  });
});

describe("fetchSitePage", () => {
  it("reads same-site URLs through Jina and refuses anything else without a request", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({ data: { url: "https://blog.acme.com/sitemap.xml", html: "<urlset></urlset>", httpStatus: 200 } })));
    await expect(fetchSitePage({ domain: "acme.com", url: "https://blog.acme.com/sitemap.xml" })).resolves.toMatchObject({ body: "<urlset></urlset>" });
    expect(fetch.mock.calls[0]![0]).toBe("https://r.jina.ai/https://blog.acme.com/sitemap.xml");
    for (const url of ["https://evil.com/sitemap.xml", "https://acme.com.evil.com/x", "ftp://acme.com/x", "http://127.0.0.1/x"]) {
      await expect(fetchSitePage({ domain: "acme.com", url })).rejects.toMatchObject({ kind: "invalid_domain" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSitePage engines", () => {
  it("sends X-Engine and the format for the hidden-assets passes, and nothing extra by default", async () => {
    const fetch = mockFetch(() => new Response(JSON.stringify({ data: { url: "https://acme.com/", html: "<p>x</p>", text: "x", httpStatus: 200 } })));
    await fetchSitePage({ domain: "acme.com", url: "https://acme.com/", engine: "direct" });
    await fetchSitePage({ domain: "acme.com", url: "https://acme.com/", format: "text", engine: "browser" });
    await fetchSitePage({ domain: "acme.com", url: "https://acme.com/sitemap.xml" });
    const headers = fetch.mock.calls.map(([, init]) => init?.headers as Record<string, string>);
    expect(headers[0]).toMatchObject({ "X-Engine": "direct", "X-Return-Format": "html" });
    expect(headers[1]).toMatchObject({ "X-Engine": "browser", "X-Return-Format": "text" });
    expect(headers[2]).not.toHaveProperty("X-Engine");
  });
});

describe("SEO technical", () => {
  it("passes a reachable, indexable, canonical site with a sitemap that search engines may crawl", () => {
    const m = site.technical(facts({ robotsTxt: robotsFile("User-agent: *\nDisallow: /admin") }, sitemapOf([{ url: "https://acme.com/", lastmod: null }])));
    expect(m.score).toBe(100);
    expect(m.notMeasured[0]).toMatch(/JS-render/);
  });

  it("fails noindex, a foreign canonical, blocked crawlers and a missing sitemap", () => {
    const m = site.technical(facts({ httpStatus: 200, metaRobots: "noindex, follow", canonical: "https://other.com/", robotsTxt: robotsFile("User-agent: Googlebot\nDisallow: /") }));
    expect(values(m)).toEqual({ "technical.reachable": 1, "technical.indexable": 0, "technical.canonical": 0, "technical.searchCrawlers": 0, "technical.sitemap": 0 });
    expect(m.checks.find((c) => c.id === "technical.searchCrawlers")?.detail).toBe("robots.txt disallows Googlebot from /");
    expect(m.score).toBe(20);
  });

  it("leaves robots and sitemap checks out when they couldn't be fetched", () => {
    const m = site.technical(facts({ robotsTxt: null }, { ...noSitemap, failed: true }));
    expect(values(m)).toMatchObject({ "technical.searchCrawlers": null, "technical.sitemap": null });
    expect(m.score).toBe(100); // the three measured checks pass
  });
});

describe("SEO content", () => {
  const post = (n: number, lastmod: string | null) => ({ url: `https://acme.com/blog/post-${n}`, lastmod });

  it("counts owned content pages (not section, tag or pagination pages) against the cap, and yearly cadence", () => {
    const entries = [
      { url: "https://acme.com/blog", lastmod: null },
      { url: "https://acme.com/blog/tag/seo", lastmod: "2026-09-01" },
      { url: "https://acme.com/blog/page/2", lastmod: "2026-09-01" },
      ...Array.from({ length: 6 }, (_, i) => post(i, i < 3 ? "2026-08-01" : "2024-01-01")),
    ];
    const m = site.content(facts({}, sitemapOf(entries)));
    expect(values(m)).toEqual({ "content.section": 1, "content.pages": 6 / CAPS.contentPages, "content.cadence": 3 / CAPS.contentPagesLastYear });
  });

  it("finds content linked from the homepage, including hash routes, when there is no sitemap", () => {
    const m = site.content(
      facts({
        links: [
          { url: "https://acme.com/#/blogs", text: "Blog", internal: true },
          { url: "https://acme.com/#/case-studies/fintech", text: "Case", internal: true },
        ],
      }),
    );
    expect(values(m)).toEqual({ "content.section": 1, "content.pages": 1 / CAPS.contentPages, "content.cadence": 0 });
  });

  it("scores 0 when the site has no content section", () => {
    expect(site.content(facts()).score).toBe(0);
  });
});

describe("AEO structured / direct answer / snippet", () => {
  const sd = (...types: string[]) => ({ structuredData: { types, items: [], invalidBlocks: 0 } });

  it("structured: JSON-LD presence, FAQ and Article schema", () => {
    expect(site.structured(facts(sd())).score).toBe(0);
    expect(site.structured(facts(sd("Organization"))).score).toBe(33);
    expect(site.structured(facts(sd("Organization", "FAQPage", "BlogPosting"))).score).toBe(100);
  });

  it("direct answer: question headings, and how many are followed by a concise answer", () => {
    const headings = [
      { level: 2 as const, text: "What is Acme?", followingText: "Acme is a content agency for B2B software companies." },
      { level: 2 as const, text: "How do we work", followingText: `${"word ".repeat(80)}` }, // too long to be a direct answer
      { level: 2 as const, text: "Our services", followingText: "We write." },
    ];
    const m = site.directAnswer(facts({ headings }));
    expect(values(m)).toEqual({ "directAnswer.questions": 2 / CAPS.questionHeadings, "directAnswer.concise": 0.5 });
    expect(site.directAnswer(facts({ headings: [] })).score).toBe(0);
  });

  it("snippet: inferred from rich-result schema and answer blocks, labelled as a proxy", () => {
    const m = site.snippet(facts({ ...sd("BreadcrumbList"), headings: [{ level: 2, text: "Why Acme?", followingText: "Because we write accurate technical content." }] }));
    expect(m.score).toBe(100);
    expect(m.proxy).toMatch(/inferred/);
    expect(site.snippet(facts(sd("Organization", "WebSite"))).score).toBe(0);
  });
});

describe("AEO crawlability (AI crawlers)", () => {
  it("checks noindex and robots.txt rules for GPTBot, ClaudeBot, PerplexityBot and CCBot", () => {
    const m = site.crawlability(facts({ robotsTxt: robotsFile("User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /") }));
    expect(values(m)).toEqual({
      "crawlability.noindex": 1,
      "crawlability.gptbot": 0,
      "crawlability.claudebot": 1,
      "crawlability.perplexitybot": 1,
      "crawlability.ccbot": 0,
    });
    expect(m.score).toBe(60);
  });

  it("treats a missing robots.txt as allowing everything, and an unfetchable one as unknown", () => {
    expect(site.crawlability(facts({ robotsTxt: { found: false, httpStatus: 404, sitemaps: [], content: null } })).score).toBe(100);
    const unknownRobots = site.crawlability(facts({ robotsTxt: null, metaRobots: "noindex" }));
    expect(unknownRobots.checks.filter((c) => c.value === null)).toHaveLength(4);
    expect(unknownRobots.score).toBe(0); // only noindex was measured
  });
});

describe("GEO freshness", () => {
  it("checks the copyright year, the newest sitemap lastmod and recent content", () => {
    const m = site.freshness(facts({ copyrightYear: 2026 }, sitemapOf([{ url: "https://acme.com/blog/a", lastmod: "2026-09-20" }, { url: "https://acme.com/", lastmod: "2025-01-01" }])));
    expect(values(m)).toEqual({ "freshness.copyright": 1, "freshness.lastModified": 1, "freshness.cadence": 1 / CAPS.contentPagesRecent });
  });

  it("scores a stale site 0 and leaves sitemap checks out when the sitemap couldn't be fetched", () => {
    expect(site.freshness(facts({ copyrightYear: 2023 }, sitemapOf([{ url: "https://acme.com/blog/a", lastmod: "2025-01-01" }]))).score).toBe(0);
    expect(site.freshness(facts({ copyrightYear: null })).checks[0]!.detail).toBe("No copyright year found on the homepage");
    const m = site.freshness(facts({ copyrightYear: 2026 }, { ...noSitemap, failed: true }));
    expect(values(m)).toEqual({ "freshness.copyright": 1, "freshness.lastModified": null, "freshness.cadence": null });
    expect(m.score).toBe(100);
  });
});

describe("GEO brand clarity", () => {
  it("is full for one coherent domain", () => {
    expect(site.clarity(facts({ links: [{ url: "https://acme.com/about", text: "", internal: true }, { url: "https://twitter.com/acme", text: "", internal: false }] })).score).toBe(100);
  });

  it("drops for a redirect to another domain, linked sub-domains and other brand domains", () => {
    const m = site.clarity(
      facts({
        finalUrl: "https://acmehq.io/",
        links: [
          { url: "https://app.acme.com/login", text: "", internal: false },
          { url: "https://docs.acme.com/", text: "", internal: false },
          { url: "https://acme.io/", text: "", internal: false },
        ],
      }),
    );
    const v = values(m);
    expect(v["clarity.noRedirect"]).toBe(0);
    expect(v["clarity.subdomains"]).toBeCloseTo(1 / 3); // 2 sub-domains of the cap of 3
    expect(v["clarity.otherDomains"]).toBeCloseTo(2 / 3); // acme.io (acmehq.io doesn't share the "acme" label)
    expect(m.checks[0]!.detail).toBe("Redirects to acmehq.io");
  });
});
