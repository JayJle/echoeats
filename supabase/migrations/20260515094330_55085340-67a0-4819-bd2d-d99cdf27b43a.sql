alter table public.review_cache enable row level security;
alter table public.tabelog_cache enable row level security;

-- 不创建任何 policy = 默认 deny-all；service_role 自动绕过 RLS
-- 服务端使用 supabaseAdmin（service_role）正常读写