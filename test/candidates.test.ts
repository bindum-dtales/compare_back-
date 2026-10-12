import { describe, expect, it } from "vitest";
import { categoryTerms, extractCandidates, nameFromTitle, nonCompanyReason, signalsFor, thirdPartySiteReason, triage, type TaggedResult } from "../src/services/candidates.js";
import { buildQueries } from "../src/services/competitor.service.js";
import { CARRD_CATEGORY, CARRD_RESULTS, CATEGORY, result } from "./discovery-fixtures.js";

const tagged = (url: string, title = "Some Company", snippet = "", score = 0.5, query = "q1"): TaggedResult => ({ ...result(url, title, snippet, score), query });
const extract = (...results: TaggedResult[]) => extractCandidates(results, "dtales.tech", CATEGORY);

describe("extractCandidates", () => {
  it("normalizes candidate domains", () => {
    const { candidates } = extract(tagged("https://WWW.Acme.com/about?x=1#top"), tagged("http://beta.io"));
    expect(candidates.map((c) => c.domain)).toEqual(["acme.com", "beta.io"]);
  });

  it("removes duplicate domains, merging their queries and preferring the homepage result", () => {
    const { candidates } = extract(
      tagged("https://acme.com/blog/post", "A post", "", 0.9, "q1"),
      tagged("https://www.acme.com/", "Acme | Content agency", "", 0.4, "q2"),
      tagged("https://acme.com/pricing", "Pricing", "", 0.95, "q1"),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ domain: "acme.com", url: "https://www.acme.com/", name: "Acme", sourceQueries: ["q1", "q2"] });
  });

  it.each(["https://dtales.tech/services", "https://www.dtales.tech/", "http://DTALES.tech", "https://blog.dtales.tech/post"])(
    "never returns the target as its own competitor: %s",
    (url) => {
      const { candidates, rejected } = extract(tagged(url));
      expect(candidates).toEqual([]);
      expect(rejected[0]).toMatchObject({ reason: "the target company itself" });
    },
  );

  it.each([
    ["not a URL", "not a url"],
    ["relative URL", "/acme"],
    ["IP address", "http://192.168.0.1/"],
    ["localhost", "http://localhost:3000/"],
    ["non-http scheme", "ftp://acme.com/"],
    ["javascript", "javascript:alert(1)"],
  ])("rejects invalid URLs: %s", (_name, url) => {
    const { candidates, rejected } = extract(tagged(url));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe("invalid URL");
  });

  it.each([
    ["https://clutch.co/agencies/content-marketing", "directory or review site"],
    ["https://www.g2.com/categories/x", "directory or review site"],
    ["https://in.linkedin.com/company/acme", "social profile"],
    ["https://www.google.co.in/search?q=x", "search engine"],
    ["https://en.wikipedia.org/wiki/Content_marketing", "publication or encyclopedia"],
    ["https://www.upwork.com/hire/writers", "marketplace"],
    ["https://acme.wixsite.com/home", "hosted site"],
  ])("filters out non-company sites: %s", (url, reason) => {
    const { candidates, rejected } = extract(tagged(url));
    expect(candidates).toEqual([]);
    expect(rejected[0]?.reason).toBe(reason);
  });

  it("keeps small, unknown companies", () => {
    expect(extract(tagged("https://tinyagency.studio/", "Tiny Agency")).candidates).toHaveLength(1);
  });
});

describe("signals and triage", () => {
  const terms = categoryTerms(CATEGORY);

  it("derives category terms without filler words", () => {
    expect(terms).toEqual(["content", "marketing", "agency", "b2b", "technical"]);
  });

  it("scores category relevance, homepage and listicle signals", () => {
    expect(signalsFor(result("https://acme.com/", "Acme | B2B Content Marketing Agencies", "Technical content."), terms)).toEqual({
      categoryRelevance: 1,
      homepage: true,
      listicle: false,
      editorialPage: false,
      directoryLike: false,
      searchScore: 0.5,
    });
    expect(signalsFor(result("https://x.com/blog/top-10", "Top 10 content marketing agencies in 2026"), terms)).toMatchObject({ homepage: false, listicle: true });
  });

  it("accepts nothing itself: rejects an unrelated inner page, sends the rest (even a clear homepage match) to the LLM", () => {
    const [strong, unrelated, listicle] = extract(
      tagged("https://acme.com/", "Acme | B2B Technical Content Marketing Agency"),
      tagged("https://plumbing.com/blog/pipes", "Fixing pipes", "How to fix a leak"),
      tagged("https://agency.io/blog/top-10", "Top 10 content marketing agencies", "Our list of agencies"),
    ).candidates;
    expect(strong!.signals).toMatchObject({ homepage: true, categoryRelevance: 1 });
    expect(triage(strong!)).toEqual({ kind: "classify" });
    expect(triage(unrelated!)).toMatchObject({ kind: "rejected" });
    expect(triage(listicle!)).toEqual({ kind: "classify" });
  });

  it("names a candidate from its title, or falls back to the domain", () => {
    expect(nameFromTitle("Home - Acme Content", "acmecontent.com")).toBe("Acme Content");
    expect(nameFromTitle("Acme | B2B agency", "acme.com")).toBe("Acme");
    expect(nameFromTitle("Top 10 agencies in 2026", "listy.io")).toBe("listy.io");
  });

  it("knows non-company domains", () => {
    expect(nonCompanyReason("clutch.co")).toBe("directory or review site");
    expect(nonCompanyReason("acme.com")).toBeNull();
  });
});

describe("buildQueries", () => {
  it("builds at most 3 distinct queries from the category, most specific first", () => {
    expect(buildQueries(CATEGORY)).toEqual([
      "top B2B Technical Content Marketing Agencies",
      "top Content Marketing Agencies",
      "B2B Technical Content Marketing Agency competitors",
    ]);
  });

  it("uses 'companies' for non-countable categories and skips the duplicate without a subcategory", () => {
    expect(buildQueries({ category: "Payroll Software", subcategory: null })).toEqual(["top Payroll Software companies", "Payroll Software competitors"]);
  });
});

describe("review, listicle and editorial results are not competitors (website-builder search, as observed)", () => {
  const BUILDER = { ...CATEGORY, category: "Website Builder", subcategory: null };
  const extractFor = (...results: TaggedResult[]) => extractCandidates(results, "carrd.co", BUILDER);
  const rejectedReason = (url: string, title = "Website builders") => extractFor(tagged(url, title)).rejected[0]?.reason ?? null;

  it.each([
    ["https://website-builders.cybernews.com/", "Best Website Builders in October 2026 (Months of Expert Testing)"], // selected for Wix before this fix
    ["https://www.techradar.com/news/the-best-website-builder", "The best website builders of 2026: 80+ platforms tested | TechRadar"],
    ["https://www.pcmag.com/picks/the-best-website-builders", "The Best Website Builders We've Tested for 2026 | PCMag"],
    ["https://www.tooltester.com/en/blog/ai-website-builder", "AI Website Builders: We Test Out 16 Of The Best"],
    ["https://www.sitebuilderreport.com/easiest-website-builders", "The 7 Easiest Website Builders For Beginners In 2026"],
    ["https://www.expertmarket.com/website-builders/best-ai-website-builders", "The 5 Best AI Website Builders: 300+ Hours of Testing"],
    ["https://www.websiteplanet.com/blog/best-one-page-website-builders", "9 Best One-Page Website Builders in 2026"],
    ["https://www.capterra.com/website-builder-software/", "Best Website Builder Software 2026"],
    ["https://www.g2.com/categories/website-builder", "Best Website Builder Software"],
  ])("rejects review publishers and directories before evaluation: %s", (url, title) => {
    expect(rejectedReason(url, title)).toMatch(/directory or review site|publication/);
  });

  it.each([
    "https://reviews.hostingblog.net/website-builders",
    "https://best-website-builders.example.org/",
    "https://top.example.net/builders",
    "https://compare.siteguide.io/wix-vs-squarespace",
    "https://website-builder-reviews.com/",
    "https://builder-rankings.co.uk/",
  ])("rejects review/ranking/comparison hostnames: %s", (url) => {
    expect(rejectedReason(url)).toBe("review or listing site");
  });

  it.each([
    ["https://launchthedamnthing.com/blog/best-website-builders", "7 Best Website Builders for 2026 (& Why None of them Are AI)"],
    ["https://sitebuilderhub.net/", "Best Website Builders in October 2026 (Months of Expert Testing)"], // a homepage, but titled as an article
    ["https://titan.email/best-ai-website-builders", "The 10 Best AI Website Builders in 2026: A Global Guide"],
    ["https://startupnotes.io/wix-alternatives", "Website Builder Alternatives to Wix"],
    ["https://startupnotes.io/wix-vs-squarespace", "Wix vs Squarespace: Which Website Builder?"],
    ["https://growthdesk.io/top-website-builders", "Top Website Builders Ranked for Small Business"],
    ["https://webdesignweekly.com/news/website-builder-market", "Website builder market moves this week"],
    ["https://affiliate-deals.io/website-builder", "Website Builder Deals Reviewed: Save 50%"],
  ])("never accepts an article-like page without the classifier: %s", (url, title) => {
    const { candidates } = extractFor(tagged(url, title, "Website builders compared."));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.signals.listicle || candidates[0]!.signals.editorialPage).toBe(true);
    expect(triage(candidates[0]!)).toEqual({ kind: "classify" });
  });

  it("keeps legitimate competitors, including pages under content paths on their own domain", () => {
    const { candidates, rejected } = extractFor(
      tagged("https://www.squarespace.com/", "Website Builder – Easily Create Your Own Website — Squarespace", "Website builder."),
      tagged("https://www.wix.com/ai-website-builder", "Free AI Website Builder - Create A Website In Minutes | Wix.com"),
      tagged("https://simvoly.com/the-best-website-builder", "Best Website Builder 2026: Top 7 Platforms Reviewed (Tested)", "Simvoly is a website and funnel builder."),
      tagged("https://webflow.com/compare/wix", "Webflow vs Wix | Webflow"),
      tagged("https://www.godaddy.com/websites/website-builder/pricing", "Website Builder Pricing | GoDaddy"),
      tagged("https://www.jimdo.com/blog/website-builder-guide", "How to build a website with Jimdo"),
      tagged("https://topdesk.com/", "TOPdesk website builder"), // "top" inside a word, not a ranking site
      tagged("https://reviewpro.com/", "ReviewPro site builder"),
      tagged("https://compare.io/", "Compare.io website builder"),
    );
    expect(rejected).toEqual([]);
    expect(candidates.map((c) => c.domain)).toEqual(["squarespace.com", "wix.com", "simvoly.com", "webflow.com", "godaddy.com", "jimdo.com", "topdesk.com", "reviewpro.com", "compare.io"]);
    // A vendor's own marketing title isn't an article; its homepage goes to the classifier like every candidate.
    expect(triage(candidates[0]!)).toEqual({ kind: "classify" });
    expect(candidates[1]!.signals).toMatchObject({ listicle: false, editorialPage: false });
  });
});

describe("galleries, showcases, template collections and directories are not competitors (Carrd search, as observed)", () => {
  const carrd = (results = CARRD_RESULTS) => extractCandidates(results.map((r) => ({ ...r, query: "q" })), "carrd.co", CARRD_CATEGORY);
  const ONE_PAGE_LOVE = CARRD_RESULTS.find((r) => r.url === "https://onepagelove.com")!;

  it("rejects onepagelove.com before evaluation", () => {
    const { candidates, rejected } = carrd();
    expect(candidates.map((c) => c.domain)).not.toContain("onepagelove.com");
    expect(rejected).toEqual([{ url: "https://onepagelove.com", domain: "onepagelove.com", reason: "gallery or showcase site", query: "q" }]);
  });

  it("a homepage whose title matches the category but reads as a gallery is never accepted without the classifier", () => {
    // The same real result on a domain no list knows: it now goes to the LLM instead of being accepted.
    const [c] = carrd([{ ...ONE_PAGE_LOVE, url: "https://onepagecurated.net/" }]).candidates;
    expect(c!.signals).toMatchObject({ homepage: true, listicle: false, editorialPage: false, directoryLike: true });
    expect(c!.signals.categoryRelevance).toBeGreaterThanOrEqual(0.6); // why it used to be accepted outright
    expect(triage(c!)).toEqual({ kind: "classify" });
  });

  it("sends every remaining Carrd candidate, real builders included, to the classifier; none is accepted outright", () => {
    const byDomain = Object.fromEntries(carrd().candidates.map((c) => [c.domain, c]));
    for (const d of ["yola.com", "onepage.io", "squarespace.com", "wix.com", "godaddy.com", "experte.com", "seedprod.com", "zapier.com", "launchthedamnthing.com"]) {
      expect(triage(byDomain[d]!)).toEqual({ kind: "classify" });
    }
  });

  it.each([
    "awwwards.com", "www.siteinspire.com", "land-book.com", "lapa.ninja", "landingfolio.com", "godly.website", "themeforest.net",
    "elements.envato.com", "templatemonster.com", "creativemarket.com", "theresanaiforthat.com", "futurepedia.io",
    "web-design-inspiration.net", "website-showcase.io", "inspiration.designsite.com", "bestwebsite.gallery",
  ])("rejects obvious gallery, template and directory sites: %s", (domain) => {
    expect(thirdPartySiteReason(domain, categoryTerms(CARRD_CATEGORY))).toMatch(/gallery|template|directory/);
  });

  it.each(["webflow.com", "framer.com", "wix.com", "carrd.co", "galleryapp.com", "showcaseworkshop.com", "inspirationlabs.io", "templated.io"])(
    "does not reject a company domain for a word inside its name: %s",
    (domain) => expect(thirdPartySiteReason(domain, categoryTerms(CARRD_CATEGORY))).toBeNull(),
  );

  it("does not reject galleries, directories or marketplaces when that is the researched category", () => {
    expect(thirdPartySiteReason("onepagelove.com", categoryTerms({ category: "Website Inspiration Gallery", subcategory: null }))).toBeNull();
    expect(thirdPartySiteReason("themeforest.net", categoryTerms({ category: "Digital Asset Marketplace", subcategory: "Website Template Marketplace" }))).toBeNull();
    expect(thirdPartySiteReason("futurepedia.io", categoryTerms({ category: "AI Tools Directory", subcategory: null }))).toBeNull();
    const terms = categoryTerms({ category: "Website Inspiration Gallery", subcategory: null });
    expect(signalsFor(ONE_PAGE_LOVE, terms).directoryLike).toBe(false);
  });

  it.each([
    ["https://www.awwwards.co/", "Awwwards - Website Awards - Best Web Design Trends", ""],
    ["https://saasframe.co/", "SaaS Landing Page Examples", "A curated collection of the best SaaS websites. Submit your site."],
    ["https://uigarden.net/", "UI Garden", "A directory of the best web design tools and resources."],
    ["https://themebazaar.io/", "Theme Bazaar", "The website template marketplace for creators."],
  ])("flags gallery/directory-like results it doesn't know by domain: %s", (url, title, snippet) => {
    expect(signalsFor(result(url, title, snippet), categoryTerms(CARRD_CATEGORY)).directoryLike).toBe(true);
  });

  it("a vendor's own gallery page still reaches the LLM (judged by the company that owns it), not rejected", () => {
    const { candidates, rejected } = carrd([result("https://www.framer.com/gallery", "Framer Gallery: Website Inspiration", "Curated sites made with Framer, the website builder.", 0.7)]);
    expect(rejected).toEqual([]);
    expect(candidates[0]!.signals.directoryLike).toBe(true);
    expect(triage(candidates[0]!)).toEqual({ kind: "classify" });
  });
});
