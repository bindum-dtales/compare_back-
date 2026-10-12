import { describe, expect, it, vi } from "vitest";
import { discoverCompetitors, selectCompetitors } from "../src/services/competitor.service.js";
import { createSearchSession, SearchError } from "../src/services/search.service.js";
import { LlmError } from "../src/services/llm.service.js";
import { CARRD_CATEGORY, CARRD_RESULTS, CATEGORY, fakeLlm, fakeSearch, result } from "./discovery-fixtures.js";
import type { CompetitorCandidate, CompetitorDiscovery } from "../src/types/discovery.js";
import type { SearchResult } from "../src/services/search.service.js";

const target = { name: "DTales Tech", domain: "dtales.tech" };

/** A homepage whose title and snippet clearly match the category (still classified by the LLM). */
const strong = (domain: string, score = 0.5): SearchResult =>
  result(`https://${domain}/`, `${domain.split(".")[0]} | B2B Technical Content Marketing Agency`, "We are a technical content agency.", score);
/** An article-like page. */
const ambiguous = (domain: string): SearchResult => result(`https://${domain}/blog/top-agencies`, "Top 10 content agencies", "Our pick of agencies.", 0.4);

async function discover(results: SearchResult[]): Promise<CompetitorDiscovery> {
  return discoverCompetitors(target, CATEGORY, createSearchSession(fakeSearch(() => results)));
}

type Verdict = [kind: string, confidence: number];
/** A classifier answering from a table (domain → verdict); domains not in it get no verdict. */
const classifier = (verdicts: Record<string, Verdict>) =>
  fakeLlm((req) => ({
    candidates: (JSON.parse(req.user) as { candidates: { domain: string }[] }).candidates.flatMap((c) =>
      verdicts[c.domain] ? [{ domain: c.domain, name: c.domain.split(".")[0], kind: verdicts[c.domain]![0], confidence: verdicts[c.domain]![1], reason: "From the snippet." }] : [],
    ),
  }));
/** Every listed domain is a direct competitor at the given confidence. */
const competitors = (domains: string[], confidence = 0.9) => classifier(Object.fromEntries(domains.map((d) => [d, ["direct_competitor", confidence] as Verdict])));

const noLlm = fakeLlm(() => {
  throw new Error("LLM should not be called");
});

const select = async (results: SearchResult[], llm = noLlm) =>
  selectCompetitors({ target, targetDescription: "AI-native content partner.", category: CATEGORY, discovery: await discover(results) }, llm);
const asked = (llm: ReturnType<typeof fakeLlm>) => llm.calls.flatMap((c) => (JSON.parse(c.user) as { candidates: { domain: string }[] }).candidates.map((x) => x.domain));

describe("selectCompetitors", () => {
  it("selects 4 when more legitimate competitors exist, keeping the rest as accepted", async () => {
    const domains = ["alpha.com", "bravo.com", "charlie.com", "delta.com", "echo.com"];
    const sel = await select(domains.map((d, i) => strong(d, 0.9 - i * 0.1)), competitors(domains));
    expect(sel.competitors.map((c) => c.domain)).toEqual(["alpha.com", "bravo.com", "charlie.com", "delta.com"]);
    expect(sel.candidates.find((c) => c.domain === "echo.com")?.verdict).toBe("accepted");
    // The legitimate ones beyond the 4 are kept, in order, as stand-ins for a competitor that can't be researched.
    expect(sel.alternates!.map((c) => c.domain)).toEqual(["echo.com"]);
    expect(sel.note).toBeNull();
    expect(sel.competitors[0]).toMatchObject({
      name: "alpha",
      url: "https://alpha.com/",
      category: "Content Marketing Agency",
      source: "fake-search",
      discoveryEvidence: { method: "llm", confidence: 0.9, sourceQueries: expect.any(Array), signals: { homepage: true }, reason: "From the snippet." },
    });
  });

  it.each([3, 2])("selects %i when only that many are legitimate", async (n) => {
    const domains = ["a.com", "b.com", "c.com"].slice(0, n);
    const sel = await select([...domains.map((d) => strong(d)), result("https://pipes.com/blog/x", "Fixing pipes", "Leaks")], competitors(domains));
    expect(sel.competitors).toHaveLength(n);
    expect(sel.note).toBeNull();
  });

  it("does not invent competitors when fewer than 2 are legitimate", async () => {
    const one = await select([strong("a.com"), strong("b.com"), result("https://pipes.com/blog/x", "Fixing pipes", "Leaks")], classifier({ "a.com": ["direct_competitor", 0.9], "b.com": ["not_a_competitor", 0.9] }));
    expect(one.competitors.map((c) => c.domain)).toEqual(["a.com"]);
    expect(one.alternates).toEqual([]);
    expect(one.note).toBe("Only 1 legitimate competitor could be identified from the search results.");

    const none = await select([]);
    expect(none.competitors).toEqual([]);
    expect(none.note).toBe("No competitor candidates were found by search.");
  });

  it("selects none when the classifier finds no direct competitor among clear category matches", async () => {
    const sel = await select([strong("a.com"), strong("b.com")], classifier({ "a.com": ["review_or_editorial", 0.9], "b.com": ["not_a_competitor", 0.8] }));
    expect(sel.competitors).toEqual([]);
    expect(sel.alternates).toEqual([]);
    expect(sel.note).toBe("No legitimate competitors could be identified from the search results.");
  });

  it("never accepts a candidate without the classifier: a clear homepage match is asked about too", async () => {
    const llm = fakeLlm(() => ({
      candidates: [
        { domain: "yes.io", name: "Yes Agency", kind: "direct_competitor", confidence: 0.8, reason: "Snippet describes a B2B content agency." },
        { domain: "no.io", name: "No Media", kind: "review_or_editorial", confidence: 0.9, reason: "A media publication." },
      ],
    }));
    const sel = await select([strong("alpha.com"), ambiguous("yes.io"), ambiguous("no.io")], llm);

    expect(llm.calls).toHaveLength(1); // one call for all candidates
    expect(asked(llm).sort()).toEqual(["alpha.com", "no.io", "yes.io"]);
    expect(sel.competitors.map((c) => [c.domain, c.name, c.discoveryEvidence.method])).toEqual([["yes.io", "Yes Agency", "llm"]]);
    // The homepage that matched every category term got no verdict, so it isn't a competitor.
    expect(sel.candidates.find((c) => c.domain === "alpha.com")).toMatchObject({ verdict: "rejected", method: "llm", reason: expect.stringMatching(/no verdict/) });
    expect(sel.candidates.find((c) => c.domain === "no.io")).toMatchObject({ verdict: "rejected", method: "llm", reason: "A media publication." });
    for (const c of sel.candidates) if (c.verdict !== "rejected") expect(c).toMatchObject({ method: "llm", classification: "direct_competitor" });
  });

  it("does not call the LLM when everything is rejected deterministically", async () => {
    const sel = await select([result("https://pipes.com/blog/x", "Fixing pipes", "Leaks"), result("https://clutch.co/agencies", "Top agencies")]);
    expect(sel.competitors).toEqual([]);
    expect(sel.candidates).toEqual([expect.objectContaining({ domain: "pipes.com", verdict: "rejected", method: "deterministic" })]);
  });

  it("orders selected competitors by the classifier's confidence, then search rank", async () => {
    const sel = await select([strong("a.com", 0.9), strong("b.com", 0.5), strong("c.com", 0.1)], classifier({ "a.com": ["direct_competitor", 0.7], "b.com": ["direct_competitor", 0.95], "c.com": ["direct_competitor", 0.7] }));
    expect(sel.competitors.map((c) => c.domain)).toEqual(["b.com", "a.com", "c.com"]);
  });

  it("rejects an LLM 'yes' below the confidence threshold", async () => {
    const llm = fakeLlm(() => ({ candidates: [{ domain: "maybe.io", name: "Maybe", kind: "direct_competitor", confidence: 0.4, reason: "Unclear." }] }));
    const sel = await select([ambiguous("maybe.io")], llm);
    expect(sel.competitors).toEqual([]);
    expect(sel.candidates[0]).toMatchObject({ verdict: "rejected", reason: expect.stringContaining("below 0.6") });
  });

  it("ignores companies the LLM adds that weren't candidates", async () => {
    const llm = fakeLlm(() => ({
      candidates: [{ domain: "invented.com", name: "Invented", kind: "direct_competitor", confidence: 1, reason: "Made up." }],
    }));
    const sel = await select([ambiguous("real.io")], llm);
    expect(sel.competitors).toEqual([]);
    expect(sel.candidates.map((c) => c.domain)).toEqual(["real.io"]);
    expect(sel.candidates[0]?.reason).toMatch(/no verdict/);
  });

  it("surfaces a malformed LLM response as an error", async () => {
    const llm = fakeLlm(() => ({ candidates: [{ domain: "x.io" }] }));
    await expect(select([ambiguous("x.io")], llm)).rejects.toBeInstanceOf(LlmError);
  });

  it("never selects the target", async () => {
    const llm = competitors(["dtales.tech", "a.com", "b.com"]);
    const sel = await select([strong("dtales.tech"), result("https://www.dtales.tech/services", "DTales | B2B content agency"), strong("a.com"), strong("b.com")], llm);
    expect(sel.competitors.map((c) => c.domain)).toEqual(["a.com", "b.com"]);
    expect(asked(llm)).not.toContain("dtales.tech");
  });
});

describe("discoverCompetitors", () => {
  it("stops searching once there are enough viable candidates", async () => {
    const provider = fakeSearch(() => Array.from({ length: 10 }, (_, i) => strong(`agency${i}.com`)));
    const d = await discoverCompetitors(target, CATEGORY, createSearchSession(provider));
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(d.searches).toEqual([{ query: "top B2B Technical Content Marketing Agencies", provider: "fake-search", resultCount: 10 }]);
    expect(d.candidates).toHaveLength(10);
  });

  it("runs at most 3 distinct queries and excludes non-company sites and the target at the provider", async () => {
    const provider = fakeSearch(() => []);
    const d = await discoverCompetitors(target, CATEGORY, createSearchSession(provider));
    expect(provider.search).toHaveBeenCalledTimes(3);
    expect(new Set(provider.search.mock.calls.map(([q]) => q)).size).toBe(3);
    const opts = (provider.search.mock.calls[0] as unknown[])[1] as { excludeDomains: string[] };
    expect(opts.excludeDomains).toEqual(expect.arrayContaining(["clutch.co", "linkedin.com", "dtales.tech"]));
    expect(d.candidates).toEqual([]);
  });

  it("continues with partial results when a later query fails", async () => {
    let n = 0;
    const provider = fakeSearch(() => {
      if (n++ === 1) throw new SearchError("timeout", "slow");
      return [strong(`a${n}.com`)];
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await discoverCompetitors(target, CATEGORY, createSearchSession(provider));
    expect(d.searches.map((s) => s.resultCount)).toEqual([1, null, 1]);
    expect(d.candidates.map((c: CompetitorCandidate) => c.domain)).toEqual(["a1.com", "a3.com"]);
    vi.restoreAllMocks();
  });

  it("throws when search fails entirely, and stops at a rate limit", async () => {
    const provider = fakeSearch(() => {
      throw new SearchError("rate_limited", "429");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(discoverCompetitors(target, CATEGORY, createSearchSession(provider))).rejects.toMatchObject({ kind: "rate_limited" });
    expect(provider.search).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("selectCompetitors: review, listicle and editorial sites (website builders)", () => {
  const BUILDER = { ...CATEGORY, category: "Website Builder", subcategory: null };
  const carrd = { name: "Carrd", domain: "carrd.co" };
  const run = async (results: SearchResult[], verdicts: Record<string, [string, number]> = {}) => {
    const llm = fakeLlm((req) => ({
      candidates: (JSON.parse(req.user) as { candidates: { domain: string }[] }).candidates.flatMap((c) =>
        verdicts[c.domain] ? [{ domain: c.domain, name: c.domain, kind: verdicts[c.domain]![0], confidence: verdicts[c.domain]![1], reason: "From the snippet." }] : [],
      ),
    }));
    const discovery = await discoverCompetitors(carrd, BUILDER, createSearchSession(fakeSearch(() => results)));
    const sel = await selectCompetitors({ target: carrd, targetDescription: "One-page sites.", category: BUILDER, discovery }, llm);
    const asked = llm.calls.flatMap((c) => (JSON.parse(c.user) as { candidates: { domain: string }[] }).candidates.map((x) => x.domain));
    return { sel, asked };
  };

  it("mixed results: real products are selected; review sites, listicles and directories are not", async () => {
    const { sel, asked } = await run(
      [
        result("https://www.squarespace.com/", "Website Builder – Easily Create Your Own Website — Squarespace", "Website builder for everyone.", 0.74),
        result("https://website-builders.cybernews.com/", "Best Website Builders in October 2026 (Months of Expert Testing)", "Website builder reviews.", 0.76),
        result("https://www.techradar.com/news/the-best-website-builder", "The best website builders of 2026 | TechRadar", "Website builders tested.", 0.83),
        result("https://launchthedamnthing.com/blog/best-website-builders", "7 Best Website Builders for 2026", "Website builder picks.", 0.82),
        result("https://www.wix.com/builder/one-page", "One-Page Website Builder: Build A Site For Free - Wix", "Website builder.", 0.72),
        result("https://simvoly.com/the-best-website-builder", "Best Website Builder 2026: Top 7 Platforms Reviewed", "Simvoly website and funnel builder.", 0.87),
        result("https://zapier.com/blog/best-ai-website-builder", "The 3 Best AI Website Builders in 2026 | Zapier", "Website builder roundup.", 0.9),
        result("https://sitebuilderhub.net/", "Best Website Builders in October 2026 (Months of Expert Testing)", "Website builder reviews.", 0.7),
      ],
      {
        "squarespace.com": ["direct_competitor", 0.95],
        "launchthedamnthing.com": ["review_or_editorial", 0.95],
        "wix.com": ["direct_competitor", 0.9],
        "simvoly.com": ["direct_competitor", 0.85],
        "zapier.com": ["not_a_competitor", 0.9],
        "sitebuilderhub.net": ["review_or_editorial", 0.9],
      },
    );
    expect(sel.competitors.map((c) => c.domain)).toEqual(["squarespace.com", "wix.com", "simvoly.com"]);
    // Known review publishers never reach the model; every other candidate, the Squarespace homepage included, does.
    expect(asked).not.toContain("cybernews.com");
    expect(asked).not.toContain("techradar.com");
    expect(asked.sort()).toEqual(["launchthedamnthing.com", "simvoly.com", "sitebuilderhub.net", "squarespace.com", "wix.com", "zapier.com"]);
    const byDomain = Object.fromEntries(sel.candidates.map((c) => [c.domain, c]));
    expect(byDomain["sitebuilderhub.net"]).toMatchObject({ verdict: "rejected", method: "llm", classification: "review_or_editorial" });
    expect(byDomain["simvoly.com"]).toMatchObject({ verdict: "selected", classification: "direct_competitor" });
    expect(sel.note).toBeNull();
  });

  it("returns fewer competitors rather than filling the list with review sites", async () => {
    const { sel } = await run(
      [
        result("https://www.wix.com/builder/one-page", "One-Page Website Builder - Wix", "Website builder.", 0.7),
        result("https://launchthedamnthing.com/blog/best-website-builders", "7 Best Website Builders for 2026", "Website builder picks.", 0.8),
        result("https://titan.email/best-ai-website-builders", "The 10 Best AI Website Builders in 2026", "Website builder guide.", 0.8),
      ],
      { "wix.com": ["direct_competitor", 0.9], "launchthedamnthing.com": ["review_or_editorial", 0.9], "titan.email": ["review_or_editorial", 0.8] },
    );
    expect(sel.competitors.map((c) => c.domain)).toEqual(["wix.com"]);
    expect(sel.note).toBe("Only 1 legitimate competitor could be identified from the search results.");
  });

  it("selects none when every candidate is a review site or listicle; nothing is invented", async () => {
    const { sel } = await run(
      [
        result("https://website-builders.cybernews.com/", "Best Website Builders in October 2026", "Reviews.", 0.8),
        result("https://launchthedamnthing.com/blog/best-website-builders", "7 Best Website Builders for 2026", "Website builder picks.", 0.8),
        result("https://startupnotes.io/wix-alternatives", "Website Builder Alternatives to Wix", "Website builder alternatives.", 0.6),
      ],
      // Even a confident "competitor" verdict for an invented domain is ignored.
      { "launchthedamnthing.com": ["review_or_editorial", 0.95], "startupnotes.io": ["review_or_editorial", 0.9], "squarespace.com": ["direct_competitor", 1] },
    );
    expect(sel.competitors).toEqual([]);
    expect(sel.note).toBe("No legitimate competitors could be identified from the search results.");
    expect(sel.candidates.map((c) => c.domain).sort()).toEqual(["launchthedamnthing.com", "startupnotes.io"]);
  });

  it("a review site's confident 'competitor'-sounding page is still rejected when classified as editorial", async () => {
    const { sel } = await run([result("https://buildercompare.net/squarespace", "Squarespace Website Builder", "Website builder.", 0.9)], {
      "buildercompare.net": ["review_or_editorial", 0.99],
    });
    expect(sel.competitors).toEqual([]);
    expect(sel.candidates[0]).toMatchObject({ verdict: "rejected", classification: "review_or_editorial" });
  });
});

describe("selectCompetitors: galleries and showcases (Carrd, real search results)", () => {
  const carrd = { name: "Carrd", domain: "carrd.co" };
  type Verdicts = Record<string, [string, number]>;
  const run = async (results: SearchResult[], verdicts: Verdicts) => {
    const llm = fakeLlm((req) => ({
      candidates: (JSON.parse(req.user) as { candidates: { domain: string }[] }).candidates.flatMap((c) =>
        verdicts[c.domain] ? [{ domain: c.domain, name: c.domain, kind: verdicts[c.domain]![0], confidence: verdicts[c.domain]![1], reason: "From the snippet." }] : [],
      ),
    }));
    const discovery = await discoverCompetitors(carrd, CARRD_CATEGORY, createSearchSession(fakeSearch(() => results)));
    const sel = await selectCompetitors({ target: carrd, targetDescription: "Simple, free, fully responsive one-page sites.", category: CARRD_CATEGORY, discovery }, llm);
    const asked = llm.calls.flatMap((c) => (JSON.parse(c.user) as { candidates: { domain: string }[] }).candidates.map((x) => x.domain));
    return { sel, asked, discovery, llm };
  };
  // The verdicts the classifier gave these results in the real run (yola, onepage and squarespace were then
  // accepted without it; their verdicts here are what a classifier would be expected to say).
  const REAL: Verdicts = {
    "yola.com": ["direct_competitor", 0.9],
    "onepage.io": ["direct_competitor", 0.85],
    "squarespace.com": ["direct_competitor", 0.95],
    "wix.com": ["direct_competitor", 0.9],
    "godaddy.com": ["direct_competitor", 0.8],
    "experte.com": ["review_or_editorial", 0.95],
    "seedprod.com": ["review_or_editorial", 0.9],
    "zapier.com": ["review_or_editorial", 0.9],
    "launchthedamnthing.com": ["review_or_editorial", 0.95],
  };

  it("onepagelove.com is no longer selected; the real builders still are", async () => {
    const { sel, asked, discovery } = await run(CARRD_RESULTS, REAL);
    expect(sel.competitors.map((c) => c.domain)).toEqual(["squarespace.com", "yola.com", "wix.com", "onepage.io"]);
    expect(sel.competitors.map((c) => c.domain)).not.toContain("onepagelove.com");
    for (const c of sel.competitors) expect(c.discoveryEvidence.method).toBe("llm");
    expect(discovery.rejected).toContainEqual(expect.objectContaining({ domain: "onepagelove.com", reason: "gallery or showcase site" }));
    expect(asked).not.toContain("onepagelove.com");
    // Review/listicle pages are still judged by the classifier and still rejected.
    for (const d of ["experte.com", "seedprod.com", "zapier.com", "launchthedamnthing.com"]) {
      expect(sel.candidates.find((c) => c.domain === d)).toMatchObject({ verdict: "rejected", method: "llm", classification: "review_or_editorial" });
    }
    expect(sel.alternates!.map((c) => c.domain)).toEqual(["godaddy.com"]);
  });

  it("a gallery the lists don't know goes to the classifier and is rejected on its verdict", async () => {
    const love = CARRD_RESULTS.find((r) => r.url === "https://onepagelove.com")!;
    const unknownGallery = { ...love, url: "https://onepagecurated.net" };
    const { sel, asked } = await run([unknownGallery, ...CARRD_RESULTS.filter((r) => r !== love)], { ...REAL, "onepagecurated.net": ["directory_or_marketplace", 0.9] });
    expect(asked).toContain("onepagecurated.net");
    expect(sel.candidates.find((c) => c.domain === "onepagecurated.net")).toMatchObject({ verdict: "rejected", method: "llm", classification: "directory_or_marketplace" });
    expect(sel.competitors.map((c) => c.domain)).not.toContain("onepagecurated.net");
  });

  it("the classifier is told that galleries, showcases and template collections are not competitors", async () => {
    const { llm } = await run(CARRD_RESULTS, REAL);
    expect(llm.calls[0]!.system).toMatch(/galleries, showcases and inspiration sites, template and theme collections/);
    expect(llm.calls[0]!.system).toMatch(/names the category does not make a site a competitor/);
  });

  it("returns fewer competitors, never padding with galleries or review sites or inventing any", async () => {
    const only = CARRD_RESULTS.filter((r) => /onepagelove|wix|experte|seedprod|zapier|launchthedamnthing/.test(r.url));
    const { sel } = await run(only, { ...REAL, "squarespace.com": ["direct_competitor", 1], "onepagelove.com": ["direct_competitor", 1] });
    expect(sel.competitors.map((c) => c.domain)).toEqual(["wix.com"]);
    expect(sel.alternates).toEqual([]);
    expect(sel.note).toBe("Only 1 legitimate competitor could be identified from the search results.");
    expect(sel.candidates.map((c) => c.domain)).not.toContain("squarespace.com");
  });
});
