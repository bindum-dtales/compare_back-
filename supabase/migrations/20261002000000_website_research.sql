-- Website research (phase 1 of the engine) and safe job errors.
--
-- website_data: raw facts collected from the company's own site via Jina Reader
-- (title, meta, headings, links, JSON-LD, robots.txt, visible text…). It feeds all three
-- pillars later, so it doesn't belong in seo_data/aeo_data/geo_data, which hold scored
-- metrics. Null until the site has been fetched. Shape: WebsiteResearch in src/types/website.ts.
alter table companies
  add column website_data jsonb check (website_data is null or jsonb_typeof(website_data) = 'object');

-- Machine-readable failure reason next to the existing human-readable `error`,
-- e.g. WEBSITE_RESEARCH_FAILED. Both are safe to show to users (no internals).
alter table research_jobs
  add column error_code text;
