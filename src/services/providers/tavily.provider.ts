// Tavily search (https://docs.tavily.com/documentation/api-reference/endpoint/search).
// "basic" depth = 1 credit per query. Statuses: 401 bad key, 429 rate limit,
// 432 plan limit, 433 pay-as-you-go limit.

import { z } from "zod";
import { postJson, HttpTransportError } from "../../utils/http.js";
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from "../search.service.js";

const ENDPOINT = "https://api.tavily.com/search";
const MAX_EXCLUDE_DOMAINS = 150; // Tavily's limit

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
    }),
  ),
});

export interface TavilyOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";

  constructor(
    private readonly apiKey: string,
    private readonly opts: TavilyOptions = {},
  ) {}

  async search(query: string, { maxResults = 10, excludeDomains = [], includeDomains = [] }: SearchOptions = {}): Promise<SearchResult[]> {
    let res;
    try {
      res = await postJson(
        ENDPOINT,
        {
          query,
          search_depth: "basic",
          topic: "general",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          ...(excludeDomains.length ? { exclude_domains: excludeDomains.slice(0, MAX_EXCLUDE_DOMAINS) } : {}),
          ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeoutMs: this.opts.timeoutMs ?? 30_000,
          retryDelayMs: this.opts.retryDelayMs ?? 2_000,
        },
      );
    } catch (e) {
      if (e instanceof HttpTransportError) throw new SearchError(e.kind, `Tavily: ${e.message}`);
      throw e;
    }

    if (!res.ok) {
      const msg = `Tavily HTTP ${res.status}`;
      if (res.status === 429) throw new SearchError("rate_limited", msg, 429);
      if (res.status === 432 || res.status === 433) throw new SearchError("quota_exceeded", msg, res.status);
      throw new SearchError("upstream_error", msg, res.status);
    }

    const parsed = responseSchema.safeParse(res.body);
    if (!parsed.success) throw new SearchError("malformed_response", "Tavily response did not match the expected shape");
    return parsed.data.results.map((r) => ({
      title: r.title?.trim() ?? "",
      url: r.url,
      snippet: r.content?.trim() ?? "",
      score: r.score ?? null,
    }));
  }
}
