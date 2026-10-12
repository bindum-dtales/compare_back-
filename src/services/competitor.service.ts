// Competitor discovery + selection.
//
//   category → ≤3 search queries (stop early once there are enough viable candidates)
//   → extractCandidates (normalize, drop target/invalid/non-company, dedupe)
//   → triage: rejected (deterministic no) / classify. Nothing is accepted deterministically.
//   → the rest (top MAX_LLM_CANDIDATES by rank) classified by the LLM in one call; only
//     direct_competitor at MIN_LLM_CONFIDENCE or above is a legitimate competitor
//   → rank legitimate competitors, keep up to 4. Fewer than 2 is reported, never padded.

import { z } from "zod";
import { getLlmProvider, type LlmProvider } from "./llm.service.js";
import { createSearchSession, getSearchProvider, SearchError, type SearchSession } from "./search.service.js";
import { EXCLUDED_DOMAINS, extractCandidates, rank, triage, type TaggedResult } from "./candidates.js";
import type {
  CategoryResult,
  CompetitorCandidate,
  CompetitorDiscovery,
  CompetitorSelection,
  EvaluatedCandidate,
  SearchRecord,
  SelectedCompetitor,
} from "../types/discovery.js";

export const MAX_QUERIES = 3;
export const MAX_COMPETITORS = 4;
export const MIN_COMPETITORS = 2;
/** Stop searching once this many candidates survive deterministic filtering. */
const ENOUGH_VIABLE = 8;
const RESULTS_PER_QUERY = 10;
const MAX_LLM_CANDIDATES = 12;
export const MIN_LLM_CONFIDENCE = 0.6;

export interface DiscoveryTarget {
  name: string;
  domain: string;
}

// --- Queries ---------------------------------------------------------------------------

const COUNTABLE_HEAD = /\b(agency|company|firm|studio|consultancy|platform|tool|app|marketplace|network|provider|startup|brand|manufacturer|retailer|school|clinic|lab)$/i;

const plural = (s: string) =>
  /y$/i.test(s) && !/[aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(s) ? `${s}es` : `${s}s`;

/** "B2B Content Agency" → "B2B content agencies"; "Payroll Software" → "payroll software companies". */
export function categoryNoun(phrase: string) {
  return COUNTABLE_HEAD.test(phrase) ? plural(phrase) : `${phrase} companies`;
}

const listQuery = (phrase: string) => `top ${categoryNoun(phrase)}`;

/** Up to MAX_QUERIES distinct queries, most specific first. Built only from the detected category. */
export function buildQueries(category: Pick<CategoryResult, "category" | "subcategory">): string[] {
  const specific = category.subcategory ?? category.category;
  const queries = [listQuery(specific), category.subcategory ? listQuery(category.category) : null, `${specific} competitors`];
  const seen = new Set<string>();
  return queries
    .filter((q): q is string => !!q)
    .filter((q) => {
      const k = q.toLowerCase();
      return !seen.has(k) && !!seen.add(k);
    })
    .slice(0, MAX_QUERIES);
}

// --- Discovery -------------------------------------------------------------------------

/**
 * Searches for candidates. One search session per call (= per job): repeated queries are
 * served from memory. If some queries fail but at least one succeeded, continues with what it
 * has; if every query fails, the last SearchError is thrown.
 */
export async function discoverCompetitors(
  target: DiscoveryTarget,
  category: CategoryResult,
  session: SearchSession = createSearchSession(getSearchProvider()),
): Promise<CompetitorDiscovery> {
  const searches: SearchRecord[] = [];
  const results: TaggedResult[] = [];
  let lastError: unknown;
  let extracted = extractCandidates([], target.domain, category);

  for (const query of buildQueries(category)) {
    try {
      const found = await session.search(query, { maxResults: RESULTS_PER_QUERY, excludeDomains: [...EXCLUDED_DOMAINS, target.domain] });
      searches.push({ query, provider: session.provider, resultCount: found.length });
      results.push(...found.map((r) => ({ ...r, query })));
    } catch (e) {
      if (!(e instanceof SearchError)) throw e;
      lastError = e;
      searches.push({ query, provider: session.provider, resultCount: null });
      console.warn(`[competitors] search failed (${e.kind}) for query:`, query);
      if (e.kind === "rate_limited" || e.kind === "quota_exceeded" || e.kind === "not_configured") break; // more queries won't help
      continue;
    }
    extracted = extractCandidates(results, target.domain, category);
    if (extracted.candidates.filter((c) => triage(c).kind !== "rejected").length >= ENOUGH_VIABLE) break;
  }

  if (searches.every((s) => s.resultCount === null) && lastError) throw lastError;
  return { searches, ...extracted };
}

// --- Selection -------------------------------------------------------------------------

/** What the classifier says a candidate's domain is. Only direct_competitor can be selected. */
export const CANDIDATE_KINDS = ["direct_competitor", "review_or_editorial", "directory_or_marketplace", "not_a_competitor"] as const;

const classificationSchema = z.object({
  candidates: z.array(
    z.object({
      domain: z.string(),
      name: z.string().trim().min(1).max(120),
      kind: z.enum(CANDIDATE_KINDS),
      confidence: z.number().min(0).max(1),
      reason: z.string().trim().min(3).max(300),
    }),
  ),
});

const SYSTEM = `You check whether search results point to companies that compete with a target company.

Classify the company that OWNS each candidate's domain as exactly one kind:
- direct_competitor: it sells its own product or service in the target's category that the target's buyers could choose instead (an actual SaaS product, software company or provider of the same core offering).
- review_or_editorial: it publishes about products rather than selling one: review or testing sites, "best X" / "top X" lists, "X alternatives" or "X vs Y" articles, rankings, comparison sites, affiliate sites, news, magazines and blogs about the industry.
- directory_or_marketplace: sites that list or showcase other companies' sites, designs, templates or products: website or design galleries, showcases and inspiration sites, template and theme collections or marketplaces, directories, listing or review aggregators, resource lists, marketplaces, job boards, communities.
- not_a_competitor: anything else, including companies in a different category and companies that only sell tools or services to that market without offering the same thing.

Judge only from the URL, title and snippet, against the target's category. A title or snippet that names the category does not make a site a competitor: judge what its owner sells. If the result is an article or list, judge the company that owns the domain, not the companies mentioned in it: a vendor's own blog post can still belong to a direct_competitor, while a site whose business is reviewing or ranking products is review_or_editorial even when its page is about the right category.

Return one entry per candidate, using its exact domain:
- name: the company's name as shown in the title or snippet; if none is shown, the domain.
- kind: one of the kinds above.
- confidence: 0–1, how sure you are of the kind.
- reason: one short factual sentence based on the snippet. No speculation.`;

function toSelected(c: EvaluatedCandidate, category: string, source: string): SelectedCompetitor {
  return {
    name: c.name,
    domain: c.domain,
    url: c.url,
    category,
    source,
    discoveryEvidence: {
      sourceQueries: c.sourceQueries,
      title: c.title,
      snippet: c.snippet,
      method: c.method,
      confidence: c.confidence,
      reason: c.reason,
      signals: c.signals,
    },
  };
}

export interface SelectInput {
  target: DiscoveryTarget;
  /** The target's own description (meta description), for the similarity judgement. */
  targetDescription: string | null;
  category: CategoryResult;
  discovery: CompetitorDiscovery;
}

/** Decides which candidates are legitimate competitors and picks up to MAX_COMPETITORS. */
export async function selectCompetitors(
  { target, targetDescription, category, discovery }: SelectInput,
  llm?: LlmProvider,
): Promise<CompetitorSelection> {
  const evaluated: EvaluatedCandidate[] = [];
  const toClassify: CompetitorCandidate[] = [];

  for (const c of [...discovery.candidates].sort((a, b) => rank(b) - rank(a))) {
    const t = triage(c);
    if (t.kind === "rejected") evaluated.push({ ...c, verdict: "rejected", method: "deterministic", confidence: 1, reason: t.reason });
    else toClassify.push(c);
  }

  const toAsk = toClassify.slice(0, MAX_LLM_CANDIDATES);
  for (const c of toClassify.slice(MAX_LLM_CANDIDATES)) {
    evaluated.push({ ...c, verdict: "rejected", method: "deterministic", confidence: 0, reason: "Not evaluated: lower-ranked than the candidates that were." });
  }

  if (toAsk.length) {
    const provider = llm ?? getLlmProvider();
    const out = await provider.generateObject({
      name: "competitor_classification",
      system: SYSTEM,
      user: JSON.stringify({
        target: {
          name: target.name,
          domain: target.domain,
          category: category.category,
          subcategory: category.subcategory,
          description: targetDescription,
          categoryRationale: category.rationale,
        },
        candidates: toAsk.map((c) => ({ domain: c.domain, url: c.url, title: c.title, snippet: c.snippet.slice(0, 500) })),
      }),
      schema: classificationSchema,
      // ≤ 12 short verdicts (~0.8k output tokens measured); the cap counts against Groq TPM.
      reasoningEffort: "low",
      maxCompletionTokens: 2048,
    });
    // Only verdicts for domains we asked about count; the model can't add companies.
    const verdicts = new Map(out.candidates.map((v) => [v.domain.toLowerCase(), v]));
    for (const c of toAsk) {
      const v = verdicts.get(c.domain);
      if (!v) {
        evaluated.push({ ...c, verdict: "rejected", method: "llm", confidence: 0, reason: "The model returned no verdict for this candidate." });
        continue;
      }
      const competitor = v.kind === "direct_competitor";
      const ok = competitor && v.confidence >= MIN_LLM_CONFIDENCE;
      evaluated.push({
        ...c,
        name: v.name,
        verdict: ok ? "accepted" : "rejected",
        method: "llm",
        classification: v.kind,
        confidence: v.confidence,
        reason: !competitor || ok ? v.reason : `${v.reason} (confidence ${v.confidence} below ${MIN_LLM_CONFIDENCE})`,
      });
    }
  }

  // Every accepted candidate is a direct_competitor verdict: by confidence, then search rank.
  const legit = evaluated.filter((c) => c.verdict === "accepted").sort((a, b) => b.confidence - a.confidence || rank(b) - rank(a));
  const chosen = new Set(legit.slice(0, MAX_COMPETITORS).map((c) => c.domain));
  for (const c of evaluated) if (chosen.has(c.domain)) c.verdict = "selected";

  const source = discovery.searches[0]?.provider ?? "search";
  const competitors = legit.slice(0, MAX_COMPETITORS).map((c) => toSelected(c, category.category, source));
  const note =
    competitors.length >= MIN_COMPETITORS
      ? null
      : competitors.length === 0
        ? discovery.candidates.length === 0
          ? "No competitor candidates were found by search."
          : "No legitimate competitors could be identified from the search results."
        : "Only 1 legitimate competitor could be identified from the search results.";

  // Legitimate competitors beyond the first MAX_COMPETITORS, in the same order: used in place of a
  // selected competitor whose website can't be read (research.service.ts). Never anything else.
  const alternates = legit.slice(MAX_COMPETITORS).map((c) => toSelected(c, category.category, source));
  return { competitors, alternates, candidates: evaluated, note };
}
