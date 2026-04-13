-- Fix: remove segundo cron job que causava lembretes duplicados.
--
-- O job "send-reminders-30s-offset" com pg_sleep(30) não funcionava como
-- esperado — ambos os jobs disparavam quase simultaneamente, fazendo
-- o send-reminder rodar 2x e enviar hábitos em dobro.
--
-- Volta pra 1 job por minuto. Atraso máximo ~60s — aceitável e sem duplicatas.

DO $$
BEGIN
  PERFORM cron.unschedule('send-reminders-30s-offset');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
