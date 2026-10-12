import { describe, expect, it } from "vitest";
import { findHiddenAssets, MAX_FINDINGS_PER_KIND, nonProductionReason } from "../src/services/hidden-assets.js";

const PAGE = "https://acme.com/";
const LONG = "Our clients trust us to deliver accurate technical content every single quarter";

describe("nonProductionReason (spec §7: staging., dev., localhost, internal IPs)", () => {
  it.each([
    ["staging.acme.com", "staging environment"],
    ["dev.acme.com", "dev environment"],
    ["localhost", "localhost"],
    ["app.localhost", "localhost"],
    ["10.0.0.5", "internal IP address"],
    ["192.168.1.20", "internal IP address"],
    ["172.20.3.4", "internal IP address"],
    ["127.0.0.1", "internal IP address"],
    ["[::1]", "internal IP address"],
  ])("%s → %s", (host, reason) => expect(nonProductionReason(host)).toBe(reason));

  it.each(["acme.com", "dev.to", "staging.com", "172.32.0.1", "8.8.8.8", "developer.acme.com", "cdn.acme.com"])("%s is production", (host) => {
    expect(nonProductionReason(host)).toBeNull();
  });
});

describe("findHiddenAssets", () => {
  it("diffs raw-HTML content blocks against the rendered visible text (≥ 8 words), keeping short UI labels out", () => {
    const raw = `<body>
      <nav><ul><li>Pricing</li><li>About us</li></ul></nav>
      <h1>Technical content that converts</h1>
      <section id="testimonials"><div class="slider"><blockquote>${LONG}</blockquote></div></section>
      <p>We write documentation and blog posts for developer tools companies worldwide.</p>
    </body>`;
    // innerText: different case and spacing, no testimonial, no nav (collapsed menu).
    const visible = "TECHNICAL CONTENT THAT CONVERTS\\nWe write documentation and blog posts for developer-tools companies worldwide.";
    const { assets, blocksCompared } = findHiddenAssets({ pageUrl: PAGE, rawHtml: raw, visibleText: visible });
    expect(blocksCompared).toBe(2);
    expect(assets).toEqual([
      {
        url: "https://acme.com/#testimonials",
        foundIn: "https://acme.com/ · <div.slider>", // nearest identifiable ancestor; the URL uses the nearest id
        issue: `Text in the raw HTML that is not visible on the rendered page, so crawlers read it but visitors never see it: "${LONG}"`,
        kind: "hidden-content",
        severity: "medium",
      },
    ]);
  });

  it("does not diff without a rendered pass, but still runs the regex checks", () => {
    const raw = `<body><p>${LONG}</p><img src="https://staging.acme.com/team.png"><p>Lorem ipsum dolor sit amet</p></body>`;
    const r = findHiddenAssets({ pageUrl: PAGE, rawHtml: raw, visibleText: null });
    expect(r.blocksCompared).toBeNull();
    expect(r.assets.map((a) => [a.kind, a.severity])).toEqual([
      ["staging-leak", "high"],
      ["hidden-content", "high"],
    ]);
  });

  it("flags placeholder text in text, alt/title attributes, <title> and description meta, but not scripts or form placeholders", () => {
    const raw = `<html><head><title>TODO title</title><meta name="description" content="Lorem ipsum site"><script>// TODO: lorem ipsum</script></head>
      <body>
        <div class="card"><span>John Doe, CEO</span></div>
        <img src="/a.png" alt="test test image">
        <input placeholder="e.g. John Doe">
        <p>Our todo list app helps teams.</p>
        <style>.lorem-ipsum{}</style>
      </body></html>`;
    const { assets } = findHiddenAssets({ pageUrl: PAGE, rawHtml: raw, visibleText: null });
    expect(assets.map((a) => a.issue)).toEqual([
      'Placeholder text ("john doe") in the page markup: "John Doe, CEO"',
      'Placeholder text ("test test") in the page markup: "test test image"',
      'Placeholder text ("TODO") in the page markup: "TODO title"',
      'Placeholder text ("lorem ipsum") in the page markup: "Lorem ipsum site"',
    ]);
    expect(assets[0]!.foundIn).toBe("https://acme.com/ · <div.card>");
  });

  it("reports hidden placeholder copy once, as placeholder text that only crawlers see (the prototype's case)", () => {
    const raw = `<body><section id="reviews"><p>Lorem ipsum dolor sit amet consectetur adipiscing elit sed do</p><p>John Doe, CEO</p></section><p>${LONG}</p></body>`;
    const { assets } = findHiddenAssets({ pageUrl: PAGE, rawHtml: raw, visibleText: LONG });
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.severity === "high" && a.url === "https://acme.com/#reviews")).toBe(true);
    expect(assets[0]!.issue).toMatch(/not visible on the rendered page, so only crawlers see it\.$/);
  });

  it("groups non-production resources by host, across src, srcset, href, style and protocol-relative URLs", () => {
    const raw = `<body>
      <img src="https://staging.acme.com/a.png" srcset="https://staging.acme.com/a2.png 2x, /local.png 1x">
      <a href="//dev.acme.com/preview">Preview</a>
      <div style="background:url('http://192.168.0.10/bg.jpg')"></div>
      <link rel="stylesheet" href="https://cdn.acme.com/site.css">
      <a href="https://dev.to/acme">Our dev.to blog</a>
    </body>`;
    const { assets } = findHiddenAssets({ pageUrl: PAGE, rawHtml: raw, visibleText: null });
    expect(assets.map((a) => [a.url, a.foundIn])).toEqual([
      ["https://staging.acme.com/a.png", "https://acme.com/ · <img src>, <img srcset>"],
      ["https://dev.acme.com/preview", "https://acme.com/ · <a href>"],
      ["http://192.168.0.10/bg.jpg", "https://acme.com/ · <div style>"],
    ]);
    expect(assets[0]!.issue).toBe("2 resource URLs in the page markup point at staging.acme.com (staging environment), a non-production host crawlers can read and follow.");
  });

  it("returns nothing for a clean page, and caps findings per kind", () => {
    expect(findHiddenAssets({ pageUrl: PAGE, rawHtml: `<body><p>${LONG}</p></body>`, visibleText: LONG }).assets).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) => `<p>Hidden paragraph number ${i} with enough words to count as content here</p>`).join("");
    const { assets } = findHiddenAssets({ pageUrl: PAGE, rawHtml: `<body>${many}</body>`, visibleText: "" });
    expect(assets).toHaveLength(MAX_FINDINGS_PER_KIND);
  });

  it("finds nothing in an SPA shell (no raw content to hide)", () => {
    const shell = '<html><head><title>App</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>';
    expect(findHiddenAssets({ pageUrl: PAGE, rawHtml: shell, visibleText: "Rendered app text" })).toEqual({ assets: [], blocksCompared: 0 });
  });
});
