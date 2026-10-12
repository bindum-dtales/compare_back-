import { supabase } from "../supabase/client.js";
import { dbError } from "../utils/errors.js";
import type { ComparisonSetRow } from "../types/comparison.js";

const TABLE = "comparison_sets";

export async function findComparisonById(id: string): Promise<ComparisonSetRow | null> {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  return data;
}

export async function createComparison(set: Pick<ComparisonSetRow, "name" | "company_ids">): Promise<ComparisonSetRow> {
  const { data, error } = await supabase.from(TABLE).insert(set).select("*").single();
  if (error) throw dbError(error);
  return data;
}

export async function updateComparison(
  id: string,
  patch: Partial<Pick<ComparisonSetRow, "name" | "company_ids">>,
): Promise<ComparisonSetRow | null> {
  const { data, error } = await supabase.from(TABLE).update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw dbError(error);
  return data;
}

/** Returns false when nothing matched. */
export async function deleteComparison(id: string): Promise<boolean> {
  const { data, error } = await supabase.from(TABLE).delete().eq("id", id).select("id");
  if (error) throw dbError(error);
  return data.length > 0;
}
