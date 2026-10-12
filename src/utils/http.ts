// JSON POST with a hard timeout and a small bounded retry, shared by the API providers
// (Tavily, Groq). Retries only transient failures: timeouts, network errors, 429, 5xx.
// Never logs or echoes request headers (they carry API keys).

export class HttpTransportError extends Error {
  constructor(public readonly kind: "timeout" | "network", message: string) {
    super(message);
    this.name = "HttpTransportError";
  }
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  /** Per attempt. */
  timeoutMs: number;
  /** Wait before a retry when the server doesn't say how long to wait. */
  retryDelayMs: number;
  /**
   * Longest wait the server's own retry hint may impose (Retry-After header, or a "try again in 23.22s"
   * message). Default 10 s; a hint above the cap is cut to the cap.
   */
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  /**
   * Attempts when the server answers 429 (rate limited), each after the wait it asks for. Default
   * `maxAttempts`. A provider with a short rolling window (Groq's per-minute token limit) raises it,
   * so a burst of sequential calls waits the window out instead of failing on the second 429.
   */
  maxRateLimitAttempts?: number;
  /** Called before each retry wait, e.g. to log it. Gets no request details (they may hold keys). */
  onRetry?: (info: { status: number | null; attempt: number; waitMs: number }) => void;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON, or undefined if the body wasn't JSON. */
  body: unknown;
}

export const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

/** "Please try again in 23.22s" / "in 1m2.5s" / "in 450ms" (as in Groq's 429 messages) → ms; null if absent. */
export function retryHintMs(text: string): number | null {
  const m = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?\s*(?:([\d.]+)ms)?/i.exec(text);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000 + Number(m[4] ?? 0);
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : null;
}

/**
 * How long to wait before retrying: the Retry-After header (seconds or an HTTP date), else a
 * "try again in …" hint in the body, else `fallback`; capped at `cap`.
 */
export async function retryDelay(res: Response, fallback: number, cap: number): Promise<number> {
  const header = res.headers.get("retry-after");
  const secs = Number(header);
  const hint = header
    ? Number.isFinite(secs)
      ? secs * 1000
      : Date.parse(header) - Date.now()
    : retryHintMs(await res.text().catch(() => ""));
  return hint !== null && Number.isFinite(hint) && hint > 0 ? Math.min(hint, cap) : fallback;
}

/**
 * Returns the last response, whatever its status (callers map statuses to their own errors).
 * Throws HttpTransportError only when no response was received on the final attempt.
 */
export async function postJson(url: string, payload: unknown, opts: PostJsonOptions): Promise<JsonResponse> {
  const maxAttempts = opts.maxAttempts ?? 2;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...opts.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (attempt >= maxAttempts) {
        throw timedOut
          ? new HttpTransportError("timeout", `No response within ${opts.timeoutMs}ms`)
          : new HttpTransportError("network", e instanceof Error ? e.message : String(e));
      }
      opts.onRetry?.({ status: null, attempt, waitMs: opts.retryDelayMs });
      await sleep(opts.retryDelayMs);
      continue;
    }
    const limit = res.status === 429 ? Math.max(maxAttempts, opts.maxRateLimitAttempts ?? maxAttempts) : maxAttempts;
    if (retryable(res.status) && attempt < limit) {
      const wait = await retryDelay(res, opts.retryDelayMs, opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
      await res.body?.cancel().catch(() => {});
      opts.onRetry?.({ status: res.status, attempt, waitMs: wait });
      await sleep(wait);
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, ok: res.ok, body };
  }
}
