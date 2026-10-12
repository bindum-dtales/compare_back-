import { describe, expect, it } from "vitest";
import {
  companyIdSchema,
  createComparisonSchema,
  parse,
  searchSchema,
  startResearchSchema,
  updateComparisonSchema,
  uuidSchema,
} from "../src/utils/validation.js";
import { ApiError } from "../src/utils/errors.js";

const rejects = (schema: Parameters<typeof parse>[0], value: unknown) => {
  try {
    parse(schema, value);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("VALIDATION_ERROR");
    return;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
};

describe("validation", () => {
  it("search: trims and rejects empty queries", () => {
    expect(parse(searchSchema, { query: "  DTales Tech " })).toEqual({ query: "DTales Tech" });
    rejects(searchSchema, { query: "   " });
    rejects(searchSchema, {});
    rejects(searchSchema, { query: 42 });
  });

  it("research: requires both company name and a valid http(s) URL", () => {
    expect(parse(startResearchSchema, { companyName: " DTales Tech ", domain: "https://dtales.tech" })).toEqual({
      companyName: "DTales Tech",
      domain: "dtales.tech",
      force: false, // a normal request: an already researched company is returned as is
    });
    expect(parse(startResearchSchema, { companyName: "DTales Tech", domain: "dtales.tech", force: true })).toMatchObject({ force: true });
    rejects(startResearchSchema, { companyName: "DTales Tech", domain: "dtales.tech", force: "yes" });
    rejects(startResearchSchema, { companyName: "DTales Tech", domain: "dtales.tech", force: 1 });
    rejects(startResearchSchema, { companyName: "", domain: "https://dtales.tech" });
    rejects(startResearchSchema, { companyName: "DTales Tech", domain: "" });
    rejects(startResearchSchema, { companyName: "DTales Tech", domain: "   " });
    rejects(startResearchSchema, { companyName: "DTales Tech", domain: "not-a-url" });
    rejects(startResearchSchema, { companyName: "DTales Tech" });
    rejects(startResearchSchema, { domain: "https://dtales.tech" });
    rejects(startResearchSchema, { companyName: "x".repeat(201), domain: "https://dtales.tech" });
    rejects(startResearchSchema, null);
  });

  it("ids: slugs for companies, uuids for jobs/comparisons", () => {
    expect(parse(companyIdSchema, "dtales-tech")).toBe("dtales-tech");
    rejects(companyIdSchema, "DTales Tech");
    rejects(companyIdSchema, "../etc");
    expect(parse(uuidSchema, "3f0b5c1e-8a7d-4c2b-9e1f-0a1b2c3d4e5f")).toBeTruthy();
    rejects(uuidSchema, "123");
  });

  it("comparisons: create needs name + ids, update needs at least one field", () => {
    expect(parse(createComparisonSchema, { name: "Q3", companyIds: ["dtales"] })).toBeTruthy();
    rejects(createComparisonSchema, { name: "Q3", companyIds: [] });
    rejects(createComparisonSchema, { name: "", companyIds: ["dtales"] });
    rejects(createComparisonSchema, { name: "Q3", companyIds: ["Bad Id"] });
    rejects(createComparisonSchema, { name: "Q3", companyIds: Array.from({ length: 11 }, (_, i) => `c${i}`) });
    expect(parse(updateComparisonSchema, { name: "Renamed" })).toEqual({ name: "Renamed" });
    rejects(updateComparisonSchema, {});
  });
});
