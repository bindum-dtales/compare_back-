import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { z } from "zod";
import { TavilySearchProvider } from "../src/services/providers/tavily.provider.js";
import { GroqProvider } from "../src/services/providers/groq.provider.js";
import { createSearchSession, getSearchProvider, SearchError } from "../src/services/search.service.js";
import { LlmError, toStrictJsonSchema } from "../src/services/llm.service.js";
import { fakeSearch, result } from "./discovery-fixtures.js";
import { hang, mockFetch } from "./jina-fixtures.js";

const fast = { timeoutMs: 50, retryDelayMs: 0 };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { kind: string; status?: number; message: string };
  }
  throw new Error("expected a rejection");
};

describe("TavilySearchProvider", () => {
  const tavily = () => new TavilySearchProvider("tvly-secret", fast);

  it("sends a basic search with the key in the header and maps results", async () => {
    const fetch = mockFetch(() =>
      json(200, { query: "q", results: [{ title: " Acme ", url: "https://acme.com/", content: "Agency.", score: 0.9 }, { url: "https://b.com/x" }] }),
    );
    const results = await tavily().search("top content agencies", { maxResults: 5, excludeDomains: ["clutch.co"] });

    expect(results).toEqual([
      { title: "Acme", url: "https://acme.com/", snippet: "Agency.", score: 0.9 },
      { title: "", url: "https://b.com/x", snippet: "", score: null },
    ]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tvly-secret" });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "top content agencies",
      search_depth: "basic",
      topic: "general",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      exclude_domains: ["clutch.co"],
    });
  });

  it("returns [] for empty results", async () => {
    mockFetch(() => json(200, { results: [] }));
    expect(await tavily().search("nothing")).toEqual([]);
  });

  it("retries a 5xx once, then fails without leaking the key", async () => {
    const fetch = mockFetch(() => json(502, { detail: "bad gateway" }));
    const err = await failure(tavily().search("q"));
    expect(err).toMatchObject({ kind: "upstream_error", status: 502 });
    expect(err.message).not.toContain("tvly-secret");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps 429 to rate_limited after one retry", async () => {
    const fetch = mockFetch(() => json(429, {}, { "retry-after": "0" }));
    expect((await failure(tavily().search("q"))).kind).toBe("rate_limited");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([432, 433])("maps %i to quota_exceeded without retrying", async (status) => {
    const fetch = mockFetch(() => json(status, {}));
    expect((await failure(tavily().search("q"))).kind).toBe("quota_exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a bad key (401)", async () => {
    const fetch = mockFetch(() => json(401, { detail: "Unauthorized" }));
    expect((await failure(tavily().search("q"))).kind).toBe("upstream_error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("times out (bounded)", async () => {
    const fetch = mockFetch(hang);
    expect((await failure(tavily().search("q"))).kind).toBe("timeout");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed response", async () => {
    mockFetch(() => json(200, { answer: "no results field" }));
    expect((await failure(tavily().search("q"))).kind).toBe("malformed_response");
  });

  it("is not configured without TAVILY_API_KEY", () => {
    const key = env.TAVILY_API_KEY;
    env.TAVILY_API_KEY = undefined;
    try {
      expect(() => getSearchProvider()).toThrow(SearchError);
    } finally {
      env.TAVILY_API_KEY = key;
    }
  });
});

describe("search session", () => {
  it("never sends the same query twice in one job", async () => {
    const provider = fakeSearch(() => [result("https://a.com/", "A")]);
    const session = createSearchSession(provider);
    await session.search("Top Content Agencies");
    await session.search("  top   content agencies ");
    await session.search("other");
    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(session.queries).toEqual(["Top Content Agencies", "other"]);
  });

  it("does not cache failures", async () => {
    let n = 0;
    const provider = fakeSearch(() => {
      if (n++ === 0) throw new SearchError("timeout", "slow");
      return [];
    });
    const session = createSearchSession(provider);
    await expect(session.search("q")).rejects.toThrow("slow");
    expect(await session.search("q")).toEqual([]);
  });
});

describe("GroqProvider", () => {
  const schema = z.object({ category: z.string().min(3), confidence: z.number().min(0).max(1) });
  const groq = () => new GroqProvider("gsk-secret", "openai/gpt-oss-120b", fast);
  const completion = (content: string | null, finish_reason = "stop") => json(200, { choices: [{ message: { content }, finish_reason }] });
  const ask = () => groq().generateObject({ name: "category", system: "sys", user: "usr", schema });

  it("requests strict structured output without reasoning and validates the result", async () => {
    const fetch = mockFetch(() => completion('{"category":"Content Agency","confidence":0.8}'));
    expect(await ask()).toEqual({ category: "Content Agency", confidence: 0.8 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer gsk-secret" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      include_reasoning: false,
      temperature: 0,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "category",
          strict: true,
          schema: {
            type: "object",
            properties: { category: { type: "string" }, confidence: { type: "number" } },
            required: ["category", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("re-validates even strict output (range constraints aren't sent to the decoder)", async () => {
    mockFetch(() => completion('{"category":"Content Agency","confidence":3}'));
    expect((await failure(ask())).kind).toBe("malformed_response");
  });

  it.each([
    ["missing content", completion(null), "empty_response"],
    ["no choices", json(200, { choices: [] }), "empty_response"],
    ["cut off at max tokens", completion('{"category":"Con', "length"), "malformed_response"],
    ["non-JSON content", completion("Sure! The category is..."), "malformed_response"],
    ["schema rejection by Groq", json(400, { error: { message: "Failed to validate JSON", code: "json_validate_failed" } }), "malformed_response"],
  ])("handles %s", async (_name, response, kind) => {
    mockFetch(() => response.clone());
    expect((await failure(ask())).kind).toBe(kind);
  });

  it("maps 429 to rate_limited after its rate-limit retries, without leaking the key", async () => {
    const fetch = mockFetch(() => json(429, { error: { message: "Rate limit reached" } }, { "retry-after": "0" }));
    const err = await failure(ask());
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("rate_limited");
    expect(err.message).not.toContain("gsk-secret");
    expect(fetch).toHaveBeenCalledTimes(4); // 1 call + 3 rate-limit retries;
  });

  it("strict JSON schema drops keywords strict decoders don't support", () => {
    expect(toStrictJsonSchema(schema)).toEqual({
      type: "object",
      properties: { category: { type: "string" }, confidence: { type: "number" } },
      required: ["category", "confidence"],
      additionalProperties: false,
    });
  });
});
