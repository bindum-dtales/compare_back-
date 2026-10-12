import * as repo from "../repositories/comparison.repository.js";
import { findCompaniesByIds } from "../repositories/company.repository.js";
import { canonicalIds, toCompanyResearch } from "./company.service.js";
import { ApiError, notFound } from "../utils/errors.js";
import type { ComparisonSet, ComparisonSetRow } from "../types/comparison.js";

const NOT_FOUND = () => notFound("COMPARISON_NOT_FOUND", "Comparison was not found.");

async function hydrate(row: ComparisonSetRow): Promise<ComparisonSet> {
  const rows = await findCompaniesByIds(row.company_ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const canonical = await canonicalIds(rows);
  return {
    id: row.id,
    name: row.name,
    companyIds: row.company_ids,
    // Keep the saved order (subject first); skip companies deleted since.
    companies: row.company_ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [toCompanyResearch(r, canonical.has(r.id))] : [];
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertCompaniesExist(ids: string[]) {
  const found = new Set((await findCompaniesByIds(ids)).map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ApiError(400, "UNKNOWN_COMPANY", `Unknown company id(s): ${missing.join(", ")}`);
}

const dedupe = (ids: string[]) => [...new Set(ids)];

export async function getComparison(id: string) {
  const row = await repo.findComparisonById(id);
  if (!row) throw NOT_FOUND();
  return hydrate(row);
}

export async function createComparison(input: { name: string; companyIds: string[] }) {
  const ids = dedupe(input.companyIds);
  await assertCompaniesExist(ids);
  return hydrate(await repo.createComparison({ name: input.name, company_ids: ids }));
}

export async function updateComparison(id: string, input: { name?: string; companyIds?: string[] }) {
  const ids = input.companyIds && dedupe(input.companyIds);
  if (ids) await assertCompaniesExist(ids);
  const row = await repo.updateComparison(id, { name: input.name, company_ids: ids });
  if (!row) throw NOT_FOUND();
  return hydrate(row);
}

export async function deleteComparison(id: string) {
  if (!(await repo.deleteComparison(id))) throw NOT_FOUND();
}
