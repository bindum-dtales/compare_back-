# LinkEye — backend

Express + TypeScript API for the SEO · AEO · GEO dashboard. It talks to Supabase (Postgres)
with the service-role key, so **only this server** holds that key. The frontend calls this API
and never calls Supabase or any research provider directly.

```
Frontend → routes → controllers (validate) → services (logic) → repositories → Supabase
                                                    ↑
        research worker → ResearchSteps → Jina Reader · Groq (LLM) · Tavily (search)
```

## Setup

```bash
cp .env.example .env      # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev               # http://localhost:4000, reloads on change
```

| Script          | What it does                                     |
| --------------- | ------------------------------------------------ |
| `npm run dev`   | tsx watch, loads `.env`                          |
| `npm run build` | compile to `dist/`                               |
| `npm start`     | run `dist/server.js`, loads `.env`               |
| `npm test`      | vitest (offline: repositories are faked in-memory) |
| `npm run lint`  | eslint + `tsc --noEmit`                          |
| `npm run typecheck` | `tsc --noEmit`                               |

## Environment

| Var                         | Required | Notes                                         |
| --------------------------- | -------- | --------------------------------------------- |
| `NODE_ENV`                  | no       | `development` (default) / `production`. Set `production` on the server |
| `PORT`                      | no       | default `4000`                                |
| `HOST`                      | no       | interface to bind; unset = all interfaces. `127.0.0.1` behind Nginx on the same host |
| `FRONTEND_URL`              | no       | CORS allow-list: comma-separated exact origins (`https://score.example.com`, no path, no `*`). Unset: `http://localhost:3000` in development, none in production. Only needed when a browser calls the API cross-origin; the frontend's `/api` proxy is same-origin |
| `SUPABASE_URL`              | yes      | `https://<ref>.supabase.co`                   |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | server-only, never ship to the browser        |
| `JINA_API_KEY`              | no*      | raises Jina Reader's rate limit (≈20 → more req/min). *Needed for sites that render with JavaScript (keyless Jina returns the unrendered HTML) and for the hidden-assets raw-vs-rendered diff |
| `TAVILY_API_KEY`            | for research | competitor search + scoring searches; jobs fail at those stages without it |
| `GROQ_API_KEY`              | for research | category, competitor classification, evidence + recommendation wording |
| `GROQ_MODEL`                | no       | default `openai/gpt-oss-120b` (must support strict structured outputs) |

## Migrations

SQL lives in `supabase/migrations/`. Either:

```bash
npx supabase link --project-ref <ref>   # once
npx supabase db push
```

or with the database connection string (Supabase → Project Settings → Database):

```bash
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Verify with `GET /health/db`.

Tables have RLS on and no policies, so only the service role can read or write them.

## API

All responses are `{ success: true, data }` or
`{ success: false, error: { code, message, details? } }`.

| Method | Path                     | Body                                   | Notes |
| ------ | ------------------------ | -------------------------------------- | ----- |
| GET    | `/health`                |                                        | liveness |
| GET    | `/health/db`             |                                        | Supabase reachable + migrated |
| GET    | `/api/companies`         |                                        | `CompanyResearch[]` |
| GET    | `/api/companies/:id`     |                                        | `id` is a slug, e.g. `dtales-tech` |
| POST   | `/api/companies/search`  | `{ query }`                            | `{ results: CompanyResearch[], researched }` |
| POST   | `/api/research`          | `{ companyName, domain }` (both required) | 200 `{ status: "existing", company }` or 202 `{ status: "queued" \| "in_progress", job }` |
| GET    | `/api/research/:jobId`   |                                        | job status + progress 0–100 for polling; `error: { code, message } \| null` |
| POST   | `/api/comparisons`       | `{ name, companyIds }`                 | 201, returns set with hydrated companies |
| GET    | `/api/comparisons/:id`   |                                        | |
| PUT    | `/api/comparisons/:id`   | `{ name?, companyIds? }`               | |
| DELETE | `/api/comparisons/:id`   |                                        | 204 |

`CompanyResearch` matches `front/lib/types.ts` (same pillar/metric keys: `directAnswer`,
`thirdParty`, `brandScale`, `clarity`), plus `tagline`, `linkedin`, `researchedAt` and
per-company `recommendations` from the spec.

## Company identity: the domain

A research request is always `{ companyName, domain }`; the user-supplied URL is the target
and is never swapped for one found by search. `src/utils/domain.ts` normalizes it to the
bare lower-case hostname, which is what `companies.domain` and `research_jobs.company_domain` store:

| Input                                   | Stored         |
| --------------------------------------- | -------------- |
| `https://dtales.tech`, `https://dtales.tech/`, `http://dtales.tech` | `dtales.tech` |
| `https://www.dtales.tech/about?x=1#top`, `dtales.tech:8443`        | `dtales.tech` |
| `https://blog.dtales.tech`                                          | `blog.dtales.tech` (other subdomains kept) |

Rules: http/https only (scheme optional, https assumed); port, path, query, fragment and
credentials dropped; one leading `www.` stripped; trailing dot removed; IDNs punycoded.
Rejected: unparseable input, other schemes, IP addresses, `localhost`/single-label hosts
(the engine will fetch this host, so no internal targets).

- **Existing company** is looked up by normalized domain, not name. Same name on a different
  domain is a different company (its id becomes `name-domain`, e.g. `acme-acme-co-uk`).
- **Running job**: at most one queued/running job per domain (partial unique index); a repeat
  request returns that job with `status: "in_progress"`.
- The pipeline receives `{ jobId, companyName, domain }`; the orchestrator re-imposes the job's
  domain after `resolveCompany`, and drops competitors whose domain equals the target's or repeats.

## Scoring

`src/utils/scoring.ts`: each pillar is the plain average of its four sub-metrics (spec §4).
No weights, no composite across pillars.

Sub-metrics (`src/services/scoring/`) are equal-weight checklists of the signals spec §4/§5 names
for each: score = round(100 × mean of the measured checks). A pass/fail check is 1/0; a count check is
`min(count / cap, 1)`. All caps live in `rubric.ts` (`CAPS`). A check that couldn't be measured (fetch
failed, robots.txt unknown) is `null` and left out; something the site simply lacks scores 0.

| Pillar | Sub-metric | Checks | Data |
| --- | --- | --- | --- |
| SEO | technical | HTTP 2xx · not noindex · canonical on own domain · robots.txt allows Googlebot/Bingbot · XML sitemap | homepage, robots.txt, sitemap |
| SEO | content | blog/resources/case-study section · content pages (cap 20) · pages updated in last 12 months (cap 12) | sitemap + homepage links |
| SEO | backlinks | distinct third-party sites naming the brand in the top 10 results (cap 10) — *proxy* | search `"Name"` |
| SEO | ranking | named in a third-party result for each of `best X`, `top X providers`, `X comparison` | search, once per job |
| AEO | structured | JSON-LD present · FAQPage · Article schema | homepage JSON-LD |
| AEO | directAnswer | question headings (cap 3) · share followed by a concise (5–60 word) answer | homepage headings |
| AEO | snippet | rich-result schema · a question heading with a concise answer — *inferred, as in the prototype* | the two above |
| AEO | crawlability | not noindex · robots.txt allows GPTBot, ClaudeBot, PerplexityBot, CCBot | homepage, robots.txt |
| GEO | thirdParty | a page on each of G2, Capterra, Clutch, GoodFirms naming the company — *proxy* | search, those 4 domains |
| GEO | brandScale | LinkedIn followers, log scale, full at 100 000 — *proxy* | site's LinkedIn link + search |
| GEO | freshness | © current year · newest sitemap lastmod ≤ 90 days · content updated in last 90 days (cap 3) | homepage, sitemap |
| GEO | clarity | no redirect to another domain · sub-domains linked (0 at 3) · other brand domains linked (0 at 3) | homepage links |

Each metric is stored as `{ score, signals: { checks: [{ id, label, value, detail }], notMeasured, proxy? } }`
in `seo_data` / `aeo_data` / `geo_data`, so every score shows which checks produced it, which spec signals
aren't collected (e.g. JS-render diff, HTTP Last-Modified, paid backlink/SERP/LinkedIn APIs) and when it's a proxy.

**Evidence** (`scoring/evidence.ts`, spec §5: the step that stays LLM-driven): one bullet per sub-metric.
The model only words the observed facts; each bullet must cite that metric's check ids (`checkIds`),
numbers not in the facts get the bullet dropped, sentiment comes from the cited checks' results, and a
metric left without a valid bullet gets one built from its check details.

## Research engine

`POST /api/research` only inserts a `queued` job and returns 202. The **worker**
(`src/workers/research.worker.ts`, started by `server.ts`) runs in the same process:

- polls every 5 s (and is woken immediately when a job is queued), one job at a time;
- claims a job with a conditional `UPDATE … WHERE status = 'queued'`, so a job runs once even
  with several server instances;
- fails jobs stuck mid-flight for 15 min (`RESEARCH_INTERRUPTED`), freeing the domain.

`researchCompany(jobId, steps)` (`src/services/research.service.ts`) then runs:

| Status                | Progress | Step |
| --------------------- | -------- | ---- |
| `resolving`           | 10       | target = the job's normalized domain (never rediscovered) |
| `researching`         | 20–30    | Jina Reader: `https://<domain>/` (rendered HTML) + `/robots.txt` → `companies.website_data` |
| `detecting_category`  | 40       | LLM over the website facts → `companies.category` + `discovery_data.category` |
| `finding_competitors` | 55       | "Searching for competitors": ≤ 3 Tavily queries built from the category |
| `finding_competitors` | 70       | "Selecting competitors": rules, then LLM for ambiguous candidates |
| `finding_competitors` | 80       | "Saving competitors" → `companies.discovery_data` |
| `researching`         | 85–99    | per company (target, then each competitor): "Fetching <domain>" (competitors only, → `website_data`), "Collecting signals for <name>" (sitemap via Jina + scoring searches) |
| `scoring`             | 85–99    | "Scoring <name>" → `*_score`, `*_data`, `sources`, `linkedin` |
| `synthesizing`        | 85–99    | "Generating evidence for <name>" → `evidence`; "Checking hidden assets for <name>" → `hidden_assets`, `website_data.hiddenAssetsCheck` |
| `synthesizing`        | 99       | "Generating recommendations" (every scored company, benchmarked against the others) → `recommendations`, then `researched_at` |
| `completed`           | 100      | `company_id` set |

On failure the job is `failed` with a user-safe `error_code` + `error`, returned as `error: { code, message }`:
`WEBSITE_RESEARCH_FAILED`, `CATEGORY_DETECTION_FAILED`, `COMPETITOR_SEARCH_FAILED`,
`COMPETITOR_SELECTION_FAILED`, `SCORING_FAILED`, `EVIDENCE_GENERATION_FAILED`, `HIDDEN_ASSETS_FAILED`,
`RECOMMENDATIONS_FAILED` (the last three keep the scores already saved)
(or `RESEARCH_INTERRUPTED` from the stale sweep). The target must be scored for the job to complete; a
competitor that can't be scored is skipped and logged. Messages are fixed
text chosen by failure kind (`src/services/job-errors.ts`); upstream details are logged only.
Each stage's output is saved as it completes, so a later failure keeps earlier results.

**Jina** (`src/services/jina.service.ts`): keyless (≈20 req/min), `JINA_API_KEY` optional.
45 s timeout per request, one retry for timeouts/network/429/5xx, none for 4xx. A site 4xx/5xx
(reported by Jina inside a 200) fails the job. robots.txt is optional (unknown → `null`).
Only `fetchWebsite({ domain })` is exported and it refuses non-normalized domains; our server never
connects to the target host itself.

**Website facts** (`src/services/website-analysis.ts`): title, meta description, `lang`, canonical,
meta robots, `og:*`/`twitter:*`, h1–h6, unique http(s) links, JSON-LD, robots.txt (`Sitemap:` URLs),
visible text (≤ 20 000 chars), word count. Unknown values are `null`, never guessed.

**LLM** (`src/services/llm.service.ts`, Groq in `providers/groq.provider.ts`): strict JSON-schema
structured output (`GROQ_MODEL`, default `openai/gpt-oss-120b`), `include_reasoning: false` so no
model reasoning is received or stored, temperature 0, output re-validated with zod. 60 s timeout,
one retry on timeout/429/5xx. Used only to interpret facts, never to score.

**Category** (`src/services/category.service.ts`): needs ≥ 40 words of site text (else no LLM call);
the model must quote supporting phrases, and quotes not found in the collected text are dropped
(none left → rejected); one-word generic categories are rejected; confidence < 0.5 fails the stage.

**Search** (`src/services/search.service.ts`, Tavily in `providers/tavily.provider.ts`):
`SearchProvider.search(query)`; a per-job `SearchSession` never sends the same query twice.
Basic depth (1 credit), 10 results, known directories/social/search engines/the target excluded at
the provider; 30 s timeout, one retry on timeout/429/5xx; 432/433 → quota exceeded.

**Competitors** (`src/services/competitor.service.ts`, rules in `candidates.ts`):
1. Queries from the category, most specific first; stops early at 8 viable candidates.
2. Each result URL → normalized domain; dropped: invalid URLs/IPs/localhost, the target and its
   subdomains, search engines, social profiles, directories/review sites, marketplaces, publications,
   free-hosting subdomains. Duplicate domains are merged.
3. Signals per candidate: share of category terms in title + snippet, homepage or inner page,
   list/comparison-article title, search score.
4. Homepage + ≥ 60 % of category terms + not a list article → accepted by rule; inner page with no
   category term → rejected by rule; everything else → one LLM call classifying ≤ 12 candidates
   (`isCompetitor`, `confidence`, one-sentence `reason`; accepted at ≥ 0.6). The LLM can only judge
   candidates it was given.
5. Rule-accepted first, then by confidence: up to 4. Fewer than 2 is stored with a `note`; never padded.

`discovery_data` keeps the category detail, the selected competitors (name, domain, url, category,
source, discovery evidence), every evaluated candidate with verdict and reason, the dropped results
and the searches run. Competitors become companies rows when they are scored (below).

Each selected competitor is researched and scored with the same steps and rubric as the target, and saved
as its own `companies` row (category = the target's, unless it already had one).

A company keeps `researched_at = null` until scored, given evidence, checked for hidden assets and given
recommendations, so an incomplete record is re-run by the next request. A competitor that fails any of
these is logged, left incomplete and left out of the others' benchmark; the job still completes.

## Hidden assets

`src/services/hidden-assets.ts` (spec §7), on the homepage, two passes through Jina (our server still never
connects to the target):

1. raw HTML: `X-Engine: direct`, no JavaScript — what crawlers parse;
2. visible text: `X-Engine: browser` + text format (innerText after JS and CSS). **Needs `JINA_API_KEY`**:
   keyless Jina doesn't render and silently returns unrendered text, so without a key this pass is skipped.

| Finding | Rule | `kind` | `severity` |
| --- | --- | --- | --- |
| Hidden text | a raw-HTML text block (p, li, h1–h6, blockquote, figcaption, td, dd) of ≥ 8 words missing from the visible text (compared on letters/digits only) | `hidden-content` | medium (may be intentional collapsed UI, §11) |
| Placeholder copy | `lorem ipsum`, `john doe`, `test test`, `TODO` in text, alt/title, `<title>` or description/og/twitter meta (not scripts, styles or form placeholders) | `hidden-content` | high |
| Non-production host | a URL in href/src/srcset/data-src/poster/action/content/inline style on `staging.*`, `dev.*` (sub-domains), `localhost`, or an internal IP; grouped per host | `staging-leak` | high |

The regex checks always run; the diff only with a rendered pass. Up to 10 findings per kind. How it ran is in
`website_data.hiddenAssetsCheck` (`{ pages, diff: { ran, reason, blocksCompared }, checkedAt }`), so an empty
`hidden_assets` with `diff.ran = false` means "regex checks clean, diff not run", not "clean".
`orphan-page` / `noindex-conflict` (dashboard kinds outside §7) are not produced.

## Recommendations

`src/services/recommendations.ts`, from the scoring checks already collected:

- one per sub-metric with weak checks (measured, value < 1); unknown checks never count;
- `current` = the sub-metric score; `target` = its score if those checks were met (rubric);
- `impact` = gap to the best other scored company on that sub-metric: ≥ 20 high, ≥ 10 medium, else low
  (the dashboard's thresholds); with no scored competitor, the points recoverable (`target − current`);
- ordered by impact, then points recoverable; `metric` = e.g. `"SEO · Technical"`; `checkIds` = the checks addressed.

The LLM only writes `title` / `explanation` / `action` from the weak checks and the benchmark leader.
Wording that cites a check outside the weak ones, or a number not in the facts, is replaced by text built
from the checks.
