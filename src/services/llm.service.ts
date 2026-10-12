// Provider-neutral structured LLM calls. The pipeline asks for an object matching a zod
// schema; the provider (providers/groq.provider.ts) handles the wire format. Output is
// always re-validated with zod, whatever the provider promises.
//
// LLMs here interpret collected facts (category, "is this a competitor?"). They never score.

import { z } from "zod";
import { env } from "../config/env.js";
import { StepFailure } from "../utils/errors.js";
import { GroqProvider } from "./providers/groq.provider.js";

export type LlmErrorKind =
  | "not_configured"
  | "timeout"
  | "network"
  | "rate_limited"
  | "upstream_error" // provider failed/refused (5xx, auth, quota, request too large…)
  | "empty_response"
  | "malformed_response"; // not JSON, cut off, or failed schema validation

export class LlmError extends StepFailure<LlmErrorKind> {}

export type ReasoningEffort = "low" | "medium" | "high";

export interface StructuredRequest<T extends z.ZodType> {
  /** Identifier for the schema, e.g. "category". */
  name: string;
  system: string;
  user: string;
  schema: T;
  /** How much hidden reasoning the model may do before answering. Provider default if unset. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Cap on generated tokens, hidden reasoning included. Providers that rate-limit by tokens per
   * minute (Groq) count this cap against the limit up front, so size it to the output.
   */
  maxCompletionTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateObject<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}

/** Validates a provider's raw text output. Shared so every provider fails the same way. */
export function parseStructured<T extends z.ZodType>(schema: T, text: string | null | undefined): z.infer<T> {
  if (!text?.trim()) throw new LlmError("empty_response", "LLM returned no content");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError("malformed_response", "LLM output is not valid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError("malformed_response", `LLM output failed validation: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
  }
  return parsed.data;
}

/**
 * JSON Schema for strict structured output. Strict decoders support a subset of keywords,
 * so value constraints (lengths, ranges) are dropped here and enforced by zod afterwards.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const DROP = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "format"]);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).filter(([k]) => !DROP.has(k)).map(([k, v]) => [k, strip(v)]));
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** The configured provider. Throws `not_configured` (surfaced as a safe job error) if the key is missing. */
export function getLlmProvider(): LlmProvider {
  if (!env.GROQ_API_KEY) throw new LlmError("not_configured", "GROQ_API_KEY is not set");
  return new GroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL);
}
