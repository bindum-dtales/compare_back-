import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResearchWorker } from "../src/workers/research.worker.js";
import { getJob, startResearch, type ResearchSteps } from "../src/services/research.service.js";
import { JinaError } from "../src/services/jina.service.js";
import { db, researchRepo } from "./fake-db.js";
import type { WebsiteResearch } from "../src/types/website.js";
import { CATEGORY } from "./discovery-fixtures.js";

const website = (domain: string) => ({ source: "jina-reader", url: `https://${domain}/`, title: "Acme" }) as WebsiteResearch;

const steps = (overrides: Partial<ResearchSteps> = {}): ResearchSteps => ({
  resolveCompany: async ({ companyName, domain }) => ({ name: companyName, domain }),
  researchWebsite: async ({ domain }) => website(domain),
  detectCategory: async () => CATEGORY,
  discoverCompetitors: async () => ({ searches: [], candidates: [], rejected: [] }),
  selectCompetitors: async () => ({ competitors: [], candidates: [], note: "No competitor candidates were found by search." }),
  ...overrides,
});

const queue = async (companyName = "Acme", domain = "acme.com") =>
  ((await startResearch({ companyName, domain })) as { job: { id: string } }).job.id;

/** Records every (status, progress) the job passes through, starting with the claim. */
function trackProgress() {
  const seen: string[] = [];
  const { updateJob, claimJob } = researchRepo;
  vi.spyOn(researchRepo, "claimJob").mockImplementation(async (id) => {
    const row = await claimJob(id);
    if (row) seen.push(`${row.status} ${row.progress}`);
    return row;
  });
  vi.spyOn(researchRepo, "updateJob").mockImplementation(async (id, patch) => {
    if (patch.status) seen.push(`${patch.status} ${patch.progress ?? ""}`.trim());
    return updateJob(id, patch);
  });
  return seen;
}

beforeEach(() => db.reset());
afterEach(() => vi.restoreAllMocks());

describe("research worker", () => {
  it("does nothing when the queue is empty", async () => {
    expect(await createResearchWorker({ steps: steps() }).processNext()).toBe(false);
  });

  it("claims a queued job, runs every stage asynchronously, stores the research and completes", async () => {
    const id = await queue();
    const seen = trackProgress();

    expect(await createResearchWorker({ steps: steps() }).processNext()).toBe(true);

    expect(seen).toEqual([
      "resolving 10",
      "researching 20",
      "researching 30",
      "detecting_category 40",
      "finding_competitors 55",
      "finding_competitors 70",
      "finding_competitors 80",
      "completed 100",
    ]);
    expect(db.jobs.get(id)).toMatchObject({
      status: "completed",
      progress: 100,
      current_step: null,
      company_id: "acme",
      error: null,
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    expect(db.companies.get("acme")).toMatchObject({
      domain: "acme.com",
      website_data: { url: "https://acme.com/", title: "Acme" },
      category: "Content Marketing Agency",
      discovery_data: { category: CATEGORY, competitors: [] },
      researched_at: null, // not "researched" until scoring exists
    });
  });

  it("processes the oldest queued job first", async () => {
    const first = await queue("First", "first.com");
    await queue("Second", "second.com");
    await createResearchWorker({ steps: steps() }).processNext();
    expect(db.jobs.get(first)?.status).toBe("completed");
    expect([...db.jobs.values()].filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("marks a job failed with a safe error when the website can't be researched", async () => {
    const id = await queue();
    const secretish = "Jina HTTP 422: Domain 'acme.com' could not be resolved at /srv/app/node_modules/x.js";
    const worker = createResearchWorker({
      steps: steps({ researchWebsite: async () => Promise.reject(new JinaError("target_unreachable", secretish, 422)) }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await worker.processNext()).toBe(true); // the failure doesn't escape the worker

    expect(db.jobs.get(id)).toMatchObject({
      status: "failed",
      error_code: "WEBSITE_RESEARCH_FAILED",
      error: "Unable to research the supplied website. The website could not be reached. Check the domain and try again.",
      completed_at: expect.any(String),
    });
    expect((await getJob(id)).error).toEqual({ code: "WEBSITE_RESEARCH_FAILED", message: expect.stringMatching(/^Unable to research the supplied website\./) });
    expect(JSON.stringify(db.jobs.get(id))).not.toMatch(/srv|node_modules|Jina HTTP/);
    expect(db.companies.size).toBe(0);
  });

  it("hides unexpected internal errors behind the stage's generic message", async () => {
    const id = await queue();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await createResearchWorker({
      steps: steps({ researchWebsite: async () => Promise.reject(new Error("connect ECONNREFUSED key=sk-123 /etc/x")) }),
    }).processNext();
    expect(db.jobs.get(id)).toMatchObject({
      status: "failed",
      error_code: "WEBSITE_RESEARCH_FAILED",
      error: "Unable to research the supplied website.",
    });
  });

  it("never runs the same job twice, even with two workers racing", async () => {
    await queue();
    const researchWebsite = vi.fn(async ({ domain }: { domain: string }) => website(domain));
    const a = createResearchWorker({ steps: steps({ researchWebsite }) });
    const b = createResearchWorker({ steps: steps({ researchWebsite }) });

    const results = await Promise.all([a.processNext(), b.processNext()]);

    expect(results.sort()).toEqual([false, true]);
    expect(researchWebsite).toHaveBeenCalledTimes(1);
  });

  it("can't claim a job that is already running or finished", async () => {
    const id = await queue();
    expect(await researchRepo.claimJob(id)).not.toBeNull();
    expect(await researchRepo.claimJob(id)).toBeNull(); // running
    await createResearchWorker({ steps: steps() }).processNext(); // nothing queued left
    expect(db.jobs.get(id)?.status).toBe("resolving");
  });

  it("fails stale in-flight jobs so the domain can be researched again", async () => {
    const stale = await queue("Stale", "stale.com");
    const fresh = await queue("Fresh", "fresh.com");
    const waiting = await queue("Waiting", "waiting.com");
    await researchRepo.claimJob(stale);
    await researchRepo.claimJob(fresh);
    db.jobs.set(stale, { ...db.jobs.get(stale)!, started_at: new Date(Date.now() - 20 * 60_000).toISOString() });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createResearchWorker({ steps: steps() }).sweepStale()).toBe(1);

    expect(db.jobs.get(stale)).toMatchObject({ status: "failed", error_code: "RESEARCH_INTERRUPTED" });
    expect(db.jobs.get(fresh)?.status).toBe("resolving");
    expect(db.jobs.get(waiting)?.status).toBe("queued");
    expect(await startResearch({ companyName: "Stale", domain: "stale.com" })).toMatchObject({ status: "queued" });
  });

  it("never sweeps the job it is running, however long it takes (e.g. waiting out an LLM rate limit)", async () => {
    const id = await queue("Slow", "slow.com");
    let release!: () => void;
    const worker = createResearchWorker({
      steps: steps({
        detectCategory: async () => {
          await new Promise<void>((r) => (release = r)); // still running when the sweep comes
          return CATEGORY;
        },
      }),
    });
    const running = worker.processNext();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    db.jobs.set(id, { ...db.jobs.get(id)!, started_at: new Date(Date.now() - 20 * 60_000).toISOString() });

    expect(await worker.sweepStale()).toBe(0);
    expect(db.jobs.get(id)?.status).not.toBe("failed");
    release();
    await running;
    expect(db.jobs.get(id)?.status).toBe("completed");
  });

  it("start() drains the queue in the background; wake() picks up new jobs", async () => {
    const worker = createResearchWorker({ steps: steps(), pollIntervalMs: 60_000 });
    const first = await queue("First", "first.com");
    worker.start();
    await vi.waitFor(() => expect(db.jobs.get(first)?.status).toBe("completed"));

    const second = await queue("Second", "second.com");
    worker.wake();
    await vi.waitFor(() => expect(db.jobs.get(second)?.status).toBe("completed"));
    worker.stop();
  });
});
