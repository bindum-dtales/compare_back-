import { vi } from "vitest";

vi.mock("../src/repositories/company.repository.js", async () => (await import("./fake-db.js")).companyRepo);
vi.mock("../src/repositories/research.repository.js", async () => (await import("./fake-db.js")).researchRepo);
vi.mock("../src/repositories/comparison.repository.js", async () => (await import("./fake-db.js")).comparisonRepo);
