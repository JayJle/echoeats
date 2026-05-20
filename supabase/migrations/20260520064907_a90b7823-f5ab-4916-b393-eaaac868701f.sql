
ALTER TABLE public.search_sessions
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS lang text,
  ADD COLUMN IF NOT EXISTS result_count int,
  ADD COLUMN IF NOT EXISTS had_error boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS error_stage text;

ALTER TABLE public.search_feedback
  ADD COLUMN IF NOT EXISTS rating int,
  ADD COLUMN IF NOT EXISTS chosen_reasons text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS would_recommend boolean,
  ADD COLUMN IF NOT EXISTS contact text;

ALTER TABLE public.search_feedback
  ADD CONSTRAINT search_feedback_rating_range CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));

ALTER TABLE public.search_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny all sessions" ON public.search_sessions;
DROP POLICY IF EXISTS "deny all feedback" ON public.search_feedback;

CREATE POLICY "deny all sessions" ON public.search_sessions FOR SELECT TO anon, authenticated USING (false);
CREATE POLICY "deny all feedback" ON public.search_feedback FOR SELECT TO anon, authenticated USING (false);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON public.search_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON public.search_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_session_id ON public.search_feedback (session_id);
