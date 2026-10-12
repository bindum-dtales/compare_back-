import { z } from "zod";
import { ApiError } from "./errors.js";
import { normalizeDomain } from "./domain.js";

const companyName = z.string({ error: "Company name is required." }).trim().min(1, "Company name is required.").max(200);

export const companyIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Invalid company id.")
  .max(200);

export const uuidSchema = z.uuid("Invalid id.");

export const searchSchema = z.object({ query: companyName });

/** Canonical research input: the user always supplies both name and website. */
export const startResearchSchema = z.object({
  companyName,
  domain: z
    .string({ error: "Company URL is required." })
    .trim()
    .min(1, "Company URL is required.")
    .max(2048)
    .transform((value, ctx) => {
      const domain = normalizeDomain(value);
      if (!domain) {
        ctx.addIssue({ code: "custom", message: "Company URL must be a valid http(s) URL, e.g. https://example.com." });
        return z.NEVER;
      }
      return domain;
    }),
  /** Research again even if the company already has a completed result (the "Re-run research" action). */
  force: z.boolean({ error: "force must be true or false." }).optional().default(false),
});

export type ResearchRequest = z.infer<typeof startResearchSchema>;

const comparisonBody = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  companyIds: z.array(companyIdSchema).min(1).max(10),
});

export const createComparisonSchema = comparisonBody;
export const updateComparisonSchema = comparisonBody
  .partial()
  .refine((v) => v.name !== undefined || v.companyIds !== undefined, "Nothing to update.");

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", result.error.issues[0]?.message ?? "Invalid request.", z.flattenError(result.error));
  }
  return result.data;
}
