// Read-only snapshot of every company row (for before/after diffing). Writes nothing to the DB.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { listCompanies } from "./src/repositories/company.repository.js";
import { canonicalIds } from "./src/services/company.service.js";
import { supabase } from "./src/supabase/client.js";

const out = process.argv[2]!;
const rows = await listCompanies();
const canon = await canonicalIds(rows);
const hash = (r: unknown) => createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16);
const carrd = rows.find((r) => r.domain === "carrd.co");
const { data: carrdJobs } = await supabase.from("research_jobs").select("id,status,error_code,error,created_at,started_at,completed_at").eq("company_domain", "carrd.co").order("created_at", { ascending: false }).limit(5);
const dd = carrd?.discovery_data;
const snap = {
  takenAt: new Date().toISOString(),
  companyCount: rows.length,
  companies: rows.map((r) => ({ id: r.id, domain: r.domain, canonical: canon.has(r.id), researched_at: r.researched_at, updated_at: r.updated_at, scores: [r.seo_score, r.aeo_score, r.geo_score], hash: hash(r) })),
  carrd: carrd && {
    id: carrd.id, researched_at: carrd.researched_at, updated_at: carrd.updated_at, canonical: canon.has(carrd.id),
    category: carrd.category, scores: [carrd.seo_score, carrd.aeo_score, carrd.geo_score],
    hiddenAssets: carrd.hidden_assets.length, hiddenAssetsCheck: carrd.website_data?.hiddenAssetsCheck ?? null,
    competitors: dd?.competitors ?? null,
    competitorResults: (dd?.competitorResults ?? []).map((c) => ({ domain: c.domain, scores: c.scores, hiddenAssetsChecked: c.hiddenAssetsChecked ?? null, hiddenAssets: c.hiddenAssets.length })),
    candidates: (dd?.candidates ?? []).map((c) => ({ domain: c.domain, verdict: c.verdict, method: c.method, classification: (c as { classification?: string }).classification ?? null, unavailable: c.unavailable ?? null })),
    note: dd?.note ?? null, discoveredAt: dd?.discoveredAt ?? null,
  },
  carrdJobs,
};
writeFileSync(out, JSON.stringify(snap, null, 2));
console.log(JSON.stringify({ companyCount: snap.companyCount, carrd: snap.carrd && { ...snap.carrd, candidates: snap.carrd.candidates.length }, carrdJobs }, null, 1));
