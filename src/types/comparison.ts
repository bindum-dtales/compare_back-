import type { CompanyResearch } from "./company.js";

export interface ComparisonSetRow {
  id: string;
  name: string;
  company_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ComparisonSet {
  id: string;
  name: string;
  companyIds: string[];
  companies: CompanyResearch[];
  createdAt: string;
  updatedAt: string;
}
