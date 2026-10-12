// In-process research worker: polls research_jobs for queued work, claims one job at a
// time atomically (see claimJob), and runs it. No queue infrastructure; the table is the queue.
//
// - Several server instances can run workers safely: a job is only run by whoever claims it.
// - One job at a time per process; Jina's keyless limit is ~20 req/min and each job makes 2.
// - POST /api/research calls wakeResearchWorker() so new jobs start without waiting a poll.
// - Jobs left mid-flight by a crashed process are failed after STALE_AFTER_MS so their
//   domain can be researched again. The job this worker is running is never swept: a healthy job
//   can outlast the cutoff while it waits out an LLM rate limit.

import * as jobs from "../repositories/research.repository.js";
import { defaultSteps, researchCompany, type ResearchSteps } from "../services/research.service.js";

export interface WorkerOptions {
  steps?: ResearchSteps;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

const STALE_SWEEP_MS = 60_000;

export function createResearchWorker({ steps = defaultSteps, pollIntervalMs = 5_000, staleAfterMs = 15 * 60_000 }: WorkerOptions = {}) {
  let busy = false;
  /** The job this worker is running right now. */
  let current: string | null = null;
  let stopped = true;
  let pollTimer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;

  /** Claims and runs the oldest available queued job. False when there was nothing to claim. */
  async function processNext(): Promise<boolean> {
    for (const id of await jobs.listQueuedJobIds(5)) {
      if (!(await jobs.claimJob(id))) continue; // another worker got it first
      current = id;
      try {
        await researchCompany(id, steps);
      } catch {
        // Already recorded on the job (status failed + safe error) and logged by researchCompany.
      } finally {
        current = null;
      }
      return true;
    }
    return false;
  }

  async function sweepStale(): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const n = await jobs.failStaleJobs(cutoff, "RESEARCH_INTERRUPTED", "Research was interrupted. Please try again.", current ? [current] : []);
    if (n) console.warn(`[worker] failed ${n} stale research job(s)`);
    return n;
  }

  /** Drain the queue, then sleep until the next poll or wake(). */
  async function run() {
    if (busy || stopped) return;
    busy = true;
    clearTimeout(pollTimer);
    try {
      while (!stopped && (await processNext()));
    } catch (e) {
      console.error("[worker] poll failed:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
      if (!stopped) pollTimer = setTimeout(run, pollIntervalMs);
    }
  }

  return {
    processNext,
    sweepStale,
    start() {
      if (!stopped) return;
      stopped = false;
      const sweep = () => sweepStale().catch((e) => console.error("[worker] stale sweep failed:", e instanceof Error ? e.message : e));
      void sweep().finally(run);
      sweepTimer = setInterval(sweep, STALE_SWEEP_MS);
    },
    /** Stops polling. A job already running finishes on its own. */
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(sweepTimer);
    },
    /** Start polling now instead of at the next interval (no-op while busy). */
    wake() {
      void run();
    },
  };
}

export type ResearchWorker = ReturnType<typeof createResearchWorker>;

let active: ResearchWorker | null = null;

export function startResearchWorker(opts?: WorkerOptions): ResearchWorker {
  active?.stop();
  active = createResearchWorker(opts);
  active.start();
  return active;
}

/** Called after a job is queued. No-op when no worker runs in this process (e.g. tests). */
export const wakeResearchWorker = () => active?.wake();
