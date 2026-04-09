-- Tabela de deduplicação atômica de mensagens do WhatsApp
-- Garante que o mesmo messageId seja processado apenas uma vez,
-- mesmo que o Evolution API dispare o webhook duas vezes simultaneamente.

create table if not exists public.processed_messages (
  message_id  text primary key,
  created_at  timestamptz not null default now()
);

-- Limpeza automática de entradas com mais de 48h (evita crescimento ilimitado)
-- Esse índice permite o cleanup eficiente
create index if not exists idx_processed_messages_created
  on public.processed_messages (created_at);

-- RLS: apenas service role pode ler/escrever (webhook usa service role key)
alter table public.processed_messages enable row level security;

-- Nenhuma policy para usuários comuns — acesso exclusivo via service_role
