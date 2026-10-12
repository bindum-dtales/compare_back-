export const JOB_STATUSES = [
  "queued",
  "resolving",
  "detecting_category",
  "finding_competitors",
  "researching",
  "scoring",
  "synthesizing",
  "completed",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ResearchJobRow {
  id: string;
  company_name: string;
  /** Normalized, see utils/domain.ts. */
  company_domain: string;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  /** User-safe failure message. */
  error: string | null;
  /** e.g. WEBSITE_RESEARCH_FAILED. */
  error_code: string | null;
  company_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ResearchJob {
  id: string;
  companyName: string;
  /** Normalized, see utils/domain.ts. */
  domain: string;
  status: JobStatus;
  progress: number;
  currentStep: string | null;
  /** Set when status is "failed". Safe to show to users. */
  error: { code: string; message: string } | null;
  companyId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
