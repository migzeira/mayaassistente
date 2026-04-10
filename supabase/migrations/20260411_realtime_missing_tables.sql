-- Fix: adiciona tabelas faltantes no supabase_realtime
-- Sem isso, criar budget/recurring/categoria via WhatsApp não refletia
-- no dashboard até o usuário dar refresh.
--
-- Uso DO block pra evitar erro se as tabelas já estiverem na publication
-- (idempotente — seguro rodar múltiplas vezes).

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.budgets;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.recurring_transactions;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.categories;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
