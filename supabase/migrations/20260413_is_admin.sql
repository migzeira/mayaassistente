-- Adiciona coluna is_admin em profiles pra substituir hardcode de email no futuro.
--
-- COMPATIBILIDADE: Não remove o fallback por email ("migueldrops@gmail.com"),
-- apenas permite promover outros usuários sem deploy de código.
-- useAuth.tsx e admin-settings/index.ts continuam aceitando email OR is_admin.
--
-- Backfill: marca o email atual do admin (migueldrops@gmail.com) como is_admin=true.
-- Qualquer novo admin pode ser adicionado via UPDATE profiles SET is_admin=true WHERE email='...'

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Backfill: promove o admin atual
UPDATE public.profiles p
SET is_admin = true
FROM auth.users u
WHERE p.id = u.id
  AND u.email = 'migueldrops@gmail.com';

-- Index pra RLS policies futuras (quando migrarmos pra checar is_admin no banco)
CREATE INDEX IF NOT EXISTS idx_profiles_is_admin ON public.profiles(is_admin) WHERE is_admin = true;
