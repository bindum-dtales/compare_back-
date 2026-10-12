import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { canRender, fetchSitePage, fetchWebsite, JinaError, jinaConfigStatus } from "../src/services/jina.service.js";
import { env } from "../src/config/env.js";
import { hang, homepage, jinaError, jinaOk, mockFetch, robots, siteHandler } from "./jina-fixtures.js";

const fast = { timeoutMs: 50, retryDelayMs: 0 };

afterEach(() => vi.unstubAllGlobals());

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a JinaError");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(JinaError);
      return e as JinaError;
    },
  );

describe("jina.fetchWebsite", () => {
  it("fetches the homepage as HTML and robots.txt as text, for the given domain only", async () => {
    const fetch = mockFetch(siteHandler);
    const site = await fetchWebsite({ domain: "acme.com" }, fast);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://r.jina.ai/https://acme.com/",
      "https://r.jina.ai/https://acme.com/robots.txt",
    ]);
    const headers = (i: number) => fetch.mock.calls[i]![1]?.headers;
    expect(headers(0)).toMatchObject({ Accept: "application/json", "X-Return-Format": "html" });
    expect(headers(0)).not.toHaveProperty("Authorization"); // no key configured → none sent
    expect(headers(1)).toMatchObject({ "X-Return-Format": "text" });

    expect(site.domain).toBe("acme.com");
    expect(site.page).toMatchObject({
      requestedUrl: "https://acme.com/",
      url: "https://acme.com/",
      title: "Acme | Widgets for teams",
      canonical: "https://acme.com/",
      httpStatus: 200,
      metadata: { lang: "en", robots: "index, follow" },
    });
    expect(site.page.body).toContain("<h1>");
    expect(site.robotsTxt?.body).toContain("Sitemap:");
  });

  it("times out, retries once, then gives up", async () => {
    const fetch = mockFetch(hang);
    const err = await failure(fetchWebsite({ domain: "acme.com" }, fast));
    expect(err.kind).toBe("timeout");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a Jina 5xx once, then fails", async () => {
    const fetch = mockFetch(() => jinaError(503, "overloaded"));
    const err = await failure(fetchWebsite({ domain: "acme.com" }, fast));
    expect(err).toMatchObject({ kind: "upstream_error", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds (429 → 200)", async () => {
    let calls = 0;
    mockFetch((url) => (++calls === 1 ? jinaError(429, "slow down", { "retry-after": "0" }) : siteHandler(url, {})));
    const site = await fetchWebsite({ domain: "acme.com" }, fast);
    expect(site.page.title).toBe("Acme | Widgets for teams");
  });

  it("does not retry permanent errors: unresolvable domain (422)", async () => {
    const fetch = mockFetch(() => jinaError(422, "Domain 'acme.com' could not be resolved"));
    const err = await failure(fetchWebsite({ domain: "acme.com" }, fast));
    expect(err).toMatchObject({ kind: "target_unreachable", status: 422 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps 402 (InsufficientBalanceError) to insufficient_balance, without retrying", async () => {
    const fetch = mockFetch(() => jinaError(402, "Account balance not enough to run this query, please recharge."));
    expect(await failure(fetchWebsite({ domain: "acme.com" }, fast))).toMatchObject({ kind: "insufficient_balance", status: 402 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps 402 the same way for site pages (hidden-assets passes, sitemaps)", async () => {
    mockFetch(() => jinaError(402, "insufficient balance"));
    expect(await failure(fetchSitePage({ domain: "acme.com", url: "https://acme.com/", engine: "direct" }, fast))).toMatchObject({ kind: "insufficient_balance" });
  });

  it.each([401, 403])("does not retry Jina's own refusal (%i): upstream_error, one request", async (status) => {
    const fetch = mockFetch(() => jinaError(status, "forbidden"));
    expect(await failure(fetchWebsite({ domain: "acme.com" }, fast))).toMatchObject({ kind: "upstream_error", status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry other auth errors (401)", async () => {
    const fetch = mockFetch(() => jinaError(401, "invalid key"));
    expect((await failure(fetchWebsite({ domain: "acme.com" }, fast))).kind).toBe("upstream_error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails when the site itself answers 4xx/5xx (Jina reports it inside a 200)", async () => {
    const fetch = mockFetch(() => homepage("acme.com", { httpStatus: 404 }));
    const err = await failure(fetchWebsite({ domain: "acme.com" }, fast));
    expect(err).toMatchObject({ kind: "target_http_error", status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1); // robots.txt not attempted
  });

  it.each([
    ["non-JSON body", () => new Response("<html>gateway</html>", { status: 200 })],
    ["JSON without data", () => new Response(JSON.stringify({ code: 200 }), { status: 200 })],
    ["data without html", () => homepage("acme.com", { html: undefined })],
    ["data without url", () => homepage("acme.com", { url: 42 })],
  ])("rejects a malformed response: %s", async (_name, respond) => {
    const fetch = mockFetch(respond);
    expect((await failure(fetchWebsite({ domain: "acme.com" }, fast))).kind).toBe("malformed_response");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats robots.txt as optional: unreachable → null, page still returned", async () => {
    mockFetch((url) => (url.endsWith("/robots.txt") ? jinaError(503) : homepage()));
    const site = await fetchWebsite({ domain: "acme.com" }, fast);
    expect(site.robotsTxt).toBeNull();
    expect(site.page.title).toBe("Acme | Widgets for teams");
  });

  it("returns a 404 robots.txt as a page (the analysis records it as not found)", async () => {
    mockFetch((url) => (url.endsWith("/robots.txt") ? robots("acme.com", "Not found", 404) : homepage()));
    expect((await fetchWebsite({ domain: "acme.com" }, fast)).robotsTxt?.httpStatus).toBe(404);
  });

  it.each(["localhost", "127.0.0.1", "https://acme.com", "acme.com/admin", "www.acme.com", "ACME.com", "acme.com:8080", ""])(
    "refuses anything but a normalized domain without calling out: %j",
    async (domain) => {
      const fetch = mockFetch(siteHandler);
      expect((await failure(fetchWebsite({ domain }, fast))).kind).toBe("invalid_domain");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("jina.fetchSitePage: uncached reads and links summary", () => {
  it("sends X-No-Cache and X-With-Links-Summary only when asked, and returns the links", async () => {
    const fetch = mockFetch((url) =>
      url.endsWith("/about")
        ? robots("acme.com", "About Acme")
        : jinaOk({ url: "https://acme.com/", title: "", text: "Acme", httpStatus: 200, links: { About: "https://acme.com/about", Bad: 42 } }),
    );
    const page = await fetchSitePage({ domain: "acme.com", url: "https://acme.com/", format: "text", fresh: true, withLinks: true }, fast);
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ "X-No-Cache": "true", "X-With-Links-Summary": "true", "X-Return-Format": "text" });
    expect(page.links).toEqual([{ text: "About", url: "https://acme.com/about" }]);

    const plain = await fetchSitePage({ domain: "acme.com", url: "https://acme.com/about", format: "text" }, fast);
    expect(fetch.mock.calls[1]![1]?.headers).not.toHaveProperty("X-No-Cache");
    expect(fetch.mock.calls[1]![1]?.headers).not.toHaveProperty("X-With-Links-Summary");
    expect(plain).not.toHaveProperty("links");
  });

  it("accepts the links summary as [text, url] pairs and ignores any other shape", async () => {
    mockFetch(() => jinaOk({ url: "https://acme.com/", text: "Acme", links: [["About", "https://acme.com/about"], ["x"], "y"] }));
    expect((await fetchSitePage({ domain: "acme.com", url: "https://acme.com/", format: "text", withLinks: true }, fast)).links).toEqual([{ text: "About", url: "https://acme.com/about" }]);
    mockFetch(() => jinaOk({ url: "https://acme.com/", text: "Acme", links: "nope" }));
    expect((await fetchSitePage({ domain: "acme.com", url: "https://acme.com/", format: "text", withLinks: true }, fast)).links).toEqual([]);
  });

  it.each(["https://evil.com/about", "https://acme.com.evil.com/", "ftp://acme.com/about"])("refuses an off-site URL without calling out: %s", async (url) => {
    const fetch = mockFetch(() => jinaOk({ url, text: "x" }));
    expect((await failure(fetchSitePage({ domain: "acme.com", url, format: "text", fresh: true }, fast))).kind).toBe("invalid_domain");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("JINA_API_KEY configuration (read from env only)", () => {
  const FAKE_KEY = "jina_test_fake_key_not_real";
  afterEach(() => {
    env.JINA_API_KEY = undefined;
  });

  it("missing: keyless requests (no Authorization header), no rendering, and the diagnostic says so", async () => {
    env.JINA_API_KEY = undefined;
    const fetch = mockFetch(siteHandler);
    await fetchWebsite({ domain: "acme.com" }, fast);
    for (const [, init] of fetch.mock.calls) expect(init?.headers).not.toHaveProperty("Authorization");
    expect(canRender()).toBe(false);
    expect(jinaConfigStatus()).toMatch(/^\[jina\] API key not configured/);
  });

  it("configured: sent as a bearer token, rendering available, and the diagnostic never prints the key", async () => {
    env.JINA_API_KEY = FAKE_KEY;
    const fetch = mockFetch(siteHandler);
    await fetchWebsite({ domain: "acme.com" }, fast);
    for (const [, init] of fetch.mock.calls) expect(init?.headers).toMatchObject({ Authorization: `Bearer ${FAKE_KEY}` });
    expect(canRender()).toBe(true);
    expect(jinaConfigStatus()).toBe("[jina] API key configured");
    expect(jinaConfigStatus()).not.toContain(FAKE_KEY);
  });

  it("a 402 with a key configured is still insufficient_balance, not retried, and the error never carries the key", async () => {
    env.JINA_API_KEY = FAKE_KEY;
    const fetch = mockFetch(() => jinaError(402, "Account balance not enough"));
    const err = await failure(fetchWebsite({ domain: "acme.com" }, fast));
    expect(err).toMatchObject({ kind: "insufficient_balance", status: 402 });
    expect(err.message).not.toContain(FAKE_KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
