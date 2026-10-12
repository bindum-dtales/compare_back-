// Facts collected from a company's own website (stored in companies.website_data).
// Everything here was observed in the fetched page; anything that couldn't be
// determined is null (unknown), never guessed.

export interface WebsiteHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** The first paragraph / list item after the heading (before the next heading), truncated; null if none. */
  followingText: string | null;
}

export interface WebsiteLink {
  /** Absolute http(s) URL. */
  url: string;
  text: string;
  /** Same normalized domain as the company (www. ignored, other subdomains are external). */
  internal: boolean;
}

export interface RobotsTxt {
  /** False when the site has no robots.txt (404, or an HTML fallback page instead of directives). */
  found: boolean;
  httpStatus: number | null;
  /** `Sitemap:` URLs declared in robots.txt. Not fetched or validated. */
  sitemaps: string[];
  /** The file itself, truncated. Null when not found. */
  content: string | null;
}

export interface WebsiteResearch {
  source: "jina-reader";
  /** What we asked for: always https://<normalized domain>/. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  /** The target site's status for the page; null if the reader didn't report it. */
  httpStatus: number | null;
  title: string | null;
  /** <meta name="description">. */
  description: string | null;
  /** <html lang>. */
  language: string | null;
  /** <link rel="canonical">. */
  canonical: string | null;
  /** <meta name="robots">. */
  metaRobots: string | null;
  /** og:* meta tags, e.g. { "og:title": "…" }. */
  openGraph: Record<string, string>;
  /** twitter:* meta tags. */
  twitter: Record<string, string>;
  /** h1–h6 in document order, as rendered (JS executed by the reader). */
  headings: WebsiteHeading[];
  /** Unique http(s) links in document order, capped. */
  links: WebsiteLink[];
  /** JSON-LD (<script type="application/ld+json">). Microdata/RDFa are not read. */
  structuredData: {
    /** Distinct @type values of top-level items and @graph members. */
    types: string[];
    items: unknown[];
    /** Blocks that weren't valid JSON. */
    invalidBlocks: number;
  };
  /** Null when robots.txt couldn't be fetched at all (unknown, not absent). */
  robotsTxt: RobotsTxt | null;
  /** Visible page text, whitespace-collapsed, truncated to a fixed length. */
  content: string;
  contentTruncated: boolean;
  /** Words in the full visible text (before truncation). */
  wordCount: number;
  /** Latest year in a "© 2024" / "Copyright 2020–2025" notice in the full visible text; null if none. */
  copyrightYear: number | null;
  fetchedAt: string;
  /** How the hidden-assets check (spec §7) ran; absent until it has. */
  hiddenAssetsCheck?: HiddenAssetsCheck;
}

export interface HiddenAssetsCheck {
  /** Pages checked (the homepage). */
  pages: string[];
  /** Whether the raw-HTML vs rendered-text diff ran; the placeholder and non-production checks always run. */
  diff: { ran: boolean; reason: string | null; blocksCompared: number | null };
  checkedAt: string;
}
