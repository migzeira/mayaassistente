
-- Admin can read error_logs
CREATE POLICY "Admin can read all error_logs"
ON public.error_logs
FOR SELECT
TO authenticated
USING (auth.email() = 'migueldrops@gmail.com');

-- Admin can read kirvano_payments
CREATE POLICY "Admin can read all kirvano_payments"
ON public.kirvano_payments
FOR SELECT
TO authenticated
USING (auth.email() = 'migueldrops@gmail.com');

-- Enable RLS on error_logs and kirvano_payments
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kirvano_payments ENABLE ROW LEVEL SECURITY;

-- Admin can read all events
-- (already exists per schema, skip)

-- Admin can read all reminders
CREATE POLICY "Admin can read all reminders"
ON public.reminders
FOR SELECT
TO authenticated
USING (auth.email() = 'migueldrops@gmail.com');

-- Admin can update profiles (for plan changes, suspend)
CREATE POLICY "Admin can update all profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (auth.email() = 'migueldrops@gmail.com');
