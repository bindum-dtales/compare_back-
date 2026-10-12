// In-memory stand-ins for the Supabase repositories, so service/API tests run offline.
import { randomUUID } from "node:crypto";
import type { CompanyRow, NewCompany } from "../src/types/company.js";
import type { ResearchJobRow } from "../src/types/research.js";
import type { ComparisonSetRow } from "../src/types/comparison.js";

export const db = {
  companies: new Map<string, CompanyRow>(),
  jobs: new Map<string, ResearchJobRow>(),
  comparisons: new Map<string, ComparisonSetRow>(),
  reset() {
    this.companies.clear();
    this.jobs.clear();
    this.comparisons.clear();
  },
};

const now = () => new Date().toISOString();

export function makeCompany(c: NewCompany): CompanyRow {
  return {
    category: null, tagline: null, linkedin: null, researched_at: null,
    seo_score: null, aeo_score: null, geo_score: null,
    seo_data: {}, aeo_data: {}, geo_data: {},
    evidence: [], recommendations: [], hidden_assets: [], sources: [], website_data: null, discovery_data: null,
    created_at: now(), updated_at: now(),
    ...c,
  };
}

/**
 * A company researched by its own completed job (what makes a row canonical). Without the job the
 * row is like the old pipeline's competitor rows: researched_at set, but not a researched company.
 */
export function makeResearched(c: NewCompany & { researched_at: string }): CompanyRow {
  const row = makeCompany(c);
  db.companies.set(row.id, row);
  const at = Date.parse(c.researched_at);
  const job: ResearchJobRow = {
    id: randomUUID(), company_name: row.name, company_domain: row.domain, status: "completed", progress: 100, current_step: null, error: null, error_code: null,
    company_id: row.id, created_at: new Date(at - 120_000).toISOString(), started_at: new Date(at - 60_000).toISOString(), completed_at: new Date(at + 1_000).toISOString(),
  };
  db.jobs.set(job.id, job);
  return row;
}

export const companyRepo = {
  listCompanies: async () => [...db.companies.values()],
  findCompanyById: async (id: string) => db.companies.get(id) ?? null,
  findCompanyByDomain: async (d: string) => [...db.companies.values()].find((c) => c.domain === d) ?? null,
  findCompaniesByIds: async (ids: string[]) => ids.flatMap((id) => db.companies.get(id) ?? []),
  searchCompanies: async (q: string) =>
    [...db.companies.values()].filter((c) => `${c.name} ${c.domain ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  upsertCompany: async (c: NewCompany) => {
    const other = [...db.companies.values()].find((x) => x.domain === c.domain && x.id !== c.id);
    if (other) throw new Error(`unique violation: domain ${c.domain}`); // mirrors companies_domain_key
    // Like a PostgREST upsert: only the given columns change on an existing row.
    const row = makeCompany({ ...db.companies.get(c.id), ...c });
    db.companies.set(row.id, row);
    return row;
  },
};

export const researchRepo = {
  createJob: async (j: Pick<ResearchJobRow, "company_name" | "company_domain">) => {
    // Mirrors the partial unique index research_jobs_active_domain_key.
    if (await researchRepo.findActiveJobByDomain(j.company_domain)) return null;
    const row: ResearchJobRow = {
      id: randomUUID(), status: "queued", progress: 0, current_step: null, error: null, error_code: null,
      company_id: null, created_at: now(), started_at: null, completed_at: null, ...j,
    };
    db.jobs.set(row.id, row);
    return row;
  },
  findJobById: async (id: string) => db.jobs.get(id) ?? null,
  findActiveJobByDomain: async (domain: string) =>
    [...db.jobs.values()].find((j) => j.company_domain === domain && !["completed", "failed"].includes(j.status)) ?? null,
  updateJob: async (id: string, patch: Partial<ResearchJobRow>) => {
    const row = { ...db.jobs.get(id)!, ...patch };
    db.jobs.set(id, row);
    return row;
  },
  listQueuedJobIds: async (limit: number) =>
    [...db.jobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit).map((j) => j.id),
  // Check-and-set with no await in between, like the conditional UPDATE in the real repo.
  listCompletedJobWindows: async (companyIds: string[]) =>
    [...db.jobs.values()]
      .filter((j) => j.status === "completed" && j.company_id !== null && companyIds.includes(j.company_id))
      .map(({ company_id, started_at, completed_at }) => ({ company_id, started_at, completed_at })),
  claimJob: async (id: string) => {
    const job = db.jobs.get(id);
    if (job?.status !== "queued") return null;
    const row: ResearchJobRow = { ...job, status: "resolving", progress: 10, current_step: "Resolving company", started_at: now() };
    db.jobs.set(id, row);
    return row;
  },
  failStaleJobs: async (startedBefore: string, code: string, message: string, exceptIds: string[] = []) => {
    let n = 0;
    for (const j of db.jobs.values()) {
      if (["queued", "completed", "failed"].includes(j.status) || !j.started_at || j.started_at >= startedBefore || exceptIds.includes(j.id)) continue;
      db.jobs.set(j.id, { ...j, status: "failed", error_code: code, error: message, completed_at: now() });
      n++;
    }
    return n;
  },
};

export const comparisonRepo = {
  findComparisonById: async (id: string) => db.comparisons.get(id) ?? null,
  createComparison: async (s: Pick<ComparisonSetRow, "name" | "company_ids">) => {
    const row = { id: randomUUID(), created_at: now(), updated_at: now(), ...s };
    db.comparisons.set(row.id, row);
    return row;
  },
  updateComparison: async (id: string, patch: Partial<ComparisonSetRow>) => {
    const cur = db.comparisons.get(id);
    if (!cur) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const row = { ...cur, ...defined, updated_at: now() };
    db.comparisons.set(id, row);
    return row;
  },
  deleteComparison: async (id: string) => db.comparisons.delete(id),
};
