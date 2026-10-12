// Hidden assets (spec §7): content readable by crawlers but not rendered for visitors.
//
// Two passes per page, diffed:
//   1. the raw HTML (plain fetch, no JavaScript): what crawlers parse;
//   2. the visible text after JavaScript and CSS run (headless render's innerText).
// Flagged: text blocks (≥ MIN_BLOCK_WORDS words) present in pass 1 but absent from pass 2.
// Plus, regardless of the diff, on the raw HTML: placeholder text (lorem ipsum, john doe, test test,
// TODO) and resource URLs on non-production hosts (staging., dev., localhost, internal IPs).
//
// Pure: fetching is done by the caller. Findings use the existing HiddenAssetItem shape; severity is
// by kind: non-production hosts and placeholder copy are always defects (high); diff-only hidden text
// can be intentional collapsed UI (medium, see spec §11 on false positives).

import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { NON_VISIBLE, textOf } from "./website-analysis.js";
import type { HiddenAssetItem } from "../types/company.js";

/** Text blocks shorter than this are UI labels (menus, buttons), not content. */
export const MIN_BLOCK_WORDS = 8;
/** Findings kept per kind per page, longest / first first. */
export const MAX_FINDINGS_PER_KIND = 10;

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, dd";
const URL_ATTRS = ["href", "src", "srcset", "data-src", "data-srcset", "poster", "action", "content"];

const PLACEHOLDERS: { pattern: RegExp; label: string }[] = [
  { pattern: /lorem ipsum/i, label: "lorem ipsum" },
  { pattern: /\bjohn doe\b/i, label: "john doe" },
  { pattern: /\btest test\b/i, label: "test test" },
  { pattern: /\bTODO\b/, label: "TODO" },
];

/** Letters and digits only: rendered innerText and parsed text differ in spacing, case (text-transform) and punctuation. */
const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const excerpt = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Nearest element (self or ancestor) with an id, for a linkable URL. */
function anchorOf(el: HTMLElement | null): string | null {
  for (let e = el; e && e.tagName; e = e.parentNode as HTMLElement | null) if (e.id) return e.id;
  return null;
}

/** "<section#testimonials>", "<div.slider>" or "<p>": where in the markup a finding is. */
function describe(el: HTMLElement): string {
  for (let e: HTMLElement | null = el; e && e.tagName; e = e.parentNode as HTMLElement | null) {
    const tag = e.tagName.toLowerCase();
    if (e.id) return `<${tag}#${e.id}>`;
    const cls = e.classList?.value?.[0];
    if (cls && e !== el) return `<${tag}.${cls}>`;
  }
  return `<${el.tagName.toLowerCase()}>`;
}

/** `inner` is `outer` or one of its descendants. */
function within(inner: HTMLElement, outer: HTMLElement): boolean {
  for (let e: HTMLElement | null = inner; e; e = e.parentNode as HTMLElement | null) if (e === outer) return true;
  return false;
}

const insideNonVisible = (el: HTMLElement) => {
  for (let e: HTMLElement | null = el; e && e.tagName; e = e.parentNode as HTMLElement | null) if (NON_VISIBLE.has(e.tagName.toLowerCase())) return true;
  return false;
};

// --- Non-production hosts ----------------------------------------------------------------

const PRIVATE_IPV4 = /^(10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/;

/** Why a host isn't production (spec §7: "staging., dev., localhost, internal IP ranges"), or null. */
export function nonProductionReason(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (PRIVATE_IPV4.test(h) || h === "::1") return "internal IP address";
  // A staging./dev. sub-domain, not a site whose registered name is "dev" (dev.to).
  if (h.split(".").length >= 3 && /^(staging|dev)\./.test(h)) return `${h.split(".")[0]} environment`;
  return null;
}

function resourceUrls(el: HTMLElement): { attr: string; url: string }[] {
  const out: { attr: string; url: string }[] = [];
  for (const attr of URL_ATTRS) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const candidates = attr.endsWith("srcset") ? v.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "") : [v.trim()];
    for (const c of candidates) if (/^(https?:)?\/\//i.test(c)) out.push({ attr, url: c.startsWith("//") ? `https:${c}` : c });
  }
  for (const m of (el.getAttribute("style") ?? "").matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi)) out.push({ attr: "style", url: m[1]!.startsWith("//") ? `https:${m[1]}` : m[1]! });
  return out;
}

function stagingLeaks(root: HTMLElement, pageUrl: string): HiddenAssetItem[] {
  const byHost = new Map<string, { reason: string; urls: Set<string>; where: Set<string> }>();
  for (const el of root.querySelectorAll("*")) {
    for (const { attr, url } of resourceUrls(el)) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      const reason = nonProductionReason(host);
      if (!reason) continue;
      const entry = byHost.get(host) ?? { reason, urls: new Set(), where: new Set() };
      entry.urls.add(url);
      entry.where.add(`<${el.tagName.toLowerCase()} ${attr}>`);
      byHost.set(host, entry);
    }
  }
  return [...byHost.entries()].slice(0, MAX_FINDINGS_PER_KIND).map(([host, e]) => ({
    url: [...e.urls][0]!,
    foundIn: `${pageUrl} · ${[...e.where].slice(0, 3).join(", ")}`,
    issue: `${e.urls.size === 1 ? "A resource URL" : `${e.urls.size} resource URLs`} in the page markup point${e.urls.size === 1 ? "s" : ""} at ${host} (${e.reason}), a non-production host crawlers can read and follow.`,
    kind: "staging-leak",
    severity: "high",
  }));
}

// --- Placeholder text --------------------------------------------------------------------

interface TextHit {
  el: HTMLElement;
  text: string;
  label: string;
}

function placeholderHits(root: HTMLElement): TextHit[] {
  const hits: TextHit[] = [];
  const check = (el: HTMLElement, text: string) => {
    const p = PLACEHOLDERS.find((x) => x.pattern.test(text));
    if (p) hits.push({ el, text, label: p.label });
  };
  const walk = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      const t = n.text.replace(/\s+/g, " ").trim();
      if (t) check(n.parentNode as HTMLElement, t);
      return;
    }
    if (n.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (NON_VISIBLE.has(el.tagName?.toLowerCase())) return;
    for (const attr of ["alt", "title"]) {
      const v = el.getAttribute(attr);
      if (v) check(el, v);
    }
    el.childNodes.forEach(walk);
  };
  walk(root.querySelector("body") ?? root);
  // <title> and description meta tags live in <head> but are read by every crawler.
  const title = root.querySelector("title");
  if (title?.text) check(title, title.text.trim());
  for (const meta of root.querySelectorAll('meta[name="description" i], meta[property^="og:" i], meta[name^="twitter:" i]')) {
    const v = meta.getAttribute("content");
    if (v) check(meta, v);
  }
  // One finding per element.
  const seen = new Set<HTMLElement>();
  return hits.filter((h) => !seen.has(h.el) && !!seen.add(h.el));
}

// --- Rendered-vs-raw diff ----------------------------------------------------------------

/** Content blocks of the raw HTML, deduplicated, with enough words to be content rather than UI labels. */
function contentBlocks(root: HTMLElement): { el: HTMLElement; text: string }[] {
  const seen = new Set<string>();
  const out: { el: HTMLElement; text: string }[] = [];
  for (const el of (root.querySelector("body") ?? root).querySelectorAll(BLOCKS)) {
    if (insideNonVisible(el)) continue;
    const text = textOf(el);
    const key = compact(text);
    if (words(text) < MIN_BLOCK_WORDS || seen.has(key)) continue;
    seen.add(key);
    out.push({ el, text });
  }
  return out;
}

export interface HiddenAssetsInput {
  pageUrl: string;
  /** Pass 1: raw HTML. */
  rawHtml: string;
  /** Pass 2: visible text after render; null when the render pass isn't available (no diff). */
  visibleText: string | null;
}

export interface HiddenAssetsResult {
  assets: HiddenAssetItem[];
  /** Raw-HTML content blocks compared against the render; null when the diff didn't run. */
  blocksCompared: number | null;
}

export function findHiddenAssets({ pageUrl, rawHtml, visibleText }: HiddenAssetsInput): HiddenAssetsResult {
  const root = parse(rawHtml, { comment: false });
  const visible = visibleText === null ? null : compact(visibleText);
  const isHidden = (text: string) => visible !== null && !visible.includes(compact(text));
  const urlFor = (el: HTMLElement) => {
    const id = anchorOf(el);
    return id ? `${pageUrl.replace(/#.*$/, "")}#${id}` : pageUrl;
  };

  const placeholders = placeholderHits(root).slice(0, MAX_FINDINGS_PER_KIND);
  const placeholderEls = new Set(placeholders.map((h) => h.el));
  const placeholderAssets: HiddenAssetItem[] = placeholders.map((h) => ({
    url: urlFor(h.el),
    foundIn: `${pageUrl} · ${describe(h.el)}`,
    issue: `Placeholder text ("${h.label}") in the page markup: "${excerpt(h.text)}"${isHidden(h.text) ? " It is not visible on the rendered page, so only crawlers see it." : ""}`,
    kind: "hidden-content",
    severity: "high",
  }));

  const blocks = visible === null ? [] : contentBlocks(root);
  const hidden = blocks
    .filter((b) => isHidden(b.text) && ![...placeholderEls].some((p) => within(p, b.el)))
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_FINDINGS_PER_KIND);
  const diffAssets: HiddenAssetItem[] = hidden.map((b) => ({
    url: urlFor(b.el),
    foundIn: `${pageUrl} · ${describe(b.el)}`,
    issue: `Text in the raw HTML that is not visible on the rendered page, so crawlers read it but visitors never see it: "${excerpt(b.text)}"`,
    kind: "hidden-content",
    severity: "medium",
  }));

  return {
    assets: [...stagingLeaks(root, pageUrl), ...placeholderAssets, ...diffAssets],
    blocksCompared: visible === null ? null : blocks.length,
  };
}
