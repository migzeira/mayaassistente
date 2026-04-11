-- FIX: Corrige header do CRON job para usar x-cron-secret em vez de Authorization
-- O problema: CRON estava enviando "Authorization: Bearer ..."
-- Mas send-reminder espera "x-cron-secret: ..."
-- Resultado: 401 Unauthorized, nenhum lembrete era enviado

-- Remove job com header errado
SELECT cron.unschedule('send-reminders-every-minute')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'send-reminders-every-minute'
);

-- Recria job com header correto
SELECT cron.schedule(
  'send-reminders-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fnilyapvhhygfzcdxqjm.supabase.co/functions/v1/send-reminder',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', 'maya-cron-secret-2026'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
