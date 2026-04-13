-- Fix: remover/limpar número NÃO muda account_status.
-- Plano ativo continua ativo. Uma coisa não interfere na outra.
-- Antes: limpar phone -> forçava account_status='pending' (perdia o plano).

CREATE OR REPLACE FUNCTION sync_account_status_on_phone_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Nenhuma mudança de phone_number afeta account_status.
  -- Plano é controlado exclusivamente pelo admin ou Kirvano webhook.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
