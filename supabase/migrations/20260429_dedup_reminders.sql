-- Limpa reminders duplicados existentes (mesmo user, titulo, horario, source, status pending).
-- Mantém o mais antigo (menor id), remove os demais.

DELETE FROM reminders a USING reminders b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.title = b.title
  AND a.send_at = b.send_at
  AND a.source = b.source
  AND a.status = 'pending'
  AND b.status = 'pending';

-- Index UNIQUE parcial pra impedir duplicatas futuras:
-- Só 1 reminder pendente por (user, title, send_at, source) de cada vez.
-- Não afeta reminders "sent" ou "cancelled" (podem ter duplicatas históricas).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_no_dup_pending
  ON reminders(user_id, title, send_at, source)
  WHERE status = 'pending';
