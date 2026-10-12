import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCategoryPages, MAX_EXTRA_PAGES, relevantPages } from "../src/services/category-pages.js";
import { CategoryError, detectCategory, type CategoryPage } from "../src/services/category.service.js";
import { analyzeWebsite } from "../src/services/website-analysis.js";
import { StageError, toJobError } from "../src/services/job-errors.js";
import { defaultSteps } from "../src/services/research.service.js";
import { hang, jinaError, jinaOk, mockFetch } from "./jina-fixtures.js";
import { categoryAnswer, fakeLlm, website } from "./discovery-fixtures.js";
import { DOMAIN, jewelleryAnswer, RENDERED_LINKS, RENDERED_TEXT, SHELL_HTML, SHELL_TEXT } from "./jewellery-fixtures.js";
import type { WebsiteLink, WebsiteResearch } from "../src/types/website.js";

const fast = { timeoutMs: 50, retryDelayMs: 0 };
const INSUFFICIENT = "Unable to determine the company's category. The website doesn't have enough readable content.";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Jina text read of `url`. */
const textPage = (url: string, text: string, extra: Record<string, unknown> = {}) => jinaOk({ url, title: "", text, httpStatus: 200, ...extra });
const target = (call: unknown[]) => String(call[0]).replace("https://r.jina.ai/", "");
const headers = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

/** A homepage with only a title and meta description: the shape of an un-rendered single-page app. */
const thin = (overrides: Partial<WebsiteResearch> = {}) =>
  website({
    title: "Acme Content",
    description: "Content marketing agency",
    headings: [],
    structuredData: { types: [], items: [], invalidBlocks: 0 },
    content: "",
    wordCount: 0,
    ...overrides,
  });

const link = (url: string, text = ""): WebsiteLink => ({ url, text, internal: true });

const ABOUT_TEXT =
  "About Acme Content. Acme Content is a B2B technical content marketing agency for software companies. We write " +
  "developer documentation, technical blog posts and product marketing content for SaaS startups and developer tool vendors, " +
  "and plan content strategy end to end for technical buyers.";

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { kind: string };
  }
  throw new Error("expected a rejection");
};
const jobMessage = (e: unknown) => toJobError(new StageError("CATEGORY_DETECTION_FAILED", e)).message;

/** collectCategoryPages then detectCategory: what the default pipeline step does. */
async function detect(w: WebsiteResearch, llm = fakeLlm(() => categoryAnswer()), name = "Acme Content", domain = "acme.com") {
  const pages = await collectCategoryPages(name, domain, w, fast);
  return { pages, result: await detectCategory({ companyName: name, domain, website: w, pages }, llm), llm };
}

describe("collectCategoryPages", () => {
  it("a normal website: no extra reads, the request to the model is unchanged", async () => {
    const fetch = mockFetch(() => {
      throw new Error("no read expected");
    });
    const { pages, result, llm } = await detect(website());
    expect(pages).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.category).toBe("Content Marketing Agency");
    expect(JSON.parse(llm.calls[0]!.user.replace(/^[^{]*/, ""))).not.toHaveProperty("otherPages");
  });

  it("a homepage whose title, metadata and headings are enough: no extra reads, quotes may come from the metadata", async () => {
    const fetch = mockFetch(() => {
      throw new Error("no read expected");
    });
    const w = thin({
      description: "Acme Content is a B2B technical content marketing agency for software companies.",
      headings: [
        { level: 1, text: "Developer documentation and technical blog posts that convert", followingText: null },
        { level: 2, text: "Product marketing content for SaaS startups and developer tool vendors", followingText: null },
        { level: 2, text: "Content strategy planned end to end by engineers and writers", followingText: null },
      ],
    });
    const { result } = await detect(w, fakeLlm(() => categoryAnswer({ evidence: ["B2B technical content marketing agency", "developer tool vendors"] })));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.evidence).toEqual(["B2B technical content marketing agency", "developer tool vendors"]);
  });

  it("a title and metadata with little body text: reads the rendered homepage once, uncached, and uses it", async () => {
    const fetch = mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), ABOUT_TEXT));
    const { pages, result, llm } = await detect(thin());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(target(fetch.mock.calls[0]!)).toBe("https://acme.com/");
    expect(headers(fetch.mock.calls[0]!)).toMatchObject({ "X-Return-Format": "text", "X-No-Cache": "true", "X-With-Links-Summary": "true" });
    expect(pages).toEqual([{ url: "https://acme.com/", text: ABOUT_TEXT }]);
    expect(result.evidence).toEqual(["B2B technical content marketing agency", "developer documentation"]);
    const sent = JSON.parse(llm.calls[0]!.user.replace(/^[^{]*/, ""));
    expect(sent).toMatchObject({ title: "Acme Content", metaDescription: "Content marketing agency", otherPages: [{ url: "https://acme.com/", text: ABOUT_TEXT }] });
  });

  it("insufficient homepage text but a relevant internal page: reads it and grounds the category on it", async () => {
    const fetch = mockFetch((url) => {
      const page = url.replace("https://r.jina.ai/", "");
      if (page === "https://acme.com/") return textPage(page, "Welcome", { links: { "About us": "https://acme.com/about-us", Blog: "https://acme.com/blog" } });
      if (page === "https://acme.com/about-us") return textPage(page, ABOUT_TEXT);
      return jinaError(500, "unexpected page");
    });
    const { pages, result } = await detect(thin());
    expect(fetch.mock.calls.map(target)).toEqual(["https://acme.com/", "https://acme.com/about-us"]);
    expect(pages.map((p) => p.url)).toEqual(["https://acme.com/", "https://acme.com/about-us"]);
    expect(result.category).toBe("Content Marketing Agency");
  });

  it(`reads at most ${MAX_EXTRA_PAGES} extra pages, in parallel, best-ranked first`, async () => {
    const fetch = mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), "Coming soon"));
    const w = thin({
      links: [
        link("https://acme.com/events", "Events"),
        link("https://acme.com/services", "Services"),
        link("https://acme.com/about", "About"),
        link("https://acme.com/products", "Products"),
        link("https://acme.com/contact", "Contact"),
      ],
    });
    await collectCategoryPages("Acme Content", "acme.com", w, fast);
    expect(fetch.mock.calls.map(target)).toEqual(["https://acme.com/", "https://acme.com/about", "https://acme.com/services"]);
  });

  it("JavaScript-only HTML when rendered content is unavailable: fails safely as insufficient_evidence", async () => {
    const shell = analyzeWebsite({ domain: "acme.com", page: { requestedUrl: "https://acme.com/", url: "https://acme.com/", title: "Acme", description: null, metadata: {}, canonical: null, httpStatus: 200, body: SHELL_HTML }, robotsTxt: null });
    // Jina hands back the same shell for the rendered read too, without links.
    const fetch = mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), SHELL_TEXT, { links: {} }));
    const llm = fakeLlm(() => categoryAnswer());
    const err = await rejection(detect(shell, llm));
    expect(err).toBeInstanceOf(CategoryError);
    expect(err.kind).toBe("insufficient_evidence");
    expect(jobMessage(err)).toBe(INSUFFICIENT);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    [401, "upstream_error"],
    [402, "insufficient_balance"],
    [403, "upstream_error"],
  ])("Jina %i on the rendered read: no further reads, fails with the existing safe message", async (status) => {
    const fetch = mockFetch(() => jinaError(status, "Bearer jina_secret_key_should_not_leak"));
    const w = thin({ links: [link("https://acme.com/about", "About")] });
    const err = await rejection(detect(w));
    expect(err.kind).toBe("insufficient_evidence");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jobMessage(err)).toBe(INSUFFICIENT);
    expect(jobMessage(err)).not.toMatch(/jina|bearer|40\d|secret/i);
  });

  it("a Jina timeout on the rendered read (retried once) still tries relevant pages linked from the HTML", async () => {
    const fetch = mockFetch((url, init) => (url.endsWith("https://acme.com/") ? hang(url, init) : textPage(url.replace("https://r.jina.ai/", ""), ABOUT_TEXT)));
    const { result } = await detect(thin({ links: [link("https://acme.com/about", "About")] }));
    expect(fetch.mock.calls.map(target)).toEqual(["https://acme.com/", "https://acme.com/", "https://acme.com/about"]);
    expect(result.category).toBe("Content Marketing Agency");
  });

  it("a Jina timeout everywhere: bounded reads, then the existing safe message", async () => {
    const fetch = mockFetch(hang);
    const err = await rejection(detect(thin({ links: [link("https://acme.com/about", "About")] })));
    expect(err.kind).toBe("insufficient_evidence");
    expect(fetch).toHaveBeenCalledTimes(4); // homepage ×2, /about ×2
  });

  it("skips pages the site answers with an error status", async () => {
    mockFetch((url) => {
      const page = url.replace("https://r.jina.ai/", "");
      return page === "https://acme.com/" ? textPage(page, "", { links: { About: "https://acme.com/about" } }) : textPage(page, ABOUT_TEXT, { httpStatus: 404 });
    });
    expect(await collectCategoryPages("Acme Content", "acme.com", thin(), fast)).toEqual([]);
  });

  it("a website that genuinely says too little still fails safely, without calling the model", async () => {
    mockFetch((url) => {
      const page = url.replace("https://r.jina.ai/", "");
      return textPage(page, "Coming soon. Stay tuned.", { links: { About: "https://acme.com/about", Products: "https://acme.com/products" } });
    });
    const llm = fakeLlm(() => categoryAnswer());
    const err = await rejection(detect(thin(), llm));
    expect(err.kind).toBe("insufficient_evidence");
    expect(llm.calls).toHaveLength(0);
  });

  it("quotes from the extra pages are verified like any other: malformed or unverifiable evidence is rejected", async () => {
    mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), ABOUT_TEXT));
    const unverifiable = await rejection(detect(thin(), fakeLlm(() => categoryAnswer({ evidence: ["award-winning global leader", "x".repeat(250)] }))));
    expect(unverifiable.kind).toBe("unsupported");
    expect(jobMessage(unverifiable)).toBe("Unable to determine the company's category. The website content doesn't clearly indicate what market the company is in.");
    const malformed = await rejection(detect(thin(), fakeLlm(() => categoryAnswer({ evidence: "B2B technical content marketing agency" }))));
    expect(malformed.kind).toBe("malformed_response");
  });

  it("extra pages share the existing visible-text budget", async () => {
    const long = "word ".repeat(3_000);
    const pages: CategoryPage[] = [{ url: "https://acme.com/", text: long }, { url: "https://acme.com/about", text: long }];
    const llm = fakeLlm(() => categoryAnswer({ evidence: ["word word word"] }));
    await detectCategory({ companyName: "Acme", domain: "acme.com", website: thin({ content: "Acme" }), pages }, llm);
    const sent = JSON.parse(llm.calls[0]!.user.replace(/^[^{]*/, ""));
    expect(sent.visibleText.length + sent.otherPages.reduce((n: number, p: CategoryPage) => n + p.text.length, 0)).toBeLessThanOrEqual(6_000);
    expect(sent.otherPages).toHaveLength(1);
  });
});

describe("relevantPages: only same-domain pages, never the whole site", () => {
  it("drops off-domain, subdomain, non-http, file, credential/port, homepage and duplicate links", () => {
    const links = [
      { url: "https://evil.com/about", text: "About" },
      { url: "https://acme.com.evil.com/about", text: "About" },
      { url: "https://blog.acme.com/about", text: "About" },
      { url: "mailto:about@acme.com", text: "About" },
      { url: "javascript:alert(1)", text: "About" },
      { url: "not a url", text: "About" },
      { url: "https://user:pw@acme.com/about", text: "About" },
      { url: "https://acme.com:8443/about", text: "About" },
      { url: "https://acme.com/", text: "About" },
      { url: "https://acme.com/#about", text: "About" },
      { url: "https://acme.com/brochure.pdf", text: "Products" },
      { url: "https://acme.com/%E0%A4%A", text: "Products" },
      { url: "https://www.acme.com/services/?ref=nav#top", text: "Services" },
      { url: "https://acme.com/services", text: "Our services" },
      { url: "https://acme.com/careers", text: "Careers" },
    ];
    expect(relevantPages("acme.com", links, 10)).toEqual(["https://acme.com/%E0%A4%A", "https://acme.com/services"]);
  });

  it("ranks About before Products/Services before Exhibitors/Events, by path or link text", () => {
    const links = [
      { url: "https://acme.com/exhibitors", text: "" },
      { url: "https://acme.com/x1", text: "What we do" },
      { url: "https://acme.com/who-we-are", text: "" },
    ];
    expect(relevantPages("acme.com", links, 3)).toEqual(["https://acme.com/who-we-are", "https://acme.com/x1", "https://acme.com/exhibitors"]);
  });
});

describe("the default pipeline step", () => {
  it("collects the extra pages, then calls the model once with them (Jina and Groq both mocked)", async () => {
    const groq = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }), { status: 200 });
    const fetch = mockFetch((url) => (url.startsWith("https://r.jina.ai/") ? textPage(url.replace("https://r.jina.ai/", ""), ABOUT_TEXT) : groq(categoryAnswer())));
    const result = await defaultSteps.detectCategory({ name: "Acme Content", domain: "acme.com" }, thin());
    expect(result.category).toBe("Content Marketing Agency");
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.startsWith("https://r.jina.ai/"))).toEqual(["https://r.jina.ai/https://acme.com/"]);
    expect(urls.filter((u) => !u.startsWith("https://r.jina.ai/"))).toHaveLength(1);
  });
});

describe("thejewelleryshow.in (captured failure)", () => {
  const shell = () =>
    analyzeWebsite({
      domain: DOMAIN,
      page: { requestedUrl: `https://${DOMAIN}/`, url: `https://${DOMAIN}/`, title: "The Jewellery Show", description: "India’s Top Jewellery Exhibition Organiser", metadata: {}, canonical: null, httpStatus: 200, body: SHELL_HTML },
      robotsTxt: null,
    });

  it("reproduces the failure on the homepage HTML alone: a title, a meta description and no body text", async () => {
    const w = shell();
    expect(w).toMatchObject({ title: "The Jewellery Show", description: "India’s Top Jewellery Exhibition Organiser", wordCount: 0, headings: [], links: [] });
    const err = await rejection(detectCategory({ companyName: "The jewellery", domain: DOMAIN, website: w }, fakeLlm(() => jewelleryAnswer())));
    expect(jobMessage(err)).toBe(INSUFFICIENT);
  });

  it("succeeds from one uncached rendered read of the homepage, with verified quotes", async () => {
    const fetch = mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), RENDERED_TEXT, { links: RENDERED_LINKS }));
    const { result } = await detect(shell(), fakeLlm(() => jewelleryAnswer()), "The jewellery", DOMAIN);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ category: "Jewellery Exhibition Organiser", confidence: 0.9 });
    expect(result.evidence).toEqual([
      "India's Top Jewellery Exhibition Organiser",
      "The practical platform for display & sale of spectacular Gold, Diamond, Platinum, Gems, Pearls & Silver Jewellery",
      'The Jewellery Show" Exhibition, held across various cities in Karnataka',
    ]);
  });

  it("when the rendered read comes back as the shell again, the event pages it links are not known: fails safely", async () => {
    const fetch = mockFetch((url) => textPage(url.replace("https://r.jina.ai/", ""), SHELL_TEXT, { links: {} }));
    const err = await rejection(detect(shell(), fakeLlm(() => jewelleryAnswer()), "The jewellery", DOMAIN));
    expect(jobMessage(err)).toBe(INSUFFICIENT);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("picks the upcoming-show pages from the rendered links, not the year archives, contact or gallery", () => {
    const links = Object.entries(RENDERED_LINKS).map(([text, url]) => ({ text, url }));
    expect(relevantPages(DOMAIN, links)).toEqual([`https://${DOMAIN}/upcomingshow`, `https://${DOMAIN}/showpage/The_Jewellery_Show_@_Hubballi_2026`]);
  });
});
