-- Muda cron de lembretes de 1 minuto pra 30 segundos.
--
-- Problema: "me lembra daqui 2 min" era agendado pra 23:53:00 mas o cron
-- só rodava 23:54:00 (próximo tick do minuto) — 1 min de atraso percebido.
-- Com 30s, o atraso máximo cai pra ~30s, imperceptível pro usuário.
--
-- pg_cron não suporta intervalos menores que 1 minuto nativamente,
-- mas pg_cron v1.6+ suporta expressões com segundos: '*/30 * * * * *'
-- Se não suportar, vamos usar 2 jobs defasados por 30s.

-- Remove job antigo
DO $$
BEGIN
  PERFORM cron.unschedule('send-reminders-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('send-reminders-30s-offset');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Job 1: roda no segundo :00 de cada minuto (padrão cron)
SELECT cron.schedule(
  'send-reminders-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fnilyapvhhygfzcdxqjm.supabase.co/functions/v1/send-reminder',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Job 2: roda 30s após o Job 1 (usando pg_sleep pra offset)
-- Resultado: send-reminder é chamado ~2x por minuto = a cada ~30s
SELECT cron.schedule(
  'send-reminders-30s-offset',
  '* * * * *',
  $$
  SELECT pg_sleep(30);
  SELECT net.http_post(
    url     := 'https://fnilyapvhhygfzcdxqjm.supabase.co/functions/v1/send-reminder',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
