-- Habits v2: preset_key, habit_config, and habit_id on reminders

-- Enrich habits table with preset metadata
ALTER TABLE public.habits
  ADD COLUMN IF NOT EXISTS preset_key TEXT,
  ADD COLUMN IF NOT EXISTS habit_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One preset per user — prevents duplicates from race conditions or re-activation bugs
CREATE UNIQUE INDEX IF NOT EXISTS idx_habits_user_preset_unique
  ON public.habits(user_id, preset_key)
  WHERE preset_key IS NOT NULL;

-- Link reminders to habits (ON DELETE SET NULL so reminder survives habit deletion)
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS habit_id UUID REFERENCES public.habits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reminders_habit_id
  ON public.reminders(habit_id)
  WHERE habit_id IS NOT NULL;

-- ── RLS: allow users to delete their own reminders (needed for habit deactivation) ──
-- (The original migration only had SELECT/INSERT/UPDATE policies)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reminders'
      AND policyname = 'Users can delete own reminders'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Users can delete own reminders"
        ON public.reminders FOR DELETE
        USING (auth.uid() = user_id);
    $policy$;
  END IF;
END $$;

-- ── Streak reset function: called nightly by pg_cron ──
-- Resets current_streak to 0 for habits that had no check-in yesterday.
-- Run daily at 03:00 UTC (00:00 Brazil time).
CREATE OR REPLACE FUNCTION reset_missed_streaks()
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.habits h
  SET current_streak = 0
  WHERE h.is_active = true
    AND h.current_streak > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.habit_logs hl
      WHERE hl.habit_id = h.id
        AND hl.logged_date = (CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '1 day'
    );
$$;

-- Schedule streak reset daily at 03:00 UTC (midnight Brazil)
-- Only runs if pg_cron extension is available
SELECT cron.schedule(
  'reset-habit-streaks',
  '0 3 * * *',
  $$SELECT reset_missed_streaks();$$
) WHERE EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
ON CONFLICT DO NOTHING;
