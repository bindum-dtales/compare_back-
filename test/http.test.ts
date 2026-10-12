import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_MAX_RETRY_AFTER_MS, postJson, retryDelay, retryHintMs } from "../src/utils/http.js";
import { GroqProvider } from "../src/services/providers/groq.provider.js";
import { TavilySearchProvider } from "../src/services/providers/tavily.provider.js";
import { mockFetch } from "./jina-fixtures.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const GROQ_429 = {
  error: {
    message: "Rate limit reached for model `openai/gpt-oss-120b` … on tokens per minute (TPM): Limit 8000, Used 4807, Requested 6289. Please try again in 23.22s. Need more tokens?",
    code: "rate_limit_exceeded",
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Resolves when `p` settles, advancing fake time in 1 s steps; returns the fake ms elapsed. */
async function elapsed(p: Promise<unknown>) {
  const start = Date.now();
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(1_000);
  return Date.now() - start;
}

describe("retryHintMs", () => {
  it.each([
    ["Please try again in 23.22s. Need more tokens?", 23_220],
    ["Please try again in 1m2.5s.", 62_500],
    ["try again in 450ms", 450],
    ["try again in 2m", 120_000],
    ["Rate limit reached", null],
    ["", null],
  ])("%s → %s", (text, ms) => expect(retryHintMs(text)).toBe(ms));
});

describe("retryDelay", () => {
  const res = (headers: Record<string, string>, body: unknown = {}) => json(429, body, headers);

  it("uses the Retry-After header (seconds or HTTP date), capped", async () => {
    expect(await retryDelay(res({ "retry-after": "24" }), 2_000, 60_000)).toBe(24_000);
    expect(await retryDelay(res({ "retry-after": "24" }), 2_000, 10_000)).toBe(10_000);
    const date = new Date(Date.now() + 30_000).toUTCString();
    const d = await retryDelay(res({ "retry-after": date }), 2_000, 60_000);
    expect(d).toBeGreaterThan(28_000);
    expect(d).toBeLessThanOrEqual(30_000);
  });

  it("falls back to the body's \"try again in\" hint when there is no header", async () => {
    expect(await retryDelay(res({}, GROQ_429), 2_000, 60_000)).toBe(23_220);
  });

  it("uses the caller's default delay without any hint", async () => {
    expect(await retryDelay(res({}, { error: "busy" }), 2_000, 60_000)).toBe(2_000);
    expect(await retryDelay(res({ "retry-after": "0" }), 2_000, 60_000)).toBe(2_000);
  });
});

describe("postJson retry waits", () => {
  it("waits as long as the server asks, up to the caller's cap, then retries once", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetch = mockFetch(() => (n++ === 0 ? json(429, GROQ_429, { "retry-after": "24" }) : json(200, { ok: true })));
    const call = postJson("https://api.example/x", {}, { timeoutMs: 1_000, retryDelayMs: 0, maxRetryAfterMs: 60_000 });
    const ms = await elapsed(call);
    expect((await call).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ms).toBeGreaterThanOrEqual(24_000);
    expect(ms).toBeLessThan(26_000);
  });

  it("keeps the 10 s default cap for callers that don't raise it", async () => {
    vi.useFakeTimers();
    mockFetch(() => json(429, {}, { "retry-after": "24" }));
    const call = postJson("https://api.example/x", {}, { timeoutMs: 1_000, retryDelayMs: 0 });
    const ms = await elapsed(call);
    expect((await call).status).toBe(429); // still surfaced after the one retry
    expect(ms).toBeGreaterThanOrEqual(DEFAULT_MAX_RETRY_AFTER_MS);
    expect(ms).toBeLessThan(DEFAULT_MAX_RETRY_AFTER_MS + 2_000);
  });
});

describe("GroqProvider rate limits", () => {
  const schema = z.object({ ok: z.boolean() });
  const ask = (groq = new GroqProvider("gsk-secret", "openai/gpt-oss-120b", { timeoutMs: 1_000, retryDelayMs: 0 })) =>
    groq.generateObject({ name: "t", system: "s", user: "u", schema });
  const ok = () => json(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });

  it("honors a Retry-After above 10 s (Groq's TPM window), then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetch = mockFetch(() => (n++ === 0 ? json(429, GROQ_429, { "retry-after": "24" }) : ok()));
    const call = ask();
    const ms = await elapsed(call);
    expect(await call).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ms).toBeGreaterThanOrEqual(24_000);
  });

  it("honors the \"try again in 23.22s\" message when the header is missing", async () => {
    vi.useFakeTimers();
    let n = 0;
    mockFetch(() => (n++ === 0 ? json(429, GROQ_429) : ok()));
    const call = ask();
    const ms = await elapsed(call);
    expect(await call).toEqual({ ok: true });
    expect(ms).toBeGreaterThanOrEqual(23_220);
    expect(ms).toBeLessThan(25_000);
  });

  it("waits out repeated 429s (consecutive calls in one TPM window), then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetch = mockFetch(() => (n++ < 2 ? json(429, GROQ_429) : ok()));
    const call = ask();
    const ms = await elapsed(call);
    expect(await call).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(ms).toBeGreaterThanOrEqual(2 * 23_220);
  });

  it("still fails as rate_limited when every retry is limited again, each wait capped at 60 s", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => json(429, GROQ_429, { "retry-after": "600" }));
    const call = ask();
    const ms = await elapsed(call);
    await expect(call).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(4); // 1 call + 3 rate-limit retries
    expect(ms).toBeGreaterThanOrEqual(3 * 60_000);
    expect(ms).toBeLessThan(3 * 60_000 + 3_000);
  });

  it("logs each rate-limit wait (schema name and delay only: no key, prompt or provider message)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    mockFetch(() => (n++ === 0 ? json(429, GROQ_429) : ok()));
    const call = ask();
    await elapsed(call);
    expect(warn.mock.calls).toEqual([["[groq] t: rate limited, retry 1 in 23.2s"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/gsk-secret|TPM|Used/);
  });

  it("keeps the single retry for server errors (5xx)", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => json(503, { error: { message: "unavailable" } }));
    const call = ask();
    await elapsed(call);
    await expect(call).rejects.toMatchObject({ kind: "upstream_error" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends one request at a time: concurrent calls (and their retries) queue instead of overlapping", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 500));
        inFlight--;
        return n++ === 0 ? json(429, GROQ_429, { "retry-after": "2" }) : ok();
      }),
    );
    const groq = new GroqProvider("gsk-secret", "openai/gpt-oss-120b", { timeoutMs: 5_000, retryDelayMs: 0 });
    const calls = Promise.all([ask(groq), ask(groq), ask(new GroqProvider("gsk-secret", "openai/gpt-oss-120b", { timeoutMs: 5_000, retryDelayMs: 0 }))]);
    await elapsed(calls);
    expect(await calls).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(maxInFlight).toBe(1);
    expect(n).toBe(4); // the first call's 429 retry, then the other two
  });

  it("a failed call doesn't block the ones queued behind it", async () => {
    let n = 0;
    mockFetch(() => (n++ === 0 ? json(401, { error: { message: "bad key" } }) : ok()));
    const [first, second] = await Promise.allSettled([ask(), ask()]);
    expect(first).toMatchObject({ status: "rejected", reason: { kind: "upstream_error" } });
    expect(second).toEqual({ status: "fulfilled", value: { ok: true } });
  });

  it("Tavily keeps the 10 s cap", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => json(429, {}, { "retry-after": "24" }));
    const call = new TavilySearchProvider("tvly-x", { timeoutMs: 1_000, retryDelayMs: 0 }).search("q");
    const ms = await elapsed(call);
    await expect(call).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ms).toBeLessThan(12_000);
  });
});
