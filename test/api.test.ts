import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { db, makeCompany, makeResearched } from "./fake-db.js";

/** Researched by its own completed job (seeded too), so it is a canonical result. */
const researched = (id: string, name: string, domain: string) =>
  makeResearched({
      id, name, domain, category: "Digital agency", researched_at: "2026-09-28T00:00:00Z",
      seo_score: 76.25, aeo_score: 71.25, geo_score: 68,
      seo_data: { metrics: { technical: { score: 84 }, content: { score: 76 }, backlinks: { score: 64 }, ranking: { score: 81 } } },
      evidence: [{ pillar: "seo", metricKey: "technical", text: "Fast homepage.", sentiment: "positive" }],
      hidden_assets: [{ url: `${domain}/x`, foundIn: "Homepage HTML", issue: "Hidden", kind: "hidden-content", severity: "high" }],
  });

/** Jobs created by the requests under test (the seeded companies' completed jobs aside). */
const newJobs = () => [...db.jobs.values()].filter((j) => j.status !== "completed").length;

beforeEach(() => {
  db.reset();
  researched("dtales-tech", "DTales Tech", "dtales.tech");
  researched("webflow", "Webflow", "webflow.com");
});

describe("legacy rows: researched_at without a completed research job of their own", () => {
  // As the old pipeline left them: scored as someone else's competitor, researched_at set, no job.
  const legacy = (id: string, name: string, domain: string, researchedAt = "2026-10-08T07:28:52Z") =>
    db.companies.set(id, makeCompany({ id, name, domain, category: "Website Builder Platform", researched_at: researchedAt, seo_score: 20, aeo_score: 87, geo_score: 33.25 }));
  beforeEach(() => {
    legacy("website-builders-cybernews-com", "website-builders.cybernews.com", "website-builders.cybernews.com");
    legacy("squarespace", "Squarespace", "squarespace.com");
  });

  it("are listed only as unresearched raw data (researchedAt null), so the Library never shows them", async () => {
    const res = await request(app).get("/api/companies").expect(200);
    const byDomain = Object.fromEntries(res.body.data.map((c: { company: { domain: string; researchedAt: string | null } }) => [c.company.domain, c.company.researchedAt]));
    expect(byDomain).toEqual({
      "dtales.tech": "2026-09-28T00:00:00Z",
      "webflow.com": "2026-09-28T00:00:00Z",
      "website-builders.cybernews.com": null,
      "squarespace.com": null,
    });
    const one = await request(app).get("/api/companies/squarespace").expect(200);
    expect(one.body.data.company.researchedAt).toBeNull();
  });

  it("aren't found by search and aren't returned as an existing result: researching one runs a real job", async () => {
    expect((await request(app).post("/api/companies/search").send({ query: "squarespace" }).expect(200)).body.data).toEqual({ results: [], researched: false });
    const res = await request(app).post("/api/research").send({ companyName: "Squarespace", domain: "squarespace.com" }).expect(202);
    expect(res.body.data.status).toBe("queued");
  });

  it("a row whose researched_at wasn't written by any of its own completed jobs isn't canonical either", async () => {
    // Webflow's own job finished; something later rewrote researched_at (the old competitor scoring did).
    db.companies.set("webflow", { ...db.companies.get("webflow")!, researched_at: "2026-10-08T07:28:48Z" });
    expect((await request(app).get("/api/companies/webflow").expect(200)).body.data.company.researchedAt).toBeNull();
  });

  it("a comparison never presents a legacy competitor row as that competitor's own research", async () => {
    const subject = db.companies.get("dtales-tech")!;
    db.companies.set("dtales-tech", {
      ...subject,
      discovery_data: {
        category: { category: "Digital agency", subcategory: null, confidence: 0.9, rationale: "r", evidence: ["e"], model: "m", detectedAt: "2026-09-28T00:00:00Z" },
        competitors: [{ name: "Squarespace", domain: "squarespace.com" }, { name: "Cybernews", domain: "website-builders.cybernews.com" }] as never,
        candidates: [], rejectedResults: [], searches: [], note: null, discoveredAt: "2026-09-28T00:00:00Z",
      },
    });
    const res = await request(app).get("/api/companies/dtales-tech/comparison").expect(200);
    expect(res.body.data.competitors).toEqual([
      { name: "Squarespace", domain: "squarespace.com", basis: null, result: null },
      { name: "Cybernews", domain: "website-builders.cybernews.com", basis: null, result: null },
    ]);
  });
});

describe("health", () => {
  it("GET /health", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("unknown routes return the error envelope", async () => {
    const res = await request(app).get("/nope").expect(404);
    expect(res.body).toEqual({ success: false, error: { code: "ROUTE_NOT_FOUND", message: expect.any(String) } });
  });

  it("malformed JSON is a 400, not a stack trace", async () => {
    const res = await request(app).post("/api/research").set("Content-Type", "application/json").send("{bad").expect(400);
    expect(res.body.error.code).toBe("MALFORMED_JSON");
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });

  it("CORS allows only FRONTEND_URL", async () => {
    const ok = await request(app).get("/health").set("Origin", "http://localhost:3000");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const bad = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("companies", () => {
  it("lists companies in the frontend CompanyResearch shape", async () => {
    const res = await request(app).get("/api/companies").expect(200);
    expect(res.body.data).toHaveLength(2);
    const c = res.body.data.find((x: { company: { id: string } }) => x.company.id === "dtales-tech");
    expect(c.company).toMatchObject({ name: "DTales Tech", domain: "dtales.tech", logo: { mark: "D" } });
    expect(c.pillars.seo.score).toBe(76.25);
    expect(c.pillars.seo.subMetrics.map((m: { key: string }) => m.key)).toEqual(["technical", "content", "backlinks", "ranking"]);
    expect(c.pillars.seo.evidence[0]).toMatchObject({ metricKey: "technical", id: expect.any(String) });
    expect(c.pillars.aeo.subMetrics[0]).toEqual({ key: "structured", label: "Structured", score: null, delta: 0 });
    expect(c.hiddenAssets[0]).toMatchObject({ companyId: "dtales-tech", id: expect.any(String) });
    expect(c.hiddenAssetsChecked).toBe(false); // no check recorded for this row: its findings aren't presented as a clean result

    const withCheck = (ran: boolean) => {
      const website = { source: "jina-reader", url: "https://dtales.tech/", hiddenAssetsCheck: { pages: [], diff: { ran, reason: ran ? null : "r", blocksCompared: ran ? 3 : null }, checkedAt: "2026-09-28T00:00:00Z" } };
      db.companies.set("dtales-tech", { ...db.companies.get("dtales-tech")!, website_data: website as never });
    };
    // Regex checks only (no JINA_API_KEY: the rendered diff didn't run): "not checked", never "no issues".
    withCheck(false);
    expect((await request(app).get("/api/companies/dtales-tech")).body.data.hiddenAssetsChecked).toBe(false);
    withCheck(true);
    expect((await request(app).get("/api/companies/dtales-tech")).body.data.hiddenAssetsChecked).toBe(true);
  });

  it("exposes the competitors selected during research (name + domain only), [] before discovery", async () => {
    const row = db.companies.get("dtales-tech")!;
    const competitor = { name: "Webflow", domain: "webflow.com", url: "https://webflow.com/", category: "X", source: "tavily", discoveryEvidence: { reason: "internal" } };
    db.companies.set("dtales-tech", { ...row, discovery_data: { competitors: [competitor] } as unknown as typeof row.discovery_data });
    const res = await request(app).get("/api/companies/dtales-tech").expect(200);
    expect(res.body.data.competitors).toEqual([{ name: "Webflow", domain: "webflow.com" }]);
    const other = await request(app).get("/api/companies/webflow").expect(200);
    expect(other.body.data.competitors).toEqual([]);
  });

  it("GET /api/companies/:id", async () => {
    await request(app).get("/api/companies/webflow").expect(200);
    const missing = await request(app).get("/api/companies/unknown").expect(404);
    expect(missing.body.error.code).toBe("COMPANY_NOT_FOUND");
    await request(app).get("/api/companies/Bad%20Id").expect(400);
  });

  describe("GET /api/companies/:id/comparison", () => {
    const SCORES = { seo: 50, aeo: 60, geo: 70 };
    const pillars = { seo: { metrics: { technical: { score: 50 } } }, aeo: { metrics: { structured: { score: 60 } } }, geo: { metrics: { clarity: { score: 70 } } } };
    beforeEach(() => {
      const subject = db.companies.get("dtales-tech")!;
      db.companies.set("dtales-tech", {
        ...subject,
        discovery_data: {
          category: { category: "Digital agency", subcategory: null, confidence: 0.9, rationale: "r", evidence: ["e"], model: "m", detectedAt: "2026-09-28T00:00:00Z" },
          competitors: [
            { name: "Webflow", domain: "webflow.com" },
            { name: "Rival", domain: "rival.io" },
            { name: "Missing", domain: "missing.io" },
          ] as never,
          candidates: [],
          rejectedResults: [],
          searches: [],
          note: null,
          discoveredAt: "2026-09-28T00:00:00Z",
          competitorResults: [
            { name: "Rival", domain: "rival.io", category: "Digital agency", scoredAt: "2026-09-28T00:00:00Z", scores: SCORES, pillars, evidence: [{ pillar: "seo", metricKey: "technical", text: "Observed.", sentiment: "neutral" }], hiddenAssets: [], sources: [], linkedin: null },
            // A comparison result for a competitor that has its own research is ignored in favour of that research.
            { name: "Webflow", domain: "webflow.com", category: "Digital agency", scoredAt: "2026-09-28T00:00:00Z", scores: { seo: 1, aeo: 1, geo: 1 }, pillars, evidence: [], hiddenAssets: [], sources: [], linkedin: null },
          ],
        },
      });
    });

    it("returns the subject's canonical result and each competitor with where its scores come from", async () => {
      const res = await request(app).get("/api/companies/dtales-tech/comparison").expect(200);
      const { subject, competitors } = res.body.data;
      expect(subject).toEqual((await request(app).get("/api/companies/dtales-tech")).body.data); // the canonical result, unchanged
      expect(competitors.map((c: { domain: string; basis: string | null }) => [c.domain, c.basis])).toEqual([
        ["webflow.com", "canonical"],
        ["rival.io", "comparison"],
        ["missing.io", null],
      ]);
      expect(competitors[0].result.company).toMatchObject({ id: "webflow", researchedAt: "2026-09-28T00:00:00Z" });
      expect(competitors[0].result.pillars.seo.score).toBe(76.25); // its own research, not the comparison's 1
      expect(competitors[1].result).toMatchObject({
        company: { id: "dtales-tech--rival-io", name: "Rival", domain: "rival.io", category: "Digital agency" },
        pillars: { seo: { score: 50, evidence: [{ id: expect.any(String), text: "Observed." }] }, aeo: { score: 60 }, geo: { score: 70 } },
        recommendations: [],
        competitors: [],
      });
      expect(competitors[2].result).toBeNull();
    });

    it("comparison-only competitors are not companies: not listed, not found by id", async () => {
      const list = await request(app).get("/api/companies").expect(200);
      expect(list.body.data.map((c: { company: { domain: string } }) => c.company.domain).sort()).toEqual(["dtales.tech", "webflow.com"]);
      await request(app).get("/api/companies/dtales-tech--rival-io").expect(400); // not even a valid company id
      await request(app).get("/api/companies/rival-io").expect(404);
    });

    it("handles a company researched before competitor results were stored, and unknown or invalid ids", async () => {
      const res = await request(app).get("/api/companies/webflow/comparison").expect(200);
      expect(res.body.data.competitors).toEqual([]);
      expect((await request(app).get("/api/companies/nope/comparison").expect(404)).body.error.code).toBe("COMPANY_NOT_FOUND");
      await request(app).get("/api/companies/Not%20An%20Id/comparison").expect(400);
    });
  });

  it("search finds researched companies by name or domain", async () => {
    const byName = await request(app).post("/api/companies/search").send({ query: "dtales" }).expect(200);
    expect(byName.body.data.researched).toBe(true);
    expect(byName.body.data.results[0].company.id).toBe("dtales-tech");

    const byDomain = await request(app).post("/api/companies/search").send({ query: "webflow.com" }).expect(200);
    expect(byDomain.body.data.results).toHaveLength(1);

    const none = await request(app).post("/api/companies/search").send({ query: "Acme" }).expect(200);
    expect(none.body.data).toEqual({ results: [], researched: false });
  });

  it("search ignores companies that exist but are not researched yet", async () => {
    db.companies.set("acme", makeCompany({ id: "acme", name: "Acme", domain: "acme.com" }));
    const res = await request(app).post("/api/companies/search").send({ query: "acme" }).expect(200);
    expect(res.body.data.researched).toBe(false);
  });

  it("search rejects empty queries", async () => {
    const res = await request(app).post("/api/companies/search").send({ query: " " }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("research", () => {
  const post = (body: unknown) => request(app).post("/api/research").send(body as object);

  it("returns the existing company when its domain is already researched", async () => {
    const res = await post({ companyName: "DTales Tech", domain: "https://www.dtales.tech/" }).expect(200);
    expect(res.body.data.status).toBe("existing");
    expect(res.body.data.company.company).toMatchObject({ id: "dtales-tech", domain: "dtales.tech" });
    expect(newJobs()).toBe(0);
  });

  it("matches on domain, not name", async () => {
    // Same name as a researched company, different site → a new job, not the existing record.
    const res = await post({ companyName: "DTales Tech", domain: "https://dtales-learning.com" }).expect(202);
    expect(res.body.data.job.domain).toBe("dtales-learning.com");
  });

  it("queues a job with the normalized domain and returns immediately", async () => {
    const res = await post({ companyName: "  Acme Corp ", domain: "https://WWW.Acme.com/about?x=1" }).expect(202);
    expect(res.body.data.status).toBe("queued");
    expect(res.body.data.job).toMatchObject({ companyName: "Acme Corp", domain: "acme.com", status: "queued", progress: 0 });

    const status = await request(app).get(`/api/research/${res.body.data.job.id}`).expect(200);
    expect(status.body.data).toMatchObject({ status: "queued", domain: "acme.com" });
  });

  it("equivalent URLs reuse the one running job", async () => {
    const first = await post({ companyName: "Acme Corp", domain: "https://acme.com" }).expect(202);
    for (const domain of ["https://acme.com/", "http://acme.com", "https://www.acme.com", "acme.com", "HTTPS://ACME.COM:443/pricing"]) {
      const again = await post({ companyName: "Acme", domain }).expect(202);
      expect(again.body.data.status).toBe("in_progress");
      expect(again.body.data.job.id).toBe(first.body.data.job.id);
    }
    expect(newJobs()).toBe(1);
  });

  it("a finished job no longer blocks a new one", async () => {
    const first = await post({ companyName: "Acme", domain: "https://acme.com" }).expect(202);
    db.jobs.set(first.body.data.job.id, { ...db.jobs.get(first.body.data.job.id)!, status: "failed" });
    const retry = await post({ companyName: "Acme", domain: "https://acme.com" }).expect(202);
    expect(retry.body.data.status).toBe("queued");
    expect(retry.body.data.job.id).not.toBe(first.body.data.job.id);
  });

  it.each([
    ["empty name", { companyName: "", domain: "https://dtales.tech" }],
    ["name with no letters/digits", { companyName: "!!!", domain: "https://dtales.tech" }],
    ["empty domain", { companyName: "DTales Tech", domain: "" }],
    ["non-URL domain", { companyName: "DTales Tech", domain: "not-a-url" }],
    ["missing domain", { companyName: "DTales Tech" }],
    ["non-http scheme", { companyName: "DTales Tech", domain: "ftp://dtales.tech" }],
    ["localhost", { companyName: "DTales Tech", domain: "http://localhost:3000" }],
    ["IP address", { companyName: "DTales Tech", domain: "http://127.0.0.1" }],
  ])("rejects %s", async (_label, body) => {
    const res = await post(body).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(newJobs()).toBe(0);
  });

  describe("force: re-run research for a company that already has a result", () => {
    it("force=true queues a new job instead of returning the existing result", async () => {
      const res = await post({ companyName: "DTales Tech", domain: "https://dtales.tech", force: true }).expect(202);
      expect(res.body.data).toMatchObject({ status: "queued", job: { domain: "dtales.tech", status: "queued", progress: 0 } });
      expect(newJobs()).toBe(1);
      // The last completed result stays readable while the re-run is queued.
      const company = await request(app).get("/api/companies/dtales-tech").expect(200);
      expect(company.body.data.company.researchedAt).toBe("2026-09-28T00:00:00Z");
    });

    it("force=false (or no force) keeps returning the existing result", async () => {
      for (const body of [{ force: false }, {}]) {
        const res = await post({ companyName: "DTales Tech", domain: "dtales.tech", ...body }).expect(200);
        expect(res.body.data.status).toBe("existing");
      }
      expect(newJobs()).toBe(0);
    });

    it("a second force request while the re-run is running re-joins it", async () => {
      const first = await post({ companyName: "DTales Tech", domain: "dtales.tech", force: true }).expect(202);
      const again = await post({ companyName: "DTales Tech", domain: "https://www.dtales.tech/", force: true }).expect(202);
      expect(again.body.data).toMatchObject({ status: "in_progress", job: { id: first.body.data.job.id } });
      expect(newJobs()).toBe(1);
    });

    it("rejects a non-boolean force", async () => {
      const res = await post({ companyName: "DTales Tech", domain: "dtales.tech", force: "true" }).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(newJobs()).toBe(0);
    });
  });

  it("validates job ids", async () => {
    await request(app).get("/api/research/not-a-uuid").expect(400);
    const res = await request(app).get("/api/research/3f0b5c1e-8a7d-4c2b-9e1f-0a1b2c3d4e5f").expect(404);
    expect(res.body.error.code).toBe("JOB_NOT_FOUND");
  });
});

describe("comparisons", () => {
  it("create → get → update → delete", async () => {
    const created = await request(app)
      .post("/api/comparisons")
      .send({ name: "Agency set", companyIds: ["dtales-tech", "webflow", "webflow"] })
      .expect(201);
    const id = created.body.data.id;
    expect(created.body.data.companyIds).toEqual(["dtales-tech", "webflow"]);
    expect(created.body.data.companies.map((c: { company: { id: string } }) => c.company.id)).toEqual(["dtales-tech", "webflow"]);

    await request(app).get(`/api/comparisons/${id}`).expect(200);

    const updated = await request(app).put(`/api/comparisons/${id}`).send({ name: "Renamed" }).expect(200);
    expect(updated.body.data).toMatchObject({ name: "Renamed", companyIds: ["dtales-tech", "webflow"] });

    await request(app).delete(`/api/comparisons/${id}`).expect(204);
    await request(app).get(`/api/comparisons/${id}`).expect(404);
    await request(app).delete(`/api/comparisons/${id}`).expect(404);
  });

  it("rejects unknown companies and bad input", async () => {
    const res = await request(app).post("/api/comparisons").send({ name: "X", companyIds: ["ghost"] }).expect(400);
    expect(res.body.error.code).toBe("UNKNOWN_COMPANY");
    await request(app).post("/api/comparisons").send({ name: "X", companyIds: [] }).expect(400);
    await request(app).put("/api/comparisons/not-a-uuid").send({ name: "X" }).expect(400);
  });
});
