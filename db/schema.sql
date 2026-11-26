CREATE TABLE IF NOT EXISTS public.stem_jobs (
  id UUID PRIMARY KEY,
  original_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  input_key TEXT NOT NULL,
  result_key TEXT,
  source_duration_seconds DOUBLE PRECISION,
  model TEXT NOT NULL DEFAULT 'htdemucs_6s',
  result_manifest JSONB,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS stem_jobs_status_created_idx ON public.stem_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS stem_jobs_created_at_idx ON public.stem_jobs (created_at DESC);
