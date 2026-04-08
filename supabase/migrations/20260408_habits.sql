-- Modulo de Habitos/Rotina

-- Definicao dos habitos
CREATE TABLE IF NOT EXISTS public.habits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  frequency TEXT NOT NULL DEFAULT 'daily',
  times_per_day INTEGER NOT NULL DEFAULT 1,
  reminder_times JSONB NOT NULL DEFAULT '["08:00"]'::jsonb,
  target_days JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,0]'::jsonb,
  icon TEXT NOT NULL DEFAULT '🎯',
  color TEXT NOT NULL DEFAULT '#6366f1',
  is_active BOOLEAN NOT NULL DEFAULT true,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logs de check-in
CREATE TABLE IF NOT EXISTS public.habit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id UUID NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  logged_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  UNIQUE(habit_id, logged_date)
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_habits_user ON public.habits(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON public.habit_logs(habit_id, logged_date DESC);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user ON public.habit_logs(user_id, logged_date DESC);

-- RLS habits
ALTER TABLE public.habits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own habits" ON public.habits FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own habits" ON public.habits FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own habits" ON public.habits FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own habits" ON public.habits FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Service role habits" ON public.habits FOR ALL USING (true) WITH CHECK (true);

-- RLS habit_logs
ALTER TABLE public.habit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own habit_logs" ON public.habit_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own habit_logs" ON public.habit_logs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own habit_logs" ON public.habit_logs FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Service role habit_logs" ON public.habit_logs FOR ALL USING (true) WITH CHECK (true);

-- Adiciona module_habits ao agent_configs
ALTER TABLE public.agent_configs ADD COLUMN IF NOT EXISTS module_habits BOOLEAN NOT NULL DEFAULT true;
