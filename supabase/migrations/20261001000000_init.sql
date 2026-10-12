-- Foundation schema: company library, research job queue, saved comparison sets.
-- Nested research data lives in JSONB (spec §3 allows JSON columns over child tables).

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- companies ----------------------------------------------------------------

create table companies (
  id              text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),  -- stable slug, e.g. "dtales"
  name            text not null check (length(trim(name)) > 0),
  domain          text,
  category        text,
  tagline         text,
  linkedin        text,
  researched_at   timestamptz,

  -- Pillar score = plain average of its four sub-metrics (computed by the scoring engine).
  -- Never combined into one composite.
  seo_score       numeric(5,2) check (seo_score between 0 and 100),
  aeo_score       numeric(5,2) check (aeo_score between 0 and 100),
  geo_score       numeric(5,2) check (geo_score between 0 and 100),

  -- { "metrics": { "<metricKey>": { "score": 0-100, "signals": {...} } } }
  seo_data        jsonb not null default '{}'::jsonb,
  aeo_data        jsonb not null default '{}'::jsonb,
  geo_data        jsonb not null default '{}'::jsonb,

  evidence        jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  recommendations jsonb not null default '[]'::jsonb check (jsonb_typeof(recommendations) = 'array'),
  hidden_assets   jsonb not null default '[]'::jsonb check (jsonb_typeof(hidden_assets) = 'array'),
  sources         jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),

  search_text     text generated always as (lower(name || ' ' || coalesce(domain, ''))) stored,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index companies_domain_key on companies (lower(domain)) where domain is not null;
create index companies_search_text_idx on companies (search_text);

create trigger companies_updated_at before update on companies
  for each row execute function set_updated_at();

-- research_jobs ------------------------------------------------------------

create table research_jobs (
  id              uuid primary key default gen_random_uuid(),
  company_name    text not null check (length(trim(company_name)) > 0),
  company_domain  text,
  status          text not null default 'queued' check (status in (
                    'queued', 'resolving', 'detecting_category', 'finding_competitors',
                    'researching', 'scoring', 'synthesizing', 'completed', 'failed')),
  progress        smallint not null default 0 check (progress between 0 and 100),
  current_step    text,
  error           text,
  company_id      text references companies (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

-- Worker pick-up and "is this company already being researched?" lookups.
create index research_jobs_active_idx on research_jobs (lower(company_name))
  where status not in ('completed', 'failed');
create index research_jobs_queued_idx on research_jobs (created_at) where status = 'queued';

-- comparison_sets ----------------------------------------------------------

create table comparison_sets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  company_ids     text[] not null check (cardinality(company_ids) between 1 and 10),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger comparison_sets_updated_at before update on comparison_sets
  for each row execute function set_updated_at();

-- Security -----------------------------------------------------------------
-- RLS on with no policies: anon/authenticated keys get nothing. Only the backend's
-- service-role key (which bypasses RLS) can read or write.

alter table companies       enable row level security;
alter table research_jobs   enable row level security;
alter table comparison_sets enable row level security;
