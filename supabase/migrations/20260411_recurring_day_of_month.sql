-- Fix recurring dia 31: preserva o dia desejado para evitar pular fevereiro
--
-- Antes: Math.min(day, 28) no webhook + setMonth() no process-recurring.
-- Problema: cliente pede "aluguel dia 31" → dia virava 28 → toda fatura no dia 28.
-- Ou: aluguel dia 31 Jan → setMonth → vira 3 Mar (pulou Fev).
--
-- Agora: gravamos o dia desejado original, e calcNextDate usa a última data
-- válida do mês quando o dia desejado não existe (ex: dia 31 em Fev → dia 28).

ALTER TABLE public.recurring_transactions
  ADD COLUMN IF NOT EXISTS day_of_month INTEGER;

COMMENT ON COLUMN public.recurring_transactions.day_of_month IS
  'Dia do mês desejado para frequência monthly. Se o mês não tem esse dia (ex: 31 em fev), usa o último dia do mês. NULL para frequências não-monthly ou monthly sem dia específico.';

-- Backfill: para recorrentes monthly existentes, extrai o dia do next_date atual
UPDATE public.recurring_transactions
SET day_of_month = EXTRACT(DAY FROM next_date)::INTEGER
WHERE frequency = 'monthly' AND day_of_month IS NULL;
