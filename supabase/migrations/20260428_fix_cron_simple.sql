-- Simplifica cron do send-reminder: sem header de autenticação.
-- A edge function não valida secret — é segura por natureza
-- (busca reminders pendentes do banco, não aceita input externo).

DO $$
BEGIN
  PERFORM cron.unschedule('send-reminders-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

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
