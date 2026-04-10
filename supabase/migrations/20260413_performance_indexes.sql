-- Fase B Performance — índices faltando
--
-- bot_metrics: tabela crescente, UserDetailModal do admin faz queries
-- WHERE user_id = X AND created_at >= (now - 30d) ORDER BY created_at DESC
-- Sem índice composto, fazia seq scan na tabela inteira pra cada abertura
-- do modal de detalhes. Com esse índice, é O(log n).
--
-- Idempotente: CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_bot_metrics_user_created
  ON public.bot_metrics(user_id, created_at DESC);
