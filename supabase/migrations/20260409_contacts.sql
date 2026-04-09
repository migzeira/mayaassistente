-- Tabela de contatos compartilhados via WhatsApp
create table if not exists contacts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  name        text not null,
  phone       text not null,
  notes       text,
  source      text not null default 'whatsapp', -- 'whatsapp' | 'manual'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Evita duplicatas: mesmo user não pode ter mesmo telefone duas vezes
create unique index if not exists contacts_user_phone_idx on contacts (user_id, phone);
create index if not exists contacts_user_name_idx on contacts (user_id, lower(name));

-- RLS: cada usuário vê e gerencia apenas seus próprios contatos
alter table contacts enable row level security;

create policy "contacts_select_own" on contacts
  for select using (auth.uid() = user_id);

create policy "contacts_insert_own" on contacts
  for insert with check (auth.uid() = user_id);

create policy "contacts_update_own" on contacts
  for update using (auth.uid() = user_id);

create policy "contacts_delete_own" on contacts
  for delete using (auth.uid() = user_id);

-- Atualiza updated_at automaticamente
create or replace function update_contacts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contacts_updated_at
  before update on contacts
  for each row execute function update_contacts_updated_at();
