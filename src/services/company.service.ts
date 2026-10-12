import * as repo from "../repositories/company.repository.js";
import * as jobs from "../repositories/research.repository.js";
import { notFound } from "../utils/errors.js";
import { PILLAR_METRICS, PILLARS, type CompanyComparison, type CompanyResearch, type CompanyRow, type Pillar, type PillarData } from "../types/company.js";
import type { CompetitorResult } from "../types/discovery.js";

const LOGO_COLORS = ["#111111", "#0F766E", "#B45309", "#1D4ED8", "#9D174D", "#4338CA"];

function logoFor(id: string, name: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { mark: name.trim()[0]?.toUpperCase() ?? "?", bg: LOGO_COLORS[h % LOGO_COLORS.length]!, fg: "#FFFFFF" };
}

/**
 * DB row → the `CompanyResearch` shape the dashboard renders. `researched`: the row is the company's
 * canonical research (canonicalIds); otherwise researchedAt is null, so it is never shown or
 * reused as a researched company.
 */
export function toCompanyResearch(row: CompanyRow, researched: boolean): CompanyResearch {
  const pillars = Object.fromEntries(
    PILLARS.map((pillar) => {
      const metrics = "metrics" in row[`${pillar}_data`] ? row[`${pillar}_data`].metrics : {};
      return [
        pillar,
        {
          pillar,
          score: row[`${pillar}_score`],
          // ponytail: deltas need run history; 0 until snapshots are kept.
          delta: 0,
          subMetrics: PILLAR_METRICS[pillar].map(({ key, label }) => ({
            key,
            label,
            score: metrics[key]?.score ?? null,
            delta: 0,
          })),
          evidence: row.evidence
            .filter((e) => e.pillar === pillar)
            .map((e, i) => ({ ...e, id: `${row.id}-${pillar}-ev-${i}` })),
        },
      ];
    }),
  ) as CompanyResearch["pillars"];

  return {
    company: {
      id: row.id,
      name: row.name,
      domain: row.domain,
      category: row.category ?? "",
      logo: logoFor(row.id, row.name),
      tagline: row.tagline,
      linkedin: row.linkedin,
      researchedAt: researched ? row.researched_at : null,
    },
    pillars,
    aiVisibility: [],
    hiddenAssets: row.hidden_assets.map((a, i) => ({ ...a, id: `${row.id}-ha-${i}`, companyId: row.id })),
    // Only a check whose raw-vs-rendered diff ran counts: without it (e.g. no JINA_API_KEY) "no findings" isn't a clean result.
    hiddenAssetsChecked: !!row.website_data?.hiddenAssetsCheck?.diff?.ran,
    sources: row.sources.map((s, i) => ({ ...s, id: `${row.id}-src-${i}`, companyId: row.id })),
    recommendations: row.recommendations.map((r, i) => ({ ...r, id: `${row.id}-rec-${i}` })),
    competitors: (row.discovery_data?.competitors ?? []).map(({ name, domain }) => ({ name, domain })),
  };
}

/**
 * Which of these rows hold the company's own canonical research: every pillar scored, and
 * researched_at written by a completed research job of that company (it falls between the job's
 * start and completion). Rows given researched_at any other way are not canonical: notably rows the
 * old pipeline wrote when it scored a company as someone else's competitor, which have no job of
 * their own. They stay in the table as raw data but are never presented or reused as researched.
 */
export async function canonicalIds(rows: (CompanyRow | null)[]): Promise<Set<string>> {
  const scored = rows.filter(
    (r): r is CompanyRow => !!r && r.researched_at !== null && r.seo_score !== null && r.aeo_score !== null && r.geo_score !== null,
  );
  const windows = await jobs.listCompletedJobWindows([...new Set(scored.map((r) => r.id))]);
  const t = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
  return new Set(
    scored
      .filter((r) => windows.some((w) => w.company_id === r.id && t(w.started_at) <= t(r.researched_at) && t(r.researched_at) <= t(w.completed_at)))
      .map((r) => r.id),
  );
}

/** One row's canonical status; see canonicalIds. */
export const isCanonical = async (row: CompanyRow | null): Promise<boolean> => !!row && (await canonicalIds([row])).has(row.id);

/** A row's sub-metric data (for benchmarking recommendations); null if it has none stored. */
export function canonicalPillars(row: CompanyRow): Record<Pillar, PillarData> | null {
  const has = (d: CompanyRow["seo_data"]): d is PillarData => "metrics" in d;
  const { seo_data: seo, aeo_data: aeo, geo_data: geo } = row;
  return has(seo) && has(aeo) && has(geo) ? { seo, aeo, geo } : null;
}

/**
 * A competitor's comparison-only result in the API shape. Never stored as a company: the in-memory
 * row exists only to reuse the mapping. Its id is scoped to the comparison (`<subject>--<domain>`),
 * so it can't be mistaken for (or opened as) a researched company.
 */
function comparisonResult(subjectId: string, r: CompetitorResult): CompanyResearch {
  const research = toCompanyResearch({
    id: `${subjectId}--${r.domain.replace(/[^a-z0-9]+/g, "-")}`,
    name: r.name,
    domain: r.domain,
    category: r.category,
    tagline: null,
    linkedin: r.linkedin,
    researched_at: r.scoredAt,
    seo_score: r.scores.seo,
    aeo_score: r.scores.aeo,
    geo_score: r.scores.geo,
    seo_data: r.pillars.seo,
    aeo_data: r.pillars.aeo,
    geo_data: r.pillars.geo,
    evidence: r.evidence,
    recommendations: [],
    hidden_assets: r.hiddenAssets,
    sources: r.sources,
    website_data: null,
    discovery_data: null,
    created_at: r.scoredAt,
    updated_at: r.scoredAt,
  }, true); // researchedAt = when it was scored for this comparison (basis "comparison")
  return { ...research, hiddenAssetsChecked: r.hiddenAssetsChecked ?? true };
}

/**
 * A researched company with its competitors, for the comparison view. The subject is its canonical
 * research (as GET /api/companies/:id). Each selected competitor, in selection order, is its own
 * canonical research when it has one, else the result scored for this comparison, else null (it
 * couldn't be scored; nothing is filled in).
 */
export async function getComparison(id: string): Promise<CompanyComparison> {
  const row = await repo.findCompanyById(id);
  if (!row) throw notFound("COMPANY_NOT_FOUND", "Company was not found.");
  const selected = row.discovery_data?.competitors ?? [];
  const stored = new Map((row.discovery_data?.competitorResults ?? []).map((r) => [r.domain, r]));
  const owns = await Promise.all(selected.map(({ domain }) => repo.findCompanyByDomain(domain)));
  const canonical = await canonicalIds([row, ...owns]);
  const competitors = selected.map(({ name, domain }, i): CompanyComparison["competitors"][number] => {
    const own = owns[i];
    if (own && own.id !== row.id && canonical.has(own.id)) return { name, domain, basis: "canonical", result: toCompanyResearch(own, true) };
    const scored = stored.get(domain);
    return scored ? { name, domain, basis: "comparison", result: comparisonResult(row.id, scored) } : { name, domain, basis: null, result: null };
  });
  return { subject: toCompanyResearch(row, canonical.has(row.id)), competitors };
}

export async function listCompanies(): Promise<CompanyResearch[]> {
  const rows = await repo.listCompanies();
  const canonical = await canonicalIds(rows);
  return rows.map((r) => toCompanyResearch(r, canonical.has(r.id)));
}

export async function getCompany(id: string): Promise<CompanyResearch> {
  const row = await repo.findCompanyById(id);
  if (!row) throw notFound("COMPANY_NOT_FOUND", "Company was not found.");
  return toCompanyResearch(row, await isCanonical(row));
}

export async function searchCompanies(query: string) {
  const found = await repo.searchCompanies(query);
  const canonical = await canonicalIds(found);
  const rows = found.filter((r) => canonical.has(r.id));
  return { results: rows.map((r) => toCompanyResearch(r, true)), researched: rows.length > 0 };
}

