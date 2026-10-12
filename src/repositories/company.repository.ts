import { supabase } from "../supabase/client.js";
import { dbError } from "../utils/errors.js";
import type { CompanyRow, NewCompany } from "../types/company.js";

const TABLE = "companies";

/** Escapes LIKE wildcards so user input is matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listCompanies(): Promise<CompanyRow[]> {
  const { data, error } = await supabase.from(TABLE).select("*").order("name");
  if (error) throw dbError(error);
  return data;
}

export async function findCompanyById(id: string): Promise<CompanyRow | null> {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  return data;
}

export async function findCompaniesByIds(ids: string[]): Promise<CompanyRow[]> {
  const { data, error } = await supabase.from(TABLE).select("*").in("id", ids);
  if (error) throw dbError(error);
  return data;
}

export async function findCompanyByDomain(domain: string): Promise<CompanyRow | null> {
  const { data, error } = await supabase.from(TABLE).select("*").eq("domain", domain).maybeSingle();
  if (error) throw dbError(error);
  return data;
}

/** Case-insensitive substring match on name + domain. */
export async function searchCompanies(query: string, limit = 20): Promise<CompanyRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .ilike("search_text", `%${likeEscape(query.toLowerCase())}%`)
    .order("name")
    .limit(limit);
  if (error) throw dbError(error);
  return data;
}

export async function upsertCompany(company: NewCompany): Promise<CompanyRow> {
  const { data, error } = await supabase.from(TABLE).upsert(company).select("*").single();
  if (error) throw dbError(error);
  return data;
}
