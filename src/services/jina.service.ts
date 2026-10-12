// Jina Reader (https://r.jina.ai): fetches a page in a headless browser and returns it as JSON.
//
// All target-site traffic goes through Jina; this server never connects to the company's
// host itself, so a domain that resolves to an internal address can't be used to reach
// our network. Inputs are normalized domains only (utils/domain.ts), never arbitrary URLs.
//
// Per research: two requests, the homepage (rendered HTML) and /robots.txt (text). Only when the
// homepage is too thin to name a category, up to three more for that step (category-pages.ts).
// Each request: hard timeout, at most one retry, and only for transient failures.

import { z } from "zod";
import { env } from "../config/env.js";
import { normalizeDomain } from "../utils/domain.js";
import { StepFailure } from "../utils/errors.js";

const READER = "https://r.jina.ai/";

export type JinaErrorKind =
  | "invalid_domain" // not a normalized domain; never sent
  | "timeout"
  | "network" // couldn't reach Jina
  | "rate_limited"
  | "target_unreachable" // Jina couldn't resolve/connect to the site
  | "target_http_error" // the site answered 4xx/5xx
  | "insufficient_balance" // 402: the JINA_API_KEY account has no balance left
  | "upstream_error" // Jina failed or refused (5xx, auth, quota…)
  | "malformed_response";

/** Messages are internal (logs); map `kind` to user-facing text, don't forward them. */
export class JinaError extends StepFailure<JinaErrorKind> {}

export interface JinaOptions {
  /** Per attempt. */
  timeoutMs?: number;
  /** Wait before the single retry (Retry-After wins, capped). */
  retryDelayMs?: number;
}

const DEFAULTS: Required<JinaOptions> = { timeoutMs: 45_000, retryDelayMs: 2_000 };
const MAX_ATTEMPTS = 2;
const MAX_RETRY_AFTER_MS = 10_000;

export interface JinaPage {
  /** The URL we asked Jina to read. */
  requestedUrl: string;
  /** Final URL after redirects, as reported by Jina. */
  url: string;
  title: string | null;
  description: string | null;
  /** Page <meta> tags Jina extracted (name/property → content), plus `lang`. */
  metadata: Record<string, string>;
  /** <link rel="canonical"> as reported by Jina. */
  canonical: string | null;
  /** The target's HTTP status; null if Jina didn't report it. */
  httpStatus: number | null;
  /** Rendered HTML (format "html") or plain text (format "text"). */
  body: string;
  /** Links on the page as Jina saw them (text → absolute URL); only when requested with `withLinks`. */
  links?: { text: string; url: string }[];
}

export interface FetchedWebsite {
  domain: string;
  page: JinaPage;
  /** Null when robots.txt couldn't be fetched (unknown); a 404 is still returned as a page. */
  robotsTxt: JinaPage | null;
}

const stringRecord = z
  .record(z.string(), z.unknown())
  .transform((r) => Object.fromEntries(Object.entries(r).filter((e): e is [string, string] => typeof e[1] === "string")));

const responseSchema = z.object({
  data: z.object({
    url: z.string().min(1),
    title: z.string().nullish(),
    description: z.string().nullish(),
    html: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    metadata: stringRecord.nullish(),
    external: z.object({ canonical: z.record(z.string(), z.unknown()).optional() }).loose().nullish(),
    httpStatus: z.number().int().nullish(),
    // X-With-Links-Summary: { text: url } (or [text, url] pairs); anything else is ignored.
    links: z.unknown().optional(),
  }),
});

function linksSummary(raw: unknown): { text: string; url: string }[] {
  const pairs = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw) : [];
  return pairs.flatMap((p) => (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" ? [{ text: p[0], url: p[1] }] : []));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response, fallback: number) {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, MAX_RETRY_AFTER_MS) : fallback;
}

type Attempt = { page: JinaPage } | { retryable: JinaError; retryIn: number };

/** Per-request reader options (headers), beyond format and engine. */
interface ReadOptions {
  engine?: JinaEngine;
  /**
   * X-No-Cache: read the page now instead of Jina's cached copy. Keyless, Jina can keep serving a
   * snapshot taken before a single-page app rendered (observed: thejewelleryshow.in's text read was
   * cached as "You need to enable JavaScript to run this app." while an uncached read rendered it).
   */
  fresh?: boolean;
  /** X-With-Links-Summary: also return the page's links, as Jina saw them after rendering. */
  withLinks?: boolean;
}

/**
 * Jina's fetch engine. "direct": plain HTTP fetch, no JavaScript (the raw HTML crawlers get).
 * "browser": headless render. Only honored with an API key; keyless requests are not rendered.
 */
export type JinaEngine = "direct" | "browser";

/** Whether rendered (browser-engine) reads are available: they need JINA_API_KEY. */
export const canRender = () => !!env.JINA_API_KEY;

/** Startup diagnostic: whether a key is configured. Never includes the key itself. */
export const jinaConfigStatus = () =>
  env.JINA_API_KEY
    ? "[jina] API key configured"
    : "[jina] API key not configured: keyless reads (low rate limit); the rendered hidden-assets comparison is skipped and reported as not checked";

/** Returns the page, or a transient error worth one retry; throws permanent errors. */
async function attempt(targetUrl: string, format: "html" | "text", timeoutMs: number, retryDelayMs: number, { engine, fresh, withLinks }: ReadOptions): Promise<Attempt> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Return-Format": format,
    ...(engine ? { "X-Engine": engine } : {}),
    ...(fresh ? { "X-No-Cache": "true" } : {}),
    ...(withLinks ? { "X-With-Links-Summary": "true" } : {}),
    // How long Jina waits for the page itself; leave headroom under our own timeout.
    "X-Timeout": String(Math.max(5, Math.floor(timeoutMs / 1000) - 10)),
  };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  let res: Response;
  try {
    res = await fetch(READER + targetUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const error = timedOut
      ? new JinaError("timeout", `Jina did not respond within ${timeoutMs}ms`)
      : new JinaError("network", `Could not reach Jina: ${e instanceof Error ? e.message : String(e)}`);
    return { retryable: error, retryIn: retryDelayMs };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const detail = (body as { message?: unknown } | undefined)?.message;
    const msg = `Jina HTTP ${res.status}${typeof detail === "string" ? `: ${detail}` : ""}`;
    if (res.status === 429) return { retryable: new JinaError("rate_limited", msg, 429), retryIn: retryAfterMs(res, retryDelayMs) };
    // 422 = Jina couldn't resolve or load the site (e.g. "Domain … could not be resolved").
    if (res.status === 422) throw new JinaError("target_unreachable", msg, 422);
    // 402 = InsufficientBalanceError: the key's account needs recharging. Not transient, so no retry.
    if (res.status === 402) throw new JinaError("insufficient_balance", msg, 402);
    if (res.status >= 500) return { retryable: new JinaError("upstream_error", msg, res.status), retryIn: retryDelayMs };
    throw new JinaError("upstream_error", msg, res.status);
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new JinaError("malformed_response", "Jina response did not match the expected shape");
  const d = parsed.data.data;
  const pageBody = format === "html" ? d.html : (d.text ?? d.content);
  if (typeof pageBody !== "string") throw new JinaError("malformed_response", `Jina response has no ${format} body`);

  return {
    page: {
      requestedUrl: targetUrl,
      url: d.url,
      title: d.title || null,
      description: d.description || null,
      metadata: d.metadata ?? {},
      canonical: Object.keys(d.external?.canonical ?? {})[0] ?? null,
      httpStatus: d.httpStatus ?? null,
      body: pageBody,
      ...(withLinks ? { links: linksSummary(d.links) } : {}),
    },
  };
}

/** One page through Jina, retried once on transient failures (timeout, network, 429, 5xx).
 *  Private: callers go through fetchWebsite, which only builds URLs from a normalized domain. */
async function readPage(targetUrl: string, format: "html" | "text", opts: JinaOptions = {}, read: ReadOptions = {}): Promise<JinaPage> {
  const { timeoutMs, retryDelayMs } = { ...DEFAULTS, ...opts };
  for (let i = 1; ; i++) {
    const result = await attempt(targetUrl, format, timeoutMs, retryDelayMs, read);
    if ("page" in result) return result.page;
    if (i >= MAX_ATTEMPTS) throw result.retryable;
    await sleep(result.retryIn);
  }
}

/**
 * Fetch a company's homepage and robots.txt. `domain` must already be normalized
 * (as stored in research_jobs.company_domain); anything else is refused, not fixed up.
 */
export async function fetchWebsite({ domain }: { domain: string }, opts: JinaOptions = {}): Promise<FetchedWebsite> {
  if (normalizeDomain(domain) !== domain) throw new JinaError("invalid_domain", "Refusing to fetch a non-normalized domain");

  const page = await readPage(`https://${domain}/`, "html", opts);
  if (page.httpStatus !== null && page.httpStatus >= 400) {
    throw new JinaError("target_http_error", `Site responded with HTTP ${page.httpStatus}`, page.httpStatus);
  }

  // robots.txt is supplementary: if it can't be fetched, record "unknown" rather than fail.
  let robotsTxt: JinaPage | null = null;
  try {
    robotsTxt = await readPage(`https://${domain}/robots.txt`, "text", opts);
  } catch (e) {
    console.warn("[jina] robots.txt unavailable for", domain, e instanceof JinaError ? e.kind : "error");
  }
  return { domain, page, robotsTxt };
}

/** The domain itself or one of its subdomains: the only hosts we ever ask Jina to read for a company. */
export function isSameSite(url: string, domain: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const host = normalizeDomain(url);
  return !!host && (host === domain || host.endsWith(`.${domain}`));
}

export interface SitePageRequest extends ReadOptions {
  domain: string;
  url: string;
  /** Default "html". "text" with the browser engine is the page's visible text after JS and CSS. */
  format?: "html" | "text";
  /** Default: Jina's own choice (as for the homepage). */
  engine?: JinaEngine;
}

/**
 * Another page of a company's own site (e.g. a sitemap URL declared in its robots.txt, or the
 * homepage again with a specific engine). Refuses URLs outside `domain` and its subdomains, so
 * site-supplied URLs can't point us elsewhere.
 */
export async function fetchSitePage({ domain, url, format = "html", engine, fresh, withLinks }: SitePageRequest, opts: JinaOptions = {}): Promise<JinaPage> {
  if (normalizeDomain(domain) !== domain) throw new JinaError("invalid_domain", "Refusing to fetch a non-normalized domain");
  if (!isSameSite(url, domain)) throw new JinaError("invalid_domain", "Refusing to fetch a URL outside the company's domain");
  return readPage(url, format, opts, { engine, fresh, withLinks });
}
