import { describe, expect, it } from "vitest";
import { backlinks, brandScale, mentionsCompany, parseFollowers, ranking, rankingQueries, thirdParty } from "../src/services/scoring/search-metrics.js";
import { CAPS } from "../src/services/scoring/rubric.js";
import { createSearchSession, SearchError, type SearchOptions } from "../src/services/search.service.js";
import { CATEGORY, fakeSearch, result, website } from "./discovery-fixtures.js";
import type { SearchResult } from "../src/services/search.service.js";

const ACME = { name: "Acme Content", domain: "acme.com" };

/** Session over a fake provider answering by query (and domain filter). */
function session(answer: (query: string, opts?: SearchOptions) => SearchResult[]) {
  const provider = fakeSearch(() => []);
  provider.search.mockImplementation(async (q: string, opts?: SearchOptions) => answer(q, opts));
  return { provider, s: createSearchSession(provider) };
}

describe("mentionsCompany", () => {
  it("matches the full name or the domain as whole words, in any text or URL", () => {
    expect(mentionsCompany(ACME, "Top agencies: ACME Content, Rival")).toBe(true);
    expect(mentionsCompany(ACME, "see acme.com for more")).toBe(true);
    expect(mentionsCompany(ACME, "https://clutch.co/profile/acme-content")).toBe(true);
    expect(mentionsCompany(ACME, "Acme Contentful review")).toBe(false);
    expect(mentionsCompany(ACME, "Acme Corp")).toBe(false);
  });
});

describe("parseFollowers", () => {
  it.each([
    ["Acme | 12,345 followers on LinkedIn", 12_345],
    ["Acme. 1.2K followers", 1_200],
    ["3M followers", 3_000_000],
    ["5,001+ followers", 5_001],
    ["Acme | LinkedIn", null],
  ])("%s → %s", (text, n) => expect(parseFollowers(text)).toBe(n));
});

describe("SEO backlinks (proxy)", () => {
  it("counts distinct third-party sites naming the brand; skips own site, social profiles and non-mentions", async () => {
    const { provider, s } = session(() => [
      result("https://blog.example.org/best-agencies", "Best agencies", "Acme Content tops our list"),
      result("https://blog.example.org/other", "Another", "Acme Content again"), // same site
      result("https://news.site.io/x", "Funding news", "acme.com raised a round"),
      result("https://acme.com/about", "About Acme Content", ""), // own site
      result("https://www.linkedin.com/company/acme", "Acme Content | LinkedIn", ""), // social profile
      result("https://unrelated.dev/", "Something else", "No mention"),
    ]);
    const { metric, sources } = await backlinks(ACME, s);
    expect(provider.search).toHaveBeenCalledWith('"Acme Content"', { maxResults: 10, excludeDomains: ["acme.com"] });
    expect(metric.checks[0]).toMatchObject({ id: "backlinks.mentions", value: 2 / CAPS.mentioningDomains });
    expect(metric.score).toBe(20);
    expect(metric.proxy).toMatch(/No backlink API/);
    expect(sources.map((x) => [x.domain, x.type, x.pillar])).toEqual([
      ["blog.example.org", "Search result", "seo"],
      ["news.site.io", "Search result", "seo"],
    ]);
  });
});

describe("SEO ranking", () => {
  it("uses fixed per-category templates", () => {
    expect(rankingQueries({ category: "Content Marketing Agency" })).toEqual([
      "best Content Marketing Agencies",
      "top Content Marketing Agency providers",
      "Content Marketing Agency comparison",
    ]);
  });

  it("passes a template when a third-party roundup names the company, not when only its own page ranks", async () => {
    const { s } = session((q) =>
      q.startsWith("best")
        ? [result("https://review.io/best", "10 best content agencies", "1. Acme Content 2. Rival")]
        : [result("https://acme.com/", "Acme Content", "We are the best")],
    );
    const { metric, sources } = await ranking(ACME, CATEGORY, s);
    expect(metric.checks.map((c) => c.value)).toEqual([1, 0, 0]);
    expect(metric.checks[1]!.detail).toBe("Not named in the top 10 results (own site is result #1)");
    expect(metric.score).toBe(33);
    expect(sources).toEqual([{ title: "10 best content agencies", domain: "review.io", url: "https://review.io/best", type: "Search result", pillar: "seo" }]);
  });

  it("sends each template once per job, however many companies are scored", async () => {
    const { provider, s } = session(() => []);
    await ranking(ACME, CATEGORY, s);
    await ranking({ name: "Rival", domain: "rival.com" }, CATEGORY, s);
    expect(provider.search).toHaveBeenCalledTimes(3);
  });

  it("propagates search failures (no score from a failed search)", async () => {
    const provider = fakeSearch(() => Promise.reject(new SearchError("quota_exceeded", "432")));
    await expect(ranking(ACME, CATEGORY, createSearchSession(provider))).rejects.toMatchObject({ kind: "quota_exceeded" });
  });
});

describe("GEO third-party presence", () => {
  it("searches only the four review platforms and passes each one with a page naming the company", async () => {
    const { provider, s } = session(() => [
      result("https://clutch.co/profile/acme-content", "Acme Content Reviews | Clutch", ""),
      result("https://www.g2.com/products/rival/reviews", "Rival Reviews", "Not us"),
      result("https://www.goodfirms.co/company/acme-content", "Acme Content - GoodFirms", ""),
    ]);
    const { metric, sources } = await thirdParty(ACME, s);
    expect(provider.search).toHaveBeenCalledWith('"Acme Content"', { maxResults: 10, includeDomains: ["g2.com", "capterra.com", "clutch.co", "goodfirms.co"] });
    expect(Object.fromEntries(metric.checks.map((c) => [c.id, c.value]))).toEqual({
      "thirdParty.g2": 0,
      "thirdParty.capterra": 0,
      "thirdParty.clutch": 1,
      "thirdParty.goodfirms": 1,
    });
    expect(metric.score).toBe(50);
    expect(sources.map((x) => x.type)).toEqual(["Clutch", "Search result"]);
  });
});

describe("GEO brand scale", () => {
  const linkedFrom = website({ links: [{ url: "https://www.linkedin.com/company/acme-co/", text: "LinkedIn", internal: false }] });

  it("scores LinkedIn followers on a log scale from the company page and records them for companies.linkedin", async () => {
    const { s } = session(() => [
      result("https://www.linkedin.com/company/someone-else", "Someone Else | 90,000 followers", ""),
      result("https://www.linkedin.com/company/acme-co", "Acme | LinkedIn", "Acme Content. 1,000 followers on LinkedIn."),
    ]);
    const r = await brandScale(ACME, linkedFrom, s);
    expect(r.metric.checks[0]).toMatchObject({ id: "brandScale.linkedinFollowers" });
    expect(r.metric.score).toBe(60); // log10(1001) / log10(100001)
    expect(r.linkedin).toBe("1,000 followers");
    expect(r.sources).toEqual([expect.objectContaining({ type: "LinkedIn", pillar: "geo", url: "https://www.linkedin.com/company/acme-co" })]);
  });

  it("scores 0, with a note, when the page has no visible count or there is no page", async () => {
    const noCount = await brandScale(ACME, linkedFrom, session(() => []).s);
    expect(noCount.metric.score).toBe(0);
    expect(noCount.metric.checks[0]!.detail).toMatch(/found, but no follower count/);
    expect(noCount.linkedin).toBe("LinkedIn page found; follower count not available");
    const none = await brandScale(ACME, website(), session(() => []).s);
    expect(none.linkedin).toBe("No LinkedIn company page found");
  });
});
