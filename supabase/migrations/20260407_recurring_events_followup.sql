-- =============================================
-- Recorrência de eventos + followup pós-evento
-- =============================================

-- Referência ao evento-pai para séries recorrentes
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS recurrence_parent_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

-- Indica se Maya deve perguntar "aconteceu?" após o evento
-- NULL = automático (baseado no event_type), true = sempre, false = nunca
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS needs_followup boolean;

-- Índice para buscas por série (todos os filhos de um evento recorrente)
CREATE INDEX IF NOT EXISTS idx_events_recurrence_parent
  ON public.events (recurrence_parent_id)
  WHERE recurrence_parent_id IS NOT NULL;
