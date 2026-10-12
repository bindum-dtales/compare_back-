// Groq chat completions (OpenAI-compatible) with strict structured outputs.
// https://console.groq.com/docs/structured-outputs — strict mode needs a model that
// supports it (openai/gpt-oss-20b, openai/gpt-oss-120b). `include_reasoning: false`
// keeps the model's reasoning out of the response entirely: we never receive or store it.

import type { z } from "zod";
import { postJson, HttpTransportError } from "../../utils/http.js";
import { LlmError, parseStructured, toStrictJsonSchema, type LlmProvider, type StructuredRequest } from "../llm.service.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Longest Retry-After to honor on a 429/5xx. */
  maxRetryAfterMs?: number;
  /** Attempts on a 429; see GROQ_RATE_LIMIT_ATTEMPTS. */
  maxRateLimitAttempts?: number;
}

/** Defaults for requests that don't set their own (StructuredRequest.reasoningEffort / maxCompletionTokens). */
export const GROQ_DEFAULTS = { reasoningEffort: "medium", maxCompletionTokens: 4096 } as const;

/**
 * Groq's tokens-per-minute window is 60 s and its 429 says how long until it clears ("try again in
 * 23.22s"); waiting less just spends the one retry on another 429.
 */
const GROQ_MAX_RETRY_AFTER_MS = 60_000;

/**
 * Attempts on a 429 (one call plus three waits of up to GROQ_MAX_RETRY_AFTER_MS). A job's LLM calls run
 * back to back and each reserves its prompt + max_completion_tokens against the TPM window, so on the
 * free tier (8000 TPM) consecutive calls routinely hit one 429 and sometimes a second; timeouts and
 * 5xx keep the single retry.
 */
const GROQ_RATE_LIMIT_ATTEMPTS = 4;

/**
 * One Groq request in flight per process. The TPM window is per organization, so overlapping calls
 * (and their retries) would only take tokens from each other; queued calls run in arrival order.
 */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: GroqOptions = {},
  ) {}

  generateObject<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    return oneAtATime(() => this.request(req));
  }

  private async request<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    let res;
    try {
      res = await postJson(
        ENDPOINT,
        {
          model: this.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: req.name, strict: true, schema: toStrictJsonSchema(req.schema) },
          },
          include_reasoning: false,
          reasoning_effort: req.reasoningEffort ?? GROQ_DEFAULTS.reasoningEffort,
          temperature: 0,
          // Includes the model's (hidden) reasoning tokens.
          max_completion_tokens: req.maxCompletionTokens ?? GROQ_DEFAULTS.maxCompletionTokens,
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeoutMs: this.opts.timeoutMs ?? 60_000,
          retryDelayMs: this.opts.retryDelayMs ?? 2_000,
          maxRetryAfterMs: this.opts.maxRetryAfterMs ?? GROQ_MAX_RETRY_AFTER_MS,
          maxRateLimitAttempts: this.opts.maxRateLimitAttempts ?? GROQ_RATE_LIMIT_ATTEMPTS,
          onRetry: ({ status, attempt, waitMs }) =>
            console.warn(`[groq] ${req.name}: ${status === 429 ? "rate limited" : status ? `HTTP ${status}` : "no response"}, retry ${attempt} in ${(waitMs / 1000).toFixed(1)}s`),
        },
      );
    } catch (e) {
      if (e instanceof HttpTransportError) throw new LlmError(e.kind, `Groq: ${e.message}`);
      throw e;
    }

    if (!res.ok) {
      const detail = (res.body as { error?: { message?: unknown; code?: unknown } } | undefined)?.error;
      const msg = `Groq HTTP ${res.status}${typeof detail?.message === "string" ? `: ${detail.message}` : ""}`;
      if (res.status === 429) throw new LlmError("rate_limited", msg, 429);
      // Strict decoding can still reject a generation; Groq reports it as a 400 json_validate_failed.
      if (res.status === 400 && detail?.code === "json_validate_failed") throw new LlmError("malformed_response", msg, 400);
      throw new LlmError("upstream_error", msg, res.status);
    }

    const choice = (res.body as ChatCompletion | undefined)?.choices?.[0];
    if (!choice) throw new LlmError("empty_response", "Groq returned no choices");
    if (choice.finish_reason === "length") throw new LlmError("malformed_response", "Groq output was cut off (max tokens)");
    return parseStructured(req.schema, choice.message?.content);
  }
}
