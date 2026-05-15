
create table public.search_sessions (
  id uuid primary key default gen_random_uuid(),
  anon_id text not null,
  city text not null,
  cuisines text[] not null default '{}',
  parsed_json jsonb,
  results_snapshot jsonb,
  created_at timestamptz not null default now()
);

create table public.search_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.search_sessions(id) on delete cascade,
  chosen_from_results text,
  chosen_external_name text,
  overall text not null check (overall in ('up','down')),
  down_reasons text[] not null default '{}',
  comment text,
  created_at timestamptz not null default now()
);

create index search_sessions_anon_id_idx on public.search_sessions(anon_id);
create index search_sessions_created_at_idx on public.search_sessions(created_at desc);
create index search_feedback_session_id_idx on public.search_feedback(session_id);
create index search_feedback_created_at_idx on public.search_feedback(created_at desc);

alter table public.search_sessions enable row level security;
alter table public.search_feedback enable row level security;

create policy "anyone can insert sessions" on public.search_sessions
  for insert to anon, authenticated with check (true);

create policy "anyone can insert feedback" on public.search_feedback
  for insert to anon, authenticated with check (true);
