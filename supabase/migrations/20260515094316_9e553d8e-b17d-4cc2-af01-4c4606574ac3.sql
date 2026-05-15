create table public.review_cache (
  place_id text primary key,
  city text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create table public.tabelog_cache (
  place_id text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create index review_cache_fetched_at_idx on public.review_cache(fetched_at);
create index tabelog_cache_fetched_at_idx on public.tabelog_cache(fetched_at);