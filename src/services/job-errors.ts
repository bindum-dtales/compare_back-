// User-safe job errors. Each pipeline stage runs inside `stage(code, fn)`; a failure becomes
// { code, message } with fixed wording chosen from the error's `kind`. Upstream messages,
// keys, stack traces and paths never reach the job row — they're logged server-side only.

import { ApiError, StepFailure } from "../utils/errors.js";

export interface JobError {
  code: string;
  message: string;
}

export type StageCode =
  | "WEBSITE_RESEARCH_FAILED"
  | "CATEGORY_DETECTION_FAILED"
  | "COMPETITOR_SEARCH_FAILED"
  | "COMPETITOR_SELECTION_FAILED"
  | "SCORING_FAILED"
  | "EVIDENCE_GENERATION_FAILED"
  | "HIDDEN_ASSETS_FAILED"
  | "RECOMMENDATIONS_FAILED";

/** A failure tagged with the stage it happened in. `cause` is the original error. */
export class StageError extends Error {
  constructor(
    public readonly code: StageCode,
    public readonly cause: unknown,
  ) {
    super(`${code}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StageError";
  }
}

export async function stage<T>(code: StageCode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof StageError ? e : new StageError(code, e);
  }
}

type Reason = string | ((err: StepFailure) => string);

const AI_REASONS: Record<string, Reason> = {
  not_configured: "The AI service is not configured on the server.",
  rate_limited: "The AI service is busy. Please try again in a minute.",
  timeout: "The AI service took too long to respond.",
};

const JINA_NO_BALANCE =
  "The website reader (Jina) API balance is insufficient. Recharge or restore JINA_API_KEY before website research and the hidden-assets comparison can run.";

const UNCLEAR_CATEGORY = "The website content doesn't clearly indicate what market the company is in.";

const STAGES: Record<StageCode, { summary: string; reasons: Record<string, Reason> }> = {
  WEBSITE_RESEARCH_FAILED: {
    summary: "Unable to research the supplied website.",
    reasons: {
      timeout: "The website took too long to respond.",
      rate_limited: "The website reader is busy. Please try again in a minute.",
      target_unreachable: "The website could not be reached. Check the domain and try again.",
      target_http_error: (e) => `The website responded with HTTP ${e.status}.`,
      insufficient_balance: JINA_NO_BALANCE,
    },
  },
  CATEGORY_DETECTION_FAILED: {
    summary: "Unable to determine the company's category.",
    reasons: {
      ...AI_REASONS,
      insufficient_evidence: "The website doesn't have enough readable content.",
      low_confidence: UNCLEAR_CATEGORY,
      unsupported: UNCLEAR_CATEGORY,
      too_broad: UNCLEAR_CATEGORY,
    },
  },
  COMPETITOR_SEARCH_FAILED: {
    summary: "Unable to search for competitors.",
    reasons: {
      not_configured: "Competitor search is not configured on the server.",
      rate_limited: "The search service is busy. Please try again in a minute.",
      quota_exceeded: "The search service usage limit has been reached.",
      timeout: "The search service took too long to respond.",
    },
  },
  COMPETITOR_SELECTION_FAILED: {
    summary: "Unable to evaluate competitor candidates.",
    reasons: AI_REASONS,
  },
  SCORING_FAILED: {
    summary: "Unable to score the company.",
    reasons: {
      not_configured: "Web search is not configured on the server.",
      rate_limited: "A research service is busy. Please try again in a minute.",
      quota_exceeded: "The search service usage limit has been reached.",
      timeout: "A research service took too long to respond.",
      target_unreachable: "The website could not be reached.",
      target_http_error: (e) => `The website responded with HTTP ${e.status}.`,
    },
  },
  EVIDENCE_GENERATION_FAILED: {
    summary: "Scores were saved, but the evidence summary could not be generated.",
    reasons: AI_REASONS,
  },
  HIDDEN_ASSETS_FAILED: {
    summary: "Scores were saved, but the hidden-assets check could not be completed.",
    reasons: {
      timeout: "The website took too long to respond.",
      rate_limited: "The website reader is busy. Please try again in a minute.",
      target_unreachable: "The website could not be reached.",
      target_http_error: (e) => `The website responded with HTTP ${e.status}.`,
      insufficient_balance: JINA_NO_BALANCE,
    },
  },
  RECOMMENDATIONS_FAILED: {
    summary: "Scores were saved, but recommendations could not be generated.",
    reasons: AI_REASONS,
  },
};

/** Replaces a stage's summary when a re-run failed and the company's previous result was restored. */
const KEPT_PREVIOUS = "The research could not be refreshed, so the previous results were kept.";

/** `keptPrevious`: the failed run was a re-run and the last completed result was restored. */
export function toJobError(err: unknown, opts: { keptPrevious?: boolean } = {}): JobError {
  if (err instanceof StageError) {
    const { summary, reasons } = STAGES[err.code];
    const reason = err.cause instanceof StepFailure ? reasons[err.cause.kind] : undefined;
    const text = typeof reason === "function" ? reason(err.cause as StepFailure) : reason;
    const lead = opts.keptPrevious ? KEPT_PREVIOUS : summary;
    return { code: err.code, message: text ? `${lead} ${text}` : lead };
  }
  if (opts.keptPrevious && !(err instanceof ApiError && err.status < 500)) {
    return { code: "RESEARCH_FAILED", message: `${KEPT_PREVIOUS} Please try again.` };
  }
  if (err instanceof ApiError && err.status < 500) return { code: err.code, message: err.message };
  return { code: "RESEARCH_FAILED", message: "Research failed due to an internal error. Please try again." };
}
