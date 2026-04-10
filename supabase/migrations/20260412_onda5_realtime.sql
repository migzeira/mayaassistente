-- Onda 5: adiciona integrations e agent_configs ao supabase_realtime
--
-- Sem isso, conectar integração Google Calendar/Sheets/Notion via OAuth
-- OU mudar configuração do agente no dashboard não refletia em tempo real
-- — usuário precisava dar refresh manualmente pra ver as mudanças.
--
-- Idempotente: DO block com EXCEPTION duplicate_object pra poder rodar 2x.

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.integrations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_configs;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
