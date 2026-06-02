-- review_cache: server-only (service role bypasses RLS)
CREATE POLICY "deny all review_cache select" ON public.review_cache FOR SELECT TO anon, authenticated USING (false);
CREATE POLICY "deny all review_cache insert" ON public.review_cache FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "deny all review_cache update" ON public.review_cache FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny all review_cache delete" ON public.review_cache FOR DELETE TO anon, authenticated USING (false);

-- tabelog_cache: server-only
CREATE POLICY "deny all tabelog_cache select" ON public.tabelog_cache FOR SELECT TO anon, authenticated USING (false);
CREATE POLICY "deny all tabelog_cache insert" ON public.tabelog_cache FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "deny all tabelog_cache update" ON public.tabelog_cache FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny all tabelog_cache delete" ON public.tabelog_cache FOR DELETE TO anon, authenticated USING (false);

-- search_feedback: server-only insert via admin client
CREATE POLICY "deny all feedback insert" ON public.search_feedback FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "deny all feedback update" ON public.search_feedback FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny all feedback delete" ON public.search_feedback FOR DELETE TO anon, authenticated USING (false);

-- search_sessions: server-only insert via admin client
CREATE POLICY "deny all sessions insert" ON public.search_sessions FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "deny all sessions update" ON public.search_sessions FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny all sessions delete" ON public.search_sessions FOR DELETE TO anon, authenticated USING (false);