// Provider-neutral web search. The pipeline depends on SearchProvider only; Tavily lives in
// providers/tavily.provider.ts. A SearchSession wraps a provider for one research job so the
// same query is never sent twice.

import { env } from "../config/env.js";
import { StepFailure } from "../utils/errors.js";
import { TavilySearchProvider } from "./providers/tavily.provider.js";

export interface SearchResult {
  title: string;
  url: string;
  /** Provider's text excerpt for the page. */
  snippet: string;
  /** Provider relevance, 0–1, if it gives one. */
  score: number | null;
}

export interface SearchOptions {
  maxResults?: number;
  /** Domains the provider should leave out (normalized). */
  excludeDomains?: string[];
  /** Restrict results to these domains (normalized). */
  includeDomains?: string[];
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export type SearchErrorKind =
  | "not_configured"
  | "timeout"
  | "network"
  | "rate_limited"
  | "quota_exceeded"
  | "upstream_error"
  | "malformed_response";

export class SearchError extends StepFailure<SearchErrorKind> {}

export function getSearchProvider(): SearchProvider {
  if (!env.TAVILY_API_KEY) throw new SearchError("not_configured", "TAVILY_API_KEY is not set");
  return new TavilySearchProvider(env.TAVILY_API_KEY);
}

export interface SearchSession {
  readonly provider: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** Queries actually sent to the provider, in order. */
  readonly queries: readonly string[];
}

const queryKey = (q: string, opts?: SearchOptions) =>
  [q.trim().replace(/\s+/g, " ").toLowerCase(), ...(opts?.includeDomains ?? []).map((d) => `site:${d}`)].join(" ");

/** Memoizes by normalized query for the life of one job. Failed queries aren't cached. */
export function createSearchSession(provider: SearchProvider): SearchSession {
  const cache = new Map<string, Promise<SearchResult[]>>();
  const queries: string[] = [];
  return {
    provider: provider.name,
    queries,
    search(query, opts) {
      const key = queryKey(query, opts);
      let hit = cache.get(key);
      if (!hit) {
        queries.push(query.trim());
        hit = provider.search(query.trim(), opts);
        hit.catch(() => cache.delete(key));
        cache.set(key, hit);
      }
      return hit;
    },
  };
}
