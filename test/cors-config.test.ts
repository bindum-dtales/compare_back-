import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createCorsMiddleware } from "../src/middleware/cors.middleware.js";
import { DEV_FRONTEND_ORIGIN, parseCorsOrigins } from "../src/config/origins.js";
import { configDiagnostics } from "../src/config/diagnostics.js";
import { app } from "../src/app.js";

const PROD_FRONTEND = "https://score.dtales.tech";

describe("FRONTEND_URL → CORS origins", () => {
  it("defaults to the local dev frontend outside production", () => {
    expect(DEV_FRONTEND_ORIGIN).toBe("http://localhost:3000");
    expect(parseCorsOrigins(undefined, "development")).toEqual(["http://localhost:3000"]);
    expect(parseCorsOrigins(" , ", "test")).toEqual(["http://localhost:3000"]);
  });

  it("allows no cross-origin browsers in production when unset (the /api proxy is same-origin)", () => {
    expect(parseCorsOrigins(undefined, "production")).toEqual([]);
    expect(parseCorsOrigins("", "production")).toEqual([]);
  });

  it("parses a list, normalizing to the Origin form browsers send", () => {
    expect(parseCorsOrigins(`${PROD_FRONTEND}/, http://localhost:3000 ,https://score.dtales.tech`, "production")).toEqual([PROD_FRONTEND, "http://localhost:3000"]);
    expect(parseCorsOrigins("HTTPS://Score.DTales.tech:443", "production")).toEqual([PROD_FRONTEND]);
  });

  it("rejects wildcards, paths and non-origins", () => {
    for (const bad of ["*", "https://*.dtales.tech", "https://score.dtales.tech/app", "score.dtales.tech", "ftp://score.dtales.tech", "https://u:p@score.dtales.tech"]) {
      expect(() => parseCorsOrigins(bad, "production"), bad).toThrow(/FRONTEND_URL/);
    }
  });
});

describe("CORS middleware", () => {
  const server = (origins: string[]) => express().use(createCorsMiddleware(origins)).get("/x", (_req, res) => res.json({ ok: true })).post("/x", (_req, res) => res.json({ ok: true }));
  const prod = server([PROD_FRONTEND]);

  it("allows the production frontend, with a preflight for JSON POSTs", async () => {
    const get = await request(prod).get("/x").set("Origin", PROD_FRONTEND).expect(200);
    expect(get.headers["access-control-allow-origin"]).toBe(PROD_FRONTEND);
    expect(get.headers["vary"]).toMatch(/Origin/);

    const pre = await request(prod).options("/x").set("Origin", PROD_FRONTEND).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type").expect(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(PROD_FRONTEND);
    expect(pre.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(pre.headers["access-control-allow-headers"]).toMatch(/Content-Type/i);
  });

  it("never sends a wildcard or allows credentials", async () => {
    const res = await request(prod).get("/x").set("Origin", PROD_FRONTEND);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("gives unapproved origins no CORS headers, so the browser blocks them", async () => {
    for (const origin of ["https://evil.example", "http://score.dtales.tech", "https://score.dtales.tech.evil.example", "http://localhost:3000"]) {
      const get = await request(prod).get("/x").set("Origin", origin);
      expect(get.headers["access-control-allow-origin"], origin).toBeUndefined();
      const pre = await request(prod).options("/x").set("Origin", origin).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type");
      expect(pre.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("keeps the local dev origin working alongside production", async () => {
    const both = server([PROD_FRONTEND, "http://localhost:3000"]);
    for (const origin of [PROD_FRONTEND, "http://localhost:3000"]) {
      expect((await request(both).get("/x").set("Origin", origin)).headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("with no allowed origins (production via the proxy) still serves requests without CORS headers", async () => {
    const none = server([]);
    // No Origin: curl, health checks. Forwarded Origin: the browser's, passed through by the Next proxy.
    expect((await request(none).get("/x").expect(200)).headers["access-control-allow-origin"]).toBeUndefined();
    expect((await request(none).post("/x").set("Origin", PROD_FRONTEND).send({}).expect(200)).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("environment loading", () => {
  // env.ts parses process.env at import: reload it per test (app.js above already imported one copy).
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async () => (await import("../src/config/env.js")).env;

  it("production with FRONTEND_URL unset allows no cross-origin browsers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_URL", "");
    expect((await load()).corsOrigins).toEqual([]);
  });

  it("production with the frontend listed allows exactly it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_URL", `${PROD_FRONTEND}/`);
    expect((await load()).corsOrigins).toEqual([PROD_FRONTEND]);
  });

  it("HOST is optional (unset: all interfaces)", async () => {
    vi.stubEnv("HOST", "");
    expect((await load()).HOST).toBeUndefined();
    vi.resetModules();
    vi.stubEnv("HOST", "127.0.0.1");
    expect((await load()).HOST).toBe("127.0.0.1");
  });

  it("fails at startup on a wildcard FRONTEND_URL", async () => {
    vi.stubEnv("FRONTEND_URL", "*");
    await expect(load()).rejects.toThrow(/wildcards are not allowed/);
  });

  it("missing required config names the variable, never a value", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const err = await load().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Invalid environment configuration: .*SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
    expect(err?.message).not.toMatch(/test-(groq|tavily)-key/);
  });
});

describe("startup diagnostics", () => {
  it("report names and origins, never key values", () => {
    const lines = configDiagnostics({ NODE_ENV: "production", corsOrigins: [], GROQ_API_KEY: "gsk_live_secret", TAVILY_API_KEY: undefined }).join("\n");
    expect(lines).toMatch(/no cross-origin browsers allowed/);
    expect(lines).toMatch(/TAVILY_API_KEY is not set/);
    expect(lines).not.toMatch(/GROQ_API_KEY is not set/);
    expect(lines).not.toContain("gsk_live_secret");
  });

  it("list the allowed origins", () => {
    expect(configDiagnostics({ NODE_ENV: "production", corsOrigins: [PROD_FRONTEND], GROQ_API_KEY: "k", TAVILY_API_KEY: "k" })).toEqual([`[cors] cross-origin browsers allowed: ${PROD_FRONTEND}`]);
  });
});

describe("health checks expose no configuration", () => {
  it("GET /health returns status and uptime only", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(["status", "uptime"]);
    expect(JSON.stringify(res.body)).not.toMatch(/test-(service-role|groq|tavily)-key|supabase|localhost:54321/i);
  });
});
