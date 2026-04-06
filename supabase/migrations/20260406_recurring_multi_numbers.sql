-- ============================================================
-- 1. TRANSAÇÕES RECORRENTES
-- ============================================================
CREATE TABLE IF NOT EXISTS recurring_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  category        TEXT NOT NULL DEFAULT 'outros',
  frequency       TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  next_date       DATE NOT NULL,
  last_processed  DATE,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE recurring_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own recurring"
  ON recurring_transactions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 2. MÚLTIPLOS NÚMEROS DE WHATSAPP (PLANO BUSINESS)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_phone_numbers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  label        TEXT,                        -- "Pessoal", "Trabalho", etc.
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(phone_number)
);

ALTER TABLE user_phone_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own phone numbers"
  ON user_phone_numbers FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Limite por plano (enforced via trigger)
CREATE OR REPLACE FUNCTION check_phone_number_limit()
RETURNS TRIGGER AS $$
DECLARE
  plan TEXT;
  count_existing INT;
  max_allowed INT;
BEGIN
  SELECT profiles.plan INTO plan FROM profiles WHERE id = NEW.user_id;
  SELECT COUNT(*) INTO count_existing FROM user_phone_numbers WHERE user_id = NEW.user_id;

  max_allowed := CASE plan
    WHEN 'business' THEN 5
    WHEN 'pro'      THEN 2
    ELSE                 1
  END;

  IF count_existing >= max_allowed THEN
    RAISE EXCEPTION 'Limite de % números atingido para o plano %', max_allowed, plan;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_phone_limit
  BEFORE INSERT ON user_phone_numbers
  FOR EACH ROW EXECUTE FUNCTION check_phone_number_limit();

-- ============================================================
-- 3. CONFIGURAÇÕES DE RELATÓRIO (em agent_configs)
-- ============================================================
-- Adiciona colunas de relatório automático em agent_configs se não existirem
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS weekly_report  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_report BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 4. PG_CRON: Relatório semanal (toda segunda às 08:00)
-- ============================================================
-- Execute estes após habilitar pg_cron e pg_net no Supabase:
/*
SELECT cron.schedule(
  'weekly-report',
  '0 8 * * 1',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/send-report?type=weekly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'monthly-report',
  '0 8 1 * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/send-report?type=monthly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'process-recurring',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/process-recurring',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
*/
