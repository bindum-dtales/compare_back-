// The scoring rubric: how spec §4/§5 signals become 0–100 sub-metric scores.
//
// Every sub-metric is a checklist of the signals the spec names for it. Each check is worth the
// same (no weights), mirroring §4's "plain average, nothing more elaborate":
//
//   sub-metric score = round(100 × mean of its measured checks' values)
//
// - A pass/fail check is 1 or 0.
// - A count check is min(count / cap, 1); every cap is in CAPS below, the one place to tune.
// - A check that could not be measured (a fetch failed, robots.txt unknown) is null and left out
//   of the mean, never guessed. Something the site simply doesn't have (no sitemap, no dates, no
//   copyright notice) is measured: it scores 0.
//
// Pillar scores (utils/scoring.ts) are the plain average of the four sub-metrics.

export interface Check {
  /** Stable id, e.g. "technical.indexable". Evidence bullets cite these. */
  id: string;
  label: string;
  /** 0–1, or null when the signal couldn't be measured (excluded from the score). */
  value: number | null;
  /** What was observed, e.g. "meta robots: index, follow". */
  detail: string;
}

export interface MetricResult {
  score: number;
  checks: Check[];
  /** Signals the spec lists for this metric that this build does not collect, with the reason. */
  notMeasured: string[];
  /** Set when the metric is a proxy for a paid source the spec recommends (§5, "how the prototype gets it"). */
  proxy?: string;
}

export const CAPS = {
  /** SEO content: owned content pages (blog, resources, case studies…) for full marks. */
  contentPages: 20,
  /** SEO content cadence: content pages updated in the last 12 months (≈ one a month). */
  contentPagesLastYear: 12,
  /** GEO freshness cadence: content pages updated in the last RECENT_DAYS (≈ one a month). */
  contentPagesRecent: 3,
  /** SEO backlinks: distinct third-party sites mentioning the brand in the top search results. */
  mentioningDomains: 10,
  /** AEO direct answer: question-style headings for full marks. */
  questionHeadings: 3,
  /** GEO brand scale: LinkedIn followers for full marks (log scale: 100 → 0.4, 1 000 → 0.6, 10 000 → 0.8). */
  linkedinFollowers: 100_000,
  /** GEO brand clarity: other brand hosts at which the score for that check reaches 0. */
  extraBrandHosts: 3,
} as const;

/** Freshness / cadence window in days for "recently updated". */
export const RECENT_DAYS = 90;
/** A concise answer: a first paragraph of at most this many words (and at least MIN_ANSWER_WORDS). */
export const MAX_ANSWER_WORDS = 60;
export const MIN_ANSWER_WORDS = 5;

export const pass = (id: string, label: string, ok: boolean, detail: string): Check => ({ id, label, value: ok ? 1 : 0, detail });

export const count = (id: string, label: string, n: number, cap: number, detail: string): Check => ({
  id,
  label,
  value: Math.min(n / cap, 1),
  detail,
});

export const unknown = (id: string, label: string, detail: string): Check => ({ id, label, value: null, detail });

export function scoreChecks(checks: Check[]): number {
  const measured = checks.filter((c) => c.value !== null).map((c) => c.value!);
  if (!measured.length) throw new RangeError(`no measurable check among ${checks.map((c) => c.id).join(", ")}`);
  return Math.round((100 * measured.reduce((a, b) => a + b, 0)) / measured.length);
}

export function metric(checks: Check[], extra: Omit<MetricResult, "score" | "checks"> = { notMeasured: [] }): MetricResult {
  return { score: scoreChecks(checks), checks, ...extra };
}
