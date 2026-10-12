// Research jobs: the API creates a queued job and returns immediately; the worker
// (research.worker.ts) claims it and runs `researchCompany(jobId)`, which walks the
// pipeline and reports progress on the job row for the frontend to poll.
//
//   resolve → website (Jina → companies.website_data)
//   → category (LLM over website facts) → competitor discovery (search) → selection (rules + LLM)
//     → companies.category + companies.discovery_data
//   → scoring of the target: collect signals → score (rubric, deterministic) → save scores
//     → evidence (LLM wording, verified) → hidden assets (spec §7) → save
//   → each selected competitor: its own canonical research if it has one (read, never re-scored),
//     else scored the same way (its site researched first) into the target's comparison data
//     (discovery_data.competitorResults), never into the competitor's own row
//   → recommendations for the target, benchmarked against its competitors → save, researched_at set
//
// Only the researched company's own row is ever written: a company's canonical result comes only
// from researching that company.
//
// Each external step is a method on `ResearchSteps`.

import * as companies from "../repositories/company.repository.js";
import * as jobs from "../repositories/research.repository.js";
import { canonicalPillars, isCanonical, toCompanyResearch } from "./company.service.js";
import { calculateCompanyScores } from "../utils/scoring.js";
import { slugify } from "../utils/slug.js";
import { normalizeDomain } from "../utils/domain.js";
import type { ResearchRequest } from "../utils/validation.js";
import { ApiError, notFound } from "../utils/errors.js";
import { fetchWebsite, JinaError } from "./jina.service.js";
import { analyzeWebsite } from "./website-analysis.js";
import { detectCategory } from "./category.service.js";
import { collectCategoryPages } from "./category-pages.js";
import { discoverCompetitors, MIN_COMPETITORS, selectCompetitors } from "./competitor.service.js";
import { stage, StageError, toJobError } from "./job-errors.js";
import { createScoringSteps } from "./scoring/scoring.service.js";
import type { HiddenAssetsCheck, WebsiteResearch } from "../types/website.js";
import type { BenchmarkCompany } from "./recommendations.js";
import type { CategoryResult, CompetitorDiscovery, CompetitorResult, CompetitorSelection, DiscoveryData, SelectedCompetitor } from "../types/discovery.js";
import type {
  CompanyResearch,
  CompanyRow,
  EvidenceItem,
  NewCompany,
  HiddenAssetItem,
  Pillar,
  PillarData,
  RecommendationItem,
  SourceItem,
} from "../types/company.js";
import type { JobStatus, ResearchJob, ResearchJobRow } from "../types/research.js";

/** What every job hands the pipeline. The domain is user-supplied and authoritative. */
export interface ResearchInput {
  jobId: string;
  companyName: string;
  /** Normalized, see utils/domain.ts. */
  domain: string;
}

export interface ResolvedCompany {
  name: string;
  /** Normalized; for the target this is always the user-supplied domain. */
  domain: string;
  tagline?: string;
}

export interface CollectedSignals {
  pillars: Record<Pillar, PillarData>;
  sources: SourceItem[];
  linkedin?: string;
}

/** The pluggable research engine. Every method may call external APIs. */
export interface ResearchSteps {
  /** Confirm/enrich the target. Must not change the domain. */
  resolveCompany(input: ResearchInput): Promise<ResolvedCompany>;
  /** Fetch and analyze the company's own site. Receives the job's normalized domain. */
  researchWebsite(company: ResolvedCompany): Promise<WebsiteResearch>;
  detectCategory(company: ResolvedCompany, website: WebsiteResearch): Promise<CategoryResult>;
  /** Search for candidates. Must never return the target's own domain. */
  discoverCompetitors(company: ResolvedCompany, category: CategoryResult): Promise<CompetitorDiscovery>;
  /** 0–4 legitimate competitors; fewer than 2 is reported, never padded. */
  selectCompetitors(
    company: ResolvedCompany,
    website: WebsiteResearch,
    category: CategoryResult,
    discovery: CompetitorDiscovery,
  ): Promise<CompetitorSelection>;
  /** A fresh scorer per job (scoring/scoring.service.ts). Absent: the job completes after competitor selection. */
  scoring?: () => ScoringSteps;
}

export interface ScoringContext {
  /** The company's own website facts (the target's from this job, a competitor's fetched for scoring). */
  website: WebsiteResearch;
  /** The target's category: competitors are scored against the same one. */
  category: CategoryResult;
}

export interface ScoringSteps {
  collectSignals(company: ResolvedCompany, context: ScoringContext): Promise<CollectedSignals>;
  generateEvidence(company: ResolvedCompany, signals: CollectedSignals): Promise<EvidenceItem[]>;
  /** Spec §7: crawler-visible, human-invisible content on the company's site. */
  detectHiddenAssets?(company: ResolvedCompany, context: { website: WebsiteResearch }): Promise<{ assets: HiddenAssetItem[]; check: HiddenAssetsCheck }>;
  /** From the company's weak checks, benchmarked against the other scored companies in the set. */
  generateRecommendations?(company: ResolvedCompany, signals: CollectedSignals, others: BenchmarkCompany[]): Promise<RecommendationItem[]>;
}

/** The engine as implemented so far: website → category → competitors → scoring. Providers come from env. */
export const defaultSteps: ResearchSteps = {
  // Nothing to look up yet: the user supplied both name and domain. Enrichment comes later.
  resolveCompany: async ({ companyName, domain }) => ({ name: companyName, domain }),
  researchWebsite: async ({ domain }) => analyzeWebsite(await fetchWebsite({ domain })),
  // Reads a few more pages of the site only when the homepage is too thin to ground a category on.
  detectCategory: async ({ name, domain }, website) =>
    detectCategory({ companyName: name, domain, website, pages: await collectCategoryPages(name, domain, website) }),
  // A fresh search session per call, i.e. per job: no query is sent twice within a job.
  discoverCompetitors: async ({ name, domain }, category) => discoverCompetitors({ name, domain }, category),
  selectCompetitors: async ({ name, domain }, website, category, discovery) =>
    selectCompetitors({ target: { name, domain }, targetDescription: website.description, category, discovery }),
  scoring: () => createScoringSteps(),
};

export { toJobError } from "./job-errors.js";

// --- API-facing ---------------------------------------------------------------

export function toResearchJob(row: ResearchJobRow): ResearchJob {
  return {
    id: row.id,
    companyName: row.company_name,
    domain: row.company_domain,
    status: row.status,
    progress: row.progress,
    currentStep: row.current_step,
    error: row.error ? { code: row.error_code ?? "RESEARCH_FAILED", message: row.error } : null,
    companyId: row.company_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export type StartResearchResult =
  | { status: "existing"; company: CompanyResearch }
  | { status: "queued" | "in_progress"; job: ResearchJob };

/**
 * `input.domain` must already be normalized (startResearchSchema does this).
 * Identity is the domain, not the name: "DTales" at a different domain is a different company.
 */
export async function startResearch(input: Omit<ResearchRequest, "force"> & { force?: boolean }): Promise<StartResearchResult> {
  if (!slugify(input.companyName)) throw new ApiError(400, "VALIDATION_ERROR", "Company name must contain letters or digits.");

  // force: a re-run of a researched company starts a new job; its last result stays until the new one completes.
  if (!input.force) {
    const existing = await companies.findCompanyByDomain(input.domain);
    if (existing && (await isCanonical(existing))) return { status: "existing", company: toCompanyResearch(existing, true) };
  }

  // One active job per domain (also for force: a second click re-joins the running job).
  const active = await jobs.findActiveJobByDomain(input.domain);
  if (active) return { status: "in_progress", job: toResearchJob(active) };

  const job = await jobs.createJob({ company_name: input.companyName, company_domain: input.domain });
  if (!job) {
    // A concurrent request created it between our lookup and insert.
    const winner = await jobs.findActiveJobByDomain(input.domain);
    if (winner) return { status: "in_progress", job: toResearchJob(winner) };
    throw new ApiError(409, "JOB_CONFLICT", "A research job for this domain changed state; please retry.");
  }
  // The worker picks it up (research.worker.ts); the controller nudges it to start now.
  return { status: "queued", job: toResearchJob(job) };
}

/** The columns a pipeline run writes (everything but the id, timestamps and generated columns). */
function storedFields(row: CompanyRow): NewCompany {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    category: row.category,
    tagline: row.tagline,
    linkedin: row.linkedin,
    researched_at: row.researched_at,
    seo_score: row.seo_score,
    aeo_score: row.aeo_score,
    geo_score: row.geo_score,
    seo_data: row.seo_data,
    aeo_data: row.aeo_data,
    geo_data: row.geo_data,
    evidence: row.evidence,
    recommendations: row.recommendations,
    hidden_assets: row.hidden_assets,
    sources: row.sources,
    website_data: row.website_data,
    discovery_data: row.discovery_data,
  };
}

/**
 * A run writes each stage's output to the researched company's row as it goes. When the row held a
 * completed result before the run and the run can't complete it, the previous result is written back,
 * so a failed re-run never leaves new scores mixed with old evidence and recommendations (or with
 * the previous comparison's competitor results). Returns true when something was restored.
 */
async function restorePrevious(previous: CompanyRow | null): Promise<boolean> {
  if (!previous || !(await isCanonical(previous))) return false;
  await companies.upsertCompany(storedFields(previous));
  return true;
}

/**
 * Stable readable id for a domain: reuse the existing record's id, else the name slug,
 * else (slug taken by another domain) name + domain slug.
 */
export async function companyIdFor(name: string, domain: string): Promise<string> {
  const byDomain = await companies.findCompanyByDomain(domain);
  if (byDomain) return byDomain.id;
  const slug = slugify(name) || slugify(domain);
  const clash = await companies.findCompanyById(slug);
  return clash ? slugify(`${name} ${domain}`) : slug;
}

export async function getJob(id: string): Promise<ResearchJob> {
  const row = await jobs.findJobById(id);
  if (!row) throw notFound("JOB_NOT_FOUND", "Research job was not found.");
  return toResearchJob(row);
}

// --- Worker-facing ------------------------------------------------------------

async function report(jobId: string, status: JobStatus, progress: number, currentStep: string) {
  await jobs.updateJob(jobId, { status, progress, current_step: currentStep });
}

interface Scored {
  company: ResolvedCompany;
  signals: CollectedSignals;
  scores: Record<Pillar, number>;
  evidence: EvidenceItem[];
  hiddenAssets: HiddenAssetItem[];
  /** False when the hidden-assets check failed (competitors only) or its rendered diff didn't run: not a clean result. */
  hiddenAssetsChecked: boolean;
}

type CompanyPatch = Omit<NewCompany, "id" | "name" | "domain">;

/**
 * Score one company, word its evidence and check it for hidden assets. `save` persists each stage
 * as it completes; it's given for the researched company (its own row) and omitted for a competitor,
 * whose results go into the researched company's comparison data instead and never into the
 * competitor's own row. `website` is given for the researched company (fetched earlier in the job)
 * and fetched here for a competitor. `from`/`span` is this company's slice of the progress bar.
 */
async function scoreOne(
  steps: ResearchSteps,
  scoring: ScoringSteps,
  jobId: string,
  company: ResolvedCompany,
  context: { category: CategoryResult; website?: WebsiteResearch },
  from: number,
  span: number,
  save: (patch: CompanyPatch) => Promise<unknown> = async () => {},
  /** Competitors: a failed hidden-assets check is recorded as "not checked" instead of discarding the scores. */
  hiddenAssetsOptional = false,
): Promise<Scored> {
  const domain = normalizeDomain(company.domain);
  if (!domain) throw new Error(`Invalid domain for ${company.name}: ${company.domain}`);
  const target = { ...company, domain };
  const at = (fraction: number) => Math.round(from + span * fraction);

  const fetchWebsite = async () => {
    await report(jobId, "researching", at(0), `Fetching ${domain}`);
    return stage("SCORING_FAILED", () => steps.researchWebsite(target));
  };
  const website = context.website ?? (await fetchWebsite());

  await report(jobId, "researching", at(0.2), `Collecting signals for ${target.name}`);
  const signals = await stage("SCORING_FAILED", () => scoring.collectSignals(target, { website, category: context.category }));

  await report(jobId, "scoring", at(0.6), `Scoring ${target.name}`);
  const scores = await stage("SCORING_FAILED", async () => calculateCompanyScores(signals.pillars));
  await save({
    seo_score: scores.seo,
    aeo_score: scores.aeo,
    geo_score: scores.geo,
    seo_data: signals.pillars.seo,
    aeo_data: signals.pillars.aeo,
    geo_data: signals.pillars.geo,
    sources: signals.sources,
    linkedin: signals.linkedin ?? null,
  });

  await report(jobId, "synthesizing", at(0.7), `Generating evidence for ${target.name}`);
  const evidence = await stage("EVIDENCE_GENERATION_FAILED", () => scoring.generateEvidence(target, signals));
  await save({ evidence });

  let hiddenAssets: HiddenAssetItem[] = [];
  let hiddenAssetsChecked = false;
  if (scoring.detectHiddenAssets) {
    await report(jobId, "synthesizing", at(0.85), `Checking hidden assets for ${target.name}`);
    try {
      const { assets, check } = await stage("HIDDEN_ASSETS_FAILED", () => scoring.detectHiddenAssets!(target, { website }));
      hiddenAssets = assets;
      // Without the rendered diff (no JINA_API_KEY, or the render failed) "no findings" isn't a clean result.
      hiddenAssetsChecked = check.diff.ran;
      await save({ hidden_assets: assets, website_data: { ...website, hiddenAssetsCheck: check } });
    } catch (err) {
      if (!hiddenAssetsOptional) throw err;
      console.warn(`[research] job ${jobId}: hidden-assets check skipped for ${domain}:`, describe(err));
    }
  }
  return { company: target, signals, scores, evidence, hiddenAssets, hiddenAssetsChecked };
}

const describe = (err: unknown) => {
  const cause = err instanceof StageError ? err.cause : err;
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
};

/** Why a legitimate competitor was left out, for the stored candidate record. Never a provider message. */
const UNAVAILABLE = {
  insufficient_balance: "Not researched: the website reader (Jina) has no API balance.",
  blocked: "Not researched: its website refused the website reader.",
  timeout: "Not researched: its website took too long to load.",
  unreachable: "Not researched: its website could not be reached.",
  other: "Not researched: it could not be scored.",
} as const;

function unavailableReason(cause: unknown): string {
  if (!(cause instanceof JinaError)) return UNAVAILABLE.other;
  if (cause.kind === "insufficient_balance") return UNAVAILABLE.insufficient_balance;
  if (cause.kind === "target_http_error") return UNAVAILABLE.blocked;
  if (cause.kind === "timeout") return UNAVAILABLE.timeout;
  if (cause.kind === "target_unreachable" || cause.kind === "network") return UNAVAILABLE.unreachable;
  return UNAVAILABLE.other;
}

const unavailableNote = (included: number, failed: number) =>
  included === 0
    ? `No competitor could be researched: ${failed} competitor website${failed === 1 ? "" : "s"} could not be read.`
    : `Only 1 competitor could be researched: ${failed} competitor website${failed === 1 ? "" : "s"} could not be read.`;

const toCompetitorResult = (s: Scored, category: string): CompetitorResult => ({
  name: s.company.name,
  domain: s.company.domain,
  category,
  scoredAt: new Date().toISOString(),
  scores: s.scores,
  pillars: s.signals.pillars,
  evidence: s.evidence,
  hiddenAssets: s.hiddenAssets,
  hiddenAssetsChecked: s.hiddenAssetsChecked,
  sources: s.signals.sources,
  linkedin: s.signals.linkedin ?? null,
});

/**
 * Runs a claimed job (see research.worker.ts). Never called inside a request.
 * Progress: resolving 10 → researching 20–30 → detecting_category 40 → finding_competitors 55–80
 * → per company researching / scoring / synthesizing 85–99 → completed 100.
 *
 * Only the researched company's own row is written. Each selected competitor is either read from
 * its own canonical research (when it has a completed result) or scored for this comparison into
 * discovery_data.competitorResults. The target must score for the job to complete; a competitor
 * that can't be scored is left out (logged), never replaced.
 */
export async function researchCompany(jobId: string, steps: ResearchSteps = defaultSteps): Promise<void> {
  const job = await jobs.findJobById(jobId);
  if (!job) throw notFound("JOB_NOT_FOUND", "Research job was not found.");
  if (job.status === "completed" || job.status === "failed") return; // already finished; never re-run

  // The researched company's row before this run wrote to it (see restorePrevious).
  let previous: CompanyRow | null = null;
  try {
    // The worker's claim already moved the job to "resolving"; do it here for a direct call.
    if (job.status === "queued") {
      await jobs.updateJob(jobId, { status: "resolving", progress: 10, current_step: "Resolving company", started_at: new Date().toISOString() });
    }
    const resolved = await steps.resolveCompany({ jobId, companyName: job.company_name, domain: job.company_domain });
    // Never let a step swap the user-supplied target domain.
    const target = { ...resolved, domain: job.company_domain };
    const companyId = await companyIdFor(target.name, target.domain);
    previous = await companies.findCompanyById(companyId);
    const save = (patch: CompanyPatch) => companies.upsertCompany({ id: companyId, name: target.name, domain: target.domain, ...patch });

    await report(jobId, "researching", 20, `Fetching ${target.domain}`);
    const website = await stage("WEBSITE_RESEARCH_FAILED", () => steps.researchWebsite(target));
    await save({ website_data: website });
    await report(jobId, "researching", 30, "Website research saved");

    await report(jobId, "detecting_category", 40, "Detecting category");
    const category = await stage("CATEGORY_DETECTION_FAILED", () => steps.detectCategory(target, website));
    let discoveryData: DiscoveryData = {
      category,
      competitors: null,
      candidates: [],
      rejectedResults: [],
      searches: [],
      note: null,
      discoveredAt: null,
    };
    await save({ category: category.category, discovery_data: discoveryData });

    await report(jobId, "finding_competitors", 55, "Searching for competitors");
    const discovery = await stage("COMPETITOR_SEARCH_FAILED", () => steps.discoverCompetitors(target, category));

    await report(jobId, "finding_competitors", 70, "Selecting competitors");
    const selection = await stage("COMPETITOR_SELECTION_FAILED", () => steps.selectCompetitors(target, website, category, discovery));

    await report(jobId, "finding_competitors", 80, "Saving competitors");
    discoveryData = {
      ...discoveryData,
      competitors: selection.competitors,
      candidates: selection.candidates,
      rejectedResults: discovery.rejected.slice(0, MAX_STORED_REJECTS),
      searches: discovery.searches,
      note: selection.note,
      discoveredAt: new Date().toISOString(),
      competitorResults: [],
    };
    await save({ discovery_data: discoveryData });

    if (steps.scoring) {
      const scoring = steps.scoring();
      const span = 14 / (1 + selection.competitors.length); // companies share 85–99%
      const own = await scoreOne(steps, scoring, jobId, target, { category, website }, 85, span, save);

      // The benchmark for the target's recommendations: every competitor with scores in this comparison.
      const benchmark: BenchmarkCompany[] = [];
      // Selected competitors first; a further legitimate one (same filtering) takes the place of any
      // that can't be researched. Never more than were selected, never anything that wasn't accepted.
      const wanted = selection.competitors.length;
      const queue = [...selection.competitors, ...(selection.alternates ?? [])];
      const included: SelectedCompetitor[] = [];
      const unavailable = new Map<string, string>();
      let readerUnavailable = false; // Jina reported no balance: no further site can be read this job
      for (const c of queue) {
        if (included.length >= wanted) break;
        const domain = normalizeDomain(c.domain);
        if (!domain) continue;
        const from = Math.min(98, 85 + span * (included.length + 1));
        const canonical = await companies.findCompanyByDomain(domain);
        if (canonical && canonical.id !== companyId && (await isCanonical(canonical))) {
          // Its own research is the canonical result: compare against it, don't re-score over it.
          await report(jobId, "researching", Math.round(from), `Using ${canonical.name}'s own research`);
          const pillars = canonicalPillars(canonical);
          if (pillars) benchmark.push({ name: canonical.name, domain, pillars });
          included.push(c);
          continue;
        }
        if (readerUnavailable) {
          unavailable.set(domain, UNAVAILABLE.insufficient_balance);
          continue;
        }
        try {
          const scored = await scoreOne(steps, scoring, jobId, { name: c.name, domain }, { category }, from, span, undefined, true);
          const result = toCompetitorResult(scored, category.category);
          discoveryData = { ...discoveryData, competitorResults: [...(discoveryData.competitorResults ?? []), result] };
          await save({ discovery_data: discoveryData });
          benchmark.push({ name: result.name, domain, pillars: result.pillars });
          included.push(c);
        } catch (err) {
          const cause = err instanceof StageError ? err.cause : err;
          console.warn(`[research] job ${jobId}: competitor ${domain} not scored:`, describe(err));
          unavailable.set(domain, unavailableReason(cause));
          if (cause instanceof JinaError && cause.kind === "insufficient_balance") readerUnavailable = true;
        }
      }

      // The comparison lists the competitors it actually has; the others stay recorded as candidates.
      if (included.length !== wanted || unavailable.size) {
        const inComparison = new Set(included.map((c) => normalizeDomain(c.domain)));
        discoveryData = {
          ...discoveryData,
          competitors: included,
          candidates: discoveryData.candidates.map((c) => ({
            ...c,
            verdict: inComparison.has(c.domain) ? "selected" : c.verdict === "selected" ? "accepted" : c.verdict,
            ...(unavailable.has(c.domain) ? { unavailable: unavailable.get(c.domain) } : {}),
          })),
          note: included.length >= MIN_COMPETITORS ? discoveryData.note : unavailableNote(included.length, unavailable.size),
        };
        await save({ discovery_data: discoveryData });
      }

      // Recommendations for the researched company, benchmarked against its competitors; then its record is complete.
      if (scoring.generateRecommendations) await report(jobId, "synthesizing", 99, "Generating recommendations");
      const recommendations = scoring.generateRecommendations
        ? await stage("RECOMMENDATIONS_FAILED", () => scoring.generateRecommendations!(own.company, own.signals, benchmark))
        : undefined;
      await save({ ...(recommendations ? { recommendations } : {}), researched_at: new Date().toISOString() });
    }

    await jobs.updateJob(jobId, {
      status: "completed",
      progress: 100,
      current_step: null,
      company_id: companyId,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    const cause = err instanceof StageError ? err.cause : err;
    // A re-run that fails keeps the company's last completed result rather than a half-written one.
    const kept = await restorePrevious(previous).catch((e) => {
      console.error(`[research] job ${jobId}: could not restore the previous result:`, e instanceof Error ? e.message : e);
      return false;
    });
    const { code, message } = toJobError(err, { keptPrevious: kept });
    console.error(`[research] job ${jobId} failed:`, code, cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
    await jobs.updateJob(jobId, { status: "failed", error_code: code, error: message, completed_at: new Date().toISOString() });
    throw cause;
  }
}

/** Search results dropped before evaluation, kept for auditing; capped so the row stays small. */
const MAX_STORED_REJECTS = 50;
