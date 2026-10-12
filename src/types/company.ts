import type { WebsiteResearch } from "./website.js";
import type { DiscoveryData } from "./discovery.js";

// Company record shapes. Metric keys and nested shapes mirror front/lib/types.ts
// and front/lib/pillars.ts so API responses drop into the dashboard unchanged.

export type Pillar = "seo" | "aeo" | "geo";
export const PILLARS: readonly Pillar[] = ["seo", "aeo", "geo"];

export const PILLAR_METRICS = {
  seo: [
    { key: "technical", label: "Technical" },
    { key: "content", label: "Content" },
    { key: "backlinks", label: "Backlinks" },
    { key: "ranking", label: "Ranking" },
  ],
  aeo: [
    { key: "structured", label: "Structured" },
    { key: "directAnswer", label: "Direct Answer" },
    { key: "snippet", label: "Snippet" },
    { key: "crawlability", label: "Crawlability" },
  ],
  geo: [
    { key: "thirdParty", label: "3rd-party Presence" },
    { key: "brandScale", label: "Brand Scale" },
    { key: "freshness", label: "Freshness" },
    { key: "clarity", label: "Brand Clarity" },
  ],
} as const satisfies Record<Pillar, readonly { key: string; label: string }[]>;

export interface MetricData {
  /** 0–100 */
  score: number;
  /** Raw collector output backing the score (crawl results, counts, URLs…). */
  signals?: Record<string, unknown>;
}

/** Stored in seo_data / aeo_data / geo_data. */
export interface PillarData {
  metrics: Record<string, MetricData>;
}

export interface EvidenceItem {
  pillar: Pillar;
  metricKey: string;
  text: string;
  sentiment: "positive" | "neutral" | "negative";
  /** The scoring checks (MetricData.signals.checks[].id) this finding is based on. */
  checkIds?: string[];
}

export interface RecommendationItem {
  impact: "high" | "medium" | "low";
  pillar: Pillar;
  title: string;
  explanation: string;
  metric: string;
  current: number;
  target: number;
  action: string;
  /** The weak scoring checks (MetricData.signals.checks[].id) this recommendation addresses. */
  checkIds?: string[];
}

export interface HiddenAssetItem {
  url: string;
  foundIn: string;
  issue: string;
  kind: "hidden-content" | "orphan-page" | "staging-leak" | "noindex-conflict";
  severity: "high" | "medium" | "low";
}

export type SourceType =
  | "Company website"
  | "LinkedIn"
  | "G2"
  | "Clutch"
  | "Search result"
  | "Industry publication"
  | "AI answer";

export interface SourceItem {
  title: string;
  domain: string;
  url: string;
  type: SourceType;
  pillar: Pillar;
}

/** One row of the companies table. */
export interface CompanyRow {
  id: string;
  name: string;
  /** Normalized primary domain, see utils/domain.ts. */
  domain: string;
  category: string | null;
  tagline: string | null;
  linkedin: string | null;
  researched_at: string | null;
  seo_score: number | null;
  aeo_score: number | null;
  geo_score: number | null;
  seo_data: PillarData | Record<string, never>;
  aeo_data: PillarData | Record<string, never>;
  geo_data: PillarData | Record<string, never>;
  evidence: EvidenceItem[];
  recommendations: RecommendationItem[];
  hidden_assets: HiddenAssetItem[];
  sources: SourceItem[];
  /** Raw facts from the company's own site; null until fetched. */
  website_data: WebsiteResearch | null;
  /** Category detail + competitor discovery; null until category detection has run. */
  discovery_data: DiscoveryData | null;
  created_at: string;
  updated_at: string;
}

export type NewCompany = Pick<CompanyRow, "id" | "name" | "domain"> &
  Partial<Omit<CompanyRow, "id" | "name" | "domain" | "created_at" | "updated_at">>;

// --- API response shape (front/lib/types.ts `CompanyResearch` + spec §3 extras) ---

export interface CompanyResearch {
  company: {
    id: string;
    name: string;
    domain: string;
    category: string;
    logo: { mark: string; bg: string; fg: string };
    tagline: string | null;
    linkedin: string | null;
    researchedAt: string | null;
  };
  pillars: Record<
    Pillar,
    {
      pillar: Pillar;
      score: number | null;
      delta: number;
      subMetrics: { key: string; label: string; score: number | null; delta: number }[];
      evidence: (EvidenceItem & { id: string })[];
    }
  >;
  aiVisibility: { engine: string; mentionRate: number; citations: number }[];
  hiddenAssets: (HiddenAssetItem & { id: string; companyId: string })[];
  /** Whether the full hidden-assets check (incl. the raw-vs-rendered diff) ran: when false, an empty hiddenAssets means "not checked", not "none found". */
  hiddenAssetsChecked: boolean;
  sources: (SourceItem & { id: string; companyId: string })[];
  recommendations: (RecommendationItem & { id: string })[];
  /** The competitors selected for this company when it was researched (empty until discovery ran). */
  competitors: { name: string; domain: string }[];
}

/** GET /api/companies/:id/comparison. */
export interface CompanyComparison {
  /** The company's canonical research (same as GET /api/companies/:id). */
  subject: CompanyResearch;
  /** The competitors selected when the subject was researched, in selection order. */
  competitors: {
    name: string;
    domain: string;
    /**
     * canonical: the competitor's own research. comparison: scored only for this comparison, against
     * the subject's category (never the competitor's canonical result). null: not scored.
     */
    basis: "canonical" | "comparison" | null;
    result: CompanyResearch | null;
  }[];
}
