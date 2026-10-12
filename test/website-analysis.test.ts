import { describe, expect, it } from "vitest";
import { analyzeWebsite, countWords } from "../src/services/website-analysis.js";
import type { FetchedWebsite } from "../src/services/jina.service.js";
import type { JinaPage } from "../src/services/jina.service.js";
import { HOMEPAGE_HTML, ROBOTS_TXT } from "./jina-fixtures.js";

const page = (body: string, extra: Partial<JinaPage> = {}): JinaPage => ({
  requestedUrl: "https://acme.com/",
  url: "https://acme.com/",
  title: null,
  description: null,
  metadata: {},
  canonical: null,
  httpStatus: 200,
  body,
  ...extra,
});

const site = (html: string, robotsTxt: JinaPage | null = null, extra: Partial<JinaPage> = {}): FetchedWebsite => ({
  domain: "acme.com",
  page: page(html, extra),
  robotsTxt,
});

const full = analyzeWebsite(site(HOMEPAGE_HTML, page(ROBOTS_TXT, { requestedUrl: "https://acme.com/robots.txt" })), new Date("2026-10-02T00:00:00Z"));

describe("analyzeWebsite", () => {
  it("extracts title, description, language, canonical, robots meta and social tags", () => {
    expect(full).toMatchObject({
      source: "jina-reader",
      url: "https://acme.com/",
      finalUrl: "https://acme.com/",
      httpStatus: 200,
      title: "Acme | Widgets for teams",
      description: "Acme makes widgets.", // whitespace collapsed
      language: "en",
      canonical: "https://acme.com/",
      metaRobots: "index, follow",
      openGraph: { "og:title": "Acme" },
      twitter: { "twitter:card": "summary" },
      fetchedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("extracts headings in order, keeping words in adjacent inline elements apart and skipping empty ones", () => {
    expect(full.headings).toEqual([
      { level: 1, text: "AI Native widgets", followingText: "We build widgets & gadgets for teams." },
      { level: 2, text: "Pricing", followingText: null }, // only links follow it, and the empty h3 isn't a heading
    ]);
  });

  it("pairs each heading with the first paragraph or list item after it, not one past the next heading", () => {
    const r = analyzeWebsite(
      site(`<body>
        <section><h2>What is Acme?</h2><div><p>Acme is a widget platform for small teams.</p><p>Second paragraph.</p></div></section>
        <h2>How does it work?</h2><h3>Steps</h3><ul><li>Connect your tools</li></ul>
      </body>`),
    );
    expect(r.headings).toEqual([
      { level: 2, text: "What is Acme?", followingText: "Acme is a widget platform for small teams." },
      { level: 2, text: "How does it work?", followingText: null },
      { level: 3, text: "Steps", followingText: "Connect your tools" },
    ]);
  });

  it("reads the latest copyright year from the full visible text, ranges included", () => {
    const year = (html: string) => analyzeWebsite(site(html)).copyrightYear;
    expect(year("<footer>© 2025 Acme Inc.</footer>")).toBe(2025);
    expect(year("<footer>Copyright 2019–2026 Acme</footer>")).toBe(2026);
    expect(year("<footer>&copy; 2024 Acme</footer>")).toBe(2024);
    expect(year(`<p>${"word ".repeat(5_000)}</p><footer>(c) 2023</footer>`)).toBe(2023); // past the 20 000-char content cut
    expect(year("<p>Founded in 2010.</p>")).toBeNull();
  });

  it("extracts unique absolute http(s) links and marks internal ones by normalized domain", () => {
    expect(full.links).toEqual([
      { url: "https://acme.com/", text: "Home", internal: true },
      { url: "https://acme.com/about", text: "About us", internal: true },
      { url: "https://www.acme.com/about", text: "About again", internal: true }, // www. is the same site
      { url: "https://blog.acme.com/post", text: "Blog", internal: false }, // other subdomains aren't
      { url: "https://twitter.com/acme", text: "Twitter", internal: false },
    ]); // mailto:, javascript: and the duplicate "/" are dropped
  });

  it("counts only visible words (no script/style/head)", () => {
    expect(full.content).toBe("Home About us About again AI Native widgets We build widgets & gadgets for teams. Pricing Blog Twitter Email Nothing Home duplicate");
    expect(full.content).not.toContain("secret");
    expect(full.wordCount).toBe(21); // the lone "&" is not a word
    expect(full.contentTruncated).toBe(false);
  });

  it("parses JSON-LD, including arrays and @graph, and counts invalid blocks", () => {
    expect(full.structuredData.types).toEqual(["Organization", "WebSite", "Thing", "BreadcrumbList"]);
    expect(full.structuredData.items).toHaveLength(3);
    expect(full.structuredData.invalidBlocks).toBe(1);
  });

  it("reads robots.txt sitemaps", () => {
    expect(full.robotsTxt).toEqual({
      found: true,
      httpStatus: 200,
      sitemaps: ["https://acme.com/sitemap.xml", "https://acme.com/sitemap-blog.xml"],
      content: ROBOTS_TXT,
    });
  });

  it("reports missing optional fields as null/empty instead of guessing", () => {
    const bare = analyzeWebsite(site("<html><body><p>Hello world</p></body></html>"));
    expect(bare).toMatchObject({
      title: null,
      description: null,
      language: null,
      canonical: null,
      metaRobots: null,
      openGraph: {},
      twitter: {},
      headings: [],
      links: [],
      structuredData: { types: [], items: [], invalidBlocks: 0 },
      robotsTxt: null, // couldn't be fetched → unknown
      content: "Hello world",
      wordCount: 2,
      copyrightYear: null,
    });
  });

  it("falls back to what Jina reported when the HTML lacks it", () => {
    const r = analyzeWebsite(
      site("<html><body></body></html>", null, {
        title: "From Jina",
        canonical: "https://acme.com/home",
        metadata: { lang: "de", description: "Meta from Jina", robots: "noindex" },
      }),
    );
    expect(r).toMatchObject({ title: "From Jina", canonical: "https://acme.com/home", language: "de", description: "Meta from Jina", metaRobots: "noindex" });
  });

  it("does not treat an SPA's HTML fallback or a 404 as a robots.txt", () => {
    const spa = analyzeWebsite(site("<html></html>", page("<!DOCTYPE html><html><body>App</body></html>")));
    expect(spa.robotsTxt).toEqual({ found: false, httpStatus: 200, sitemaps: [], content: null });
    const missing = analyzeWebsite(site("<html></html>", page("User-agent: *", { httpStatus: 404 })));
    expect(missing.robotsTxt?.found).toBe(false);
  });

  it("resolves relative links against the final URL after redirects", () => {
    const r = analyzeWebsite(site('<a href="pricing">P</a>', null, { url: "https://acme.com/en/" }));
    expect(r.links).toEqual([{ url: "https://acme.com/en/pricing", text: "P", internal: true }]);
  });

  it("truncates long content but counts every word", () => {
    const r = analyzeWebsite(site(`<body><p>${"word ".repeat(10_000)}</p></body>`));
    expect(r.contentTruncated).toBe(true);
    expect(r.content.length).toBe(20_000);
    expect(r.wordCount).toBe(10_000);
  });
});

describe("countWords", () => {
  it("counts tokens with a letter or digit", () => {
    expect(countWords("  Hello,  world — 2026 & co ")).toBe(4);
    expect(countWords("")).toBe(0);
  });
});
