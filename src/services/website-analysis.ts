// Turns what Jina fetched into WebsiteResearch facts. Pure: no I/O, no scoring.
// Only records what the page actually contains; anything absent is null / empty.

import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { normalizeDomain } from "../utils/domain.js";
import type { FetchedWebsite } from "./jina.service.js";
import type { RobotsTxt, WebsiteHeading, WebsiteLink, WebsiteResearch } from "../types/website.js";

const MAX_CONTENT_CHARS = 20_000;
const MAX_LINKS = 500;
const MAX_HEADINGS = 200;
const MAX_JSONLD_ITEMS = 50;
const MAX_ROBOTS_CHARS = 5_000;
const MAX_FOLLOWING_CHARS = 400;

export const NON_VISIBLE = new Set(["script", "style", "noscript", "template", "svg", "head", "iframe"]);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const orNull = (s: string | null | undefined) => (s && collapse(s)) || null;

/**
 * Visible text of a node. Text nodes are joined with spaces so adjacent inline
 * elements (<span>AI</span><span>Native</span>) don't run together.
 */
export function textOf(node: Node): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) parts.push(n.text);
    else if (n.nodeType === NodeType.ELEMENT_NODE && !NON_VISIBLE.has((n as HTMLElement).tagName?.toLowerCase())) n.childNodes.forEach(walk);
  };
  walk(node);
  return collapse(parts.join(" "));
}

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const meta = (root: HTMLElement, name: string) =>
  orNull(root.querySelector(`meta[name="${name}" i]`)?.getAttribute("content"));

function prefixed(root: HTMLElement, jinaMeta: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of root.querySelectorAll("meta")) {
    const key = (el.getAttribute("property") ?? el.getAttribute("name"))?.toLowerCase();
    const content = el.getAttribute("content");
    if (key?.startsWith(prefix) && content) out[key] ??= collapse(content);
  }
  for (const [k, v] of Object.entries(jinaMeta)) if (k.startsWith(prefix)) out[k] ??= v;
  return out;
}

/** Headings in document order, each with the first text block that follows it (for direct-answer checks). */
function headings(root: HTMLElement): WebsiteHeading[] {
  const out: WebsiteHeading[] = [];
  let open: WebsiteHeading | null = null;
  for (const el of root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, dd, blockquote")) {
    const text = textOf(el);
    if (!text) continue;
    if (/^h[1-6]$/i.test(el.tagName)) {
      open = { level: Number(el.tagName[1]) as WebsiteHeading["level"], text, followingText: null };
      out.push(open);
    } else if (open && open.followingText === null) {
      open.followingText = text.slice(0, MAX_FOLLOWING_CHARS);
    }
  }
  return out.slice(0, MAX_HEADINGS);
}

const COPYRIGHT = /(?:©|\(c\)|\bcopyright\b)\s*(?:(?:19|20)\d{2}\s*[-–—]\s*)?((?:19|20)\d{2})\b/gi;

export function copyrightYear(text: string): number | null {
  const years = [...text.matchAll(COPYRIGHT)].map((m) => Number(m[1]));
  return years.length ? Math.max(...years) : null;
}

function links(root: HTMLElement, baseUrl: string, domain: string): WebsiteLink[] {
  const seen = new Map<string, WebsiteLink>();
  for (const a of root.querySelectorAll("a[href]")) {
    let url: URL;
    try {
      url = new URL(a.getAttribute("href")!.trim(), baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue; // mailto:, tel:, javascript:…
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.set(href, { url: href, text: textOf(a).slice(0, 200), internal: normalizeDomain(href) === domain });
    if (seen.size >= MAX_LINKS) break;
  }
  return [...seen.values()];
}

function structuredData(root: HTMLElement): WebsiteResearch["structuredData"] {
  const items: unknown[] = [];
  let invalidBlocks = 0;
  for (const s of root.querySelectorAll('script[type="application/ld+json" i]')) {
    try {
      const json: unknown = JSON.parse(s.rawText);
      items.push(...(Array.isArray(json) ? json : [json]));
    } catch {
      invalidBlocks++;
    }
  }
  const types = new Set<string>();
  const addTypes = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const t = (item as Record<string, unknown>)["@type"];
    for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string") types.add(v);
    const graph = (item as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) graph.forEach(addTypes);
  };
  items.forEach(addTypes);
  return { types: [...types], items: items.slice(0, MAX_JSONLD_ITEMS), invalidBlocks };
}

const ROBOTS_DIRECTIVE = /^\s*(user-agent|disallow|allow|sitemap|crawl-delay)\s*:/im;

function robots(page: FetchedWebsite["robotsTxt"]): RobotsTxt | null {
  if (!page) return null;
  const ok = page.httpStatus === null || (page.httpStatus >= 200 && page.httpStatus < 300);
  // SPAs often answer every path with index.html; that's not a robots.txt.
  const found = ok && ROBOTS_DIRECTIVE.test(page.body);
  if (!found) return { found: false, httpStatus: page.httpStatus, sitemaps: [], content: null };
  const sitemaps = [...page.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!);
  return { found, httpStatus: page.httpStatus, sitemaps: [...new Set(sitemaps)], content: page.body.slice(0, MAX_ROBOTS_CHARS) };
}

export function analyzeWebsite(fetched: FetchedWebsite, fetchedAt = new Date()): WebsiteResearch {
  const { page, domain } = fetched;
  const root = parse(page.body, { comment: false });
  const body = root.querySelector("body") ?? root;
  const text = textOf(body);

  return {
    source: "jina-reader",
    url: page.requestedUrl,
    finalUrl: page.url,
    httpStatus: page.httpStatus,
    title: orNull(root.querySelector("title")?.text) ?? orNull(page.title),
    description: meta(root, "description") ?? orNull(page.metadata.description),
    language: orNull(root.querySelector("html")?.getAttribute("lang")) ?? orNull(page.metadata.lang),
    canonical: orNull(root.querySelector('link[rel="canonical" i]')?.getAttribute("href")) ?? page.canonical,
    metaRobots: meta(root, "robots") ?? orNull(page.metadata.robots),
    openGraph: prefixed(root, page.metadata, "og:"),
    twitter: prefixed(root, page.metadata, "twitter:"),
    headings: headings(root),
    links: links(root, page.url, domain),
    structuredData: structuredData(root),
    robotsTxt: robots(fetched.robotsTxt),
    content: text.slice(0, MAX_CONTENT_CHARS),
    contentTruncated: text.length > MAX_CONTENT_CHARS,
    wordCount: countWords(text),
    copyrightYear: copyrightYear(text),
    fetchedAt: fetchedAt.toISOString(),
  };
}
