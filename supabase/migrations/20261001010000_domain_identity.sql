-- Domain becomes the canonical identity of a company and of a research request.
-- Values are stored pre-normalized by the API (src/utils/domain.ts): bare lower-case
-- hostname, no scheme/port/path, leading "www." stripped. The checks below are a backstop.

alter table research_jobs
  alter column company_domain set not null,
  add constraint research_jobs_domain_normalized
    check (company_domain = lower(company_domain) and company_domain !~ '^www\.|[/:\s]');

alter table companies
  alter column domain set not null,
  add constraint companies_domain_normalized
    check (domain = lower(domain) and domain !~ '^www\.|[/:\s]');

-- Plain unique index now that domain is required and already lower-case.
drop index if exists companies_domain_key;
create unique index companies_domain_key on companies (domain);

-- At most one queued/running job per domain; also serves the duplicate lookup.
-- Closes the race where two concurrent requests both see "no active job".
drop index if exists research_jobs_active_idx;
create unique index research_jobs_active_domain_key on research_jobs (company_domain)
  where status not in ('completed', 'failed');
