// Category detection + competitor discovery (stored in companies.discovery_data).

import type { EvidenceItem, HiddenAssetItem, Pillar, PillarData, SourceItem } from "./company.js";
// Model output is stored as conclusions with short factual justifications only;
// no model reasoning is requested, received or stored.

export interface CategoryResult {
  /** e.g. "Digital Marketing Agency". Also written to companies.category. */
  category: string;
  subcategory: string | null;
  /** Model's 0–1 confidence that the website supports this category. */
  confidence: number;
  /** A short factual sentence citing the evidence. */
  rationale: string;
  /** 1–5 phrases from the website supporting the category; each verified to occur in the collected text. */
  evidence: string[];
  /** "<provider>:<model>". */
  model: string;
  detectedAt: string;
}

/** Deterministic, explainable signals computed from a search result. */
export interface CandidateSignals {
  /** Share of the category's key terms found in the result title + snippet, 0–1. */
  categoryRelevance: number;
  /** The result is the site's root page (a company homepage, not an article). */
  homepage: boolean;
  /** Title looks like a list/comparison/review article ("Top 10 …", "Best X in 2026", "… alternatives"). */
  listicle: boolean;
  /** URL path is content about products (/reviews/, /best-…, /blog/, /alternatives…), not a product page. Absent on older records. */
  editorialPage?: boolean;
  /** Reads as a gallery, showcase, directory, template collection or marketplace of other sites/products. Absent on older records. */
  directoryLike?: boolean;
  searchScore: number | null;
}

/** One company found in search results (deduplicated by normalized domain). */
export interface CompetitorCandidate {
  name: string;
  /** Normalized, see utils/domain.ts. */
  domain: string;
  /** The search result URL it came from. */
  url: string;
  title: string;
  snippet: string;
  /** Every query that surfaced this domain. */
  sourceQueries: string[];
  signals: CandidateSignals;
}

export type CandidateVerdict = "selected" | "accepted" | "rejected";

export interface EvaluatedCandidate extends CompetitorCandidate {
  /** selected = in the final 2–4; accepted = legitimate but ranked lower; rejected = not a competitor. */
  verdict: CandidateVerdict;
  /**
   * Who decided: deterministic rules (rejections only) or the LLM classifier (every accepted/selected
   * candidate). Records from before every candidate was classified can hold deterministic accepts.
   */
  method: "deterministic" | "llm";
  /** The LLM's classification of the domain's owner (method "llm" only; absent on older records). */
  classification?: "direct_competitor" | "review_or_editorial" | "directory_or_marketplace" | "not_a_competitor";
  confidence: number;
  /** One factual sentence. */
  reason: string;
  /**
   * Set when this legitimate competitor couldn't be researched (e.g. its website blocks the reader),
   * so it was left out of the comparison. A short internal reason; never a provider message.
   */
  unavailable?: string;
}

/** A search result dropped before evaluation (invalid URL, the target itself, a directory…). */
export interface RejectedResult {
  url: string;
  domain: string | null;
  reason: string;
  query: string;
}

export interface SearchRecord {
  query: string;
  provider: string;
  /** Null when the query failed. */
  resultCount: number | null;
}

export interface CompetitorDiscovery {
  searches: SearchRecord[];
  candidates: CompetitorCandidate[];
  rejected: RejectedResult[];
}

export interface SelectedCompetitor {
  name: string;
  domain: string;
  url: string;
  /** The target's detected category: the competitor was validated against it. */
  category: string;
  source: string;
  discoveryEvidence: {
    sourceQueries: string[];
    title: string;
    snippet: string;
    method: EvaluatedCandidate["method"];
    confidence: number;
    reason: string;
    signals: CandidateSignals;
  };
}

export interface CompetitorSelection {
  competitors: SelectedCompetitor[];
  /**
   * Further legitimate competitors (verdict "accepted"), best first: tried in place of a selected one
   * that can't be researched (its website blocks the reader, is down…). Same filtering as `competitors`.
   */
  alternates?: SelectedCompetitor[];
  candidates: EvaluatedCandidate[];
  /** Set when fewer than 2 competitors could be supported. */
  note: string | null;
}

/**
 * A competitor scored for one company's comparison, against that company's category. Lives only in
 * the researched company's discovery_data: it is never written to the competitor's own companies row,
 * so another company's comparison can't overwrite (or create) the competitor's canonical result.
 */
export interface CompetitorResult {
  name: string;
  /** Normalized. */
  domain: string;
  /** The researched company's category the competitor was scored against. */
  category: string;
  scoredAt: string;
  scores: Record<Pillar, number>;
  pillars: Record<Pillar, PillarData>;
  evidence: EvidenceItem[];
  hiddenAssets: HiddenAssetItem[];
  /**
   * False when the hidden-assets check couldn't be run for this competitor (its pages couldn't be read
   * again), or ran without its raw-vs-rendered diff (no JINA_API_KEY); an empty hiddenAssets is then
   * "not checked", not "nothing found".
   * Absent on results stored before this field existed (always checked then).
   */
  hiddenAssetsChecked?: boolean;
  sources: SourceItem[];
  linkedin: string | null;
}

export interface DiscoveryData {
  category: CategoryResult;
  /** Null until competitor discovery has finished for this record. */
  competitors: SelectedCompetitor[] | null;
  candidates: EvaluatedCandidate[];
  rejectedResults: RejectedResult[];
  searches: SearchRecord[];
  note: string | null;
  discoveredAt: string | null;
  /**
   * Comparison-specific scores for the selected competitors that had no canonical research of their
   * own when this company was researched. Competitors with a canonical result are read from their own
   * record instead (see company.service.ts getComparison). Absent on records researched before this
   * field existed.
   */
  competitorResults?: CompetitorResult[];
}
