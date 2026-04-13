-- FIX CRÍTICO: Cron de lembretes estava chamando stored procedure em vez de edge function.
--
-- Problema: alguma sessão anterior mudou o cron pra chamar send_pending_reminders()
-- que faz UPDATE status='sent' SEM enviar WhatsApp. Resultado: lembretes marcados
-- como "enviados" no banco mas NUNCA chegam no WhatsApp do usuário.
--
-- Fix: restaura cron pra chamar o edge function send-reminder via HTTP POST
-- (que realmente envia via Evolution API + recorrência + streaks).

-- Remove job com stored procedure (não envia WhatsApp)
DO $$
BEGIN
  PERFORM cron.unschedule('send-reminders-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Reverte lembretes falsamente marcados como 'sent' nos últimos 3 dias
-- (foram "enviados" pela stored procedure sem realmente mandar)
UPDATE public.reminders SET status = 'pending', sent_at = NULL
WHERE status = 'sent'
  AND sent_at > NOW() - INTERVAL '3 days'
  AND source NOT IN ('daily_briefing');

-- Recria cron chamando o edge function via HTTP POST
-- x-cron-secret lido do vault (se CRON_SECRET estiver configurado).
-- Se não estiver no vault, edge function aceita qualquer chamada (dev mode).
SELECT cron.schedule(
  'send-reminders-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fnilyapvhhygfzcdxqjm.supabase.co/functions/v1/send-reminder',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', COALESCE(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1),
        ''
      )
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
