-- Category detection + competitor discovery.
--
-- companies.category (existing) gets the detected category name. Everything else lives in one
-- JSON column rather than new tables: the detected category's detail (subcategory, confidence,
-- rationale, verified website evidence), the selected 2–4 competitors with their discovery
-- evidence, every evaluated candidate with its verdict, and the searches run. Competitors become
-- their own companies rows only once they're researched (next phase).
-- Shape: DiscoveryData in src/types/discovery.ts. Null until category detection has run.
--
-- Job statuses are unchanged: detecting_category and finding_competitors already exist.

alter table companies
  add column discovery_data jsonb check (discovery_data is null or jsonb_typeof(discovery_data) = 'object');
