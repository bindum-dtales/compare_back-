// Canned Jina Reader responses (shape captured from the real API) and a fetch stub.
import { vi } from "vitest";

export const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Acme | Widgets for teams</title>
  <meta name="description" content="Acme makes  widgets.">
  <meta name="robots" content="index, follow">
  <meta property="og:title" content="Acme">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="https://acme.com/">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
  <script type="application/ld+json">[{"@type":["WebSite","Thing"]},{"@graph":[{"@type":"BreadcrumbList"}]}]</script>
  <script type="application/ld+json">{not json</script>
  <style>.x{color:red}</style>
</head>
<body>
  <nav><a href="/">Home</a> <a href="/about">About us</a> <a href="https://www.acme.com/about">About again</a></nav>
  <h1><span>AI</span><span>Native</span> widgets</h1>
  <p>We build widgets &amp; gadgets for teams.</p>
  <h2>Pricing</h2>
  <h3>   </h3>
  <script>window.secret = "not visible text"</script>
  <a href="https://blog.acme.com/post">Blog</a>
  <a href="https://twitter.com/acme">Twitter</a>
  <a href="mailto:hi@acme.com">Email</a>
  <a href="javascript:void(0)">Nothing</a>
  <a href="/">Home duplicate</a>
</body>
</html>`;

export const ROBOTS_TXT = "User-agent: *\nDisallow: /admin\n\nSitemap: https://acme.com/sitemap.xml\nSitemap: https://acme.com/sitemap-blog.xml\n";

export function jinaOk(data: Record<string, unknown>, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ code: 200, status: 20000, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export const jinaError = (status: number, message = "error", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ data: null, code: status, name: "Error", message }), { status, headers });

export const homepage = (domain = "acme.com", extra: Record<string, unknown> = {}) =>
  jinaOk({
    url: `https://${domain}/`,
    title: "Acme | Widgets for teams",
    description: "Acme makes widgets.",
    html: HOMEPAGE_HTML,
    metadata: { lang: "en", description: "Acme makes widgets.", robots: "index, follow" },
    external: { canonical: { [`https://${domain}/`]: {} } },
    httpStatus: 200,
    ...extra,
  });

export const robots = (domain = "acme.com", text = ROBOTS_TXT, httpStatus = 200) =>
  jinaOk({ url: `https://${domain}/robots.txt`, title: "", text, httpStatus });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Stubs global fetch; the spy records every call. Unstub with vi.unstubAllGlobals(). */
export function mockFetch(handler: Handler) {
  const spy = vi.fn((input: string | URL | Request, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Answers homepage and robots.txt requests for any domain. */
export const siteHandler: Handler = (url) => {
  const target = url.replace("https://r.jina.ai/", "");
  const domain = new URL(target).hostname;
  return target.endsWith("/robots.txt") ? robots(domain) : homepage(domain);
};

/** A fetch that never answers until its AbortSignal fires (i.e. our timeout). */
export const hang: Handler = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });
