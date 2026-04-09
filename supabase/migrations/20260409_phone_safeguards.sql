-- Phone safeguards: change counter + account_status consistency

-- Track how many times the user has changed their phone number
-- 0 = never set | 1 = set once (can change once more) | 2+ = locked
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_changes_count INTEGER NOT NULL DEFAULT 0;

-- When phone is cleared (set to NULL), automatically revert account to pending
-- so the next time they add a number, it reactivates properly.
CREATE OR REPLACE FUNCTION sync_account_status_on_phone_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Phone was cleared → revert to pending so next save re-activates
  IF NEW.phone_number IS NULL AND OLD.phone_number IS NOT NULL THEN
    NEW.account_status = 'pending';
  END IF;

  -- Phone was set/changed to a valid number AND account was pending → activate
  IF NEW.phone_number IS NOT NULL AND OLD.phone_number IS DISTINCT FROM NEW.phone_number
     AND NEW.account_status = 'pending' THEN
    NEW.account_status = 'active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Only create trigger if it doesn't exist yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_phone_account_status_sync'
  ) THEN
    CREATE TRIGGER trg_phone_account_status_sync
      BEFORE UPDATE OF phone_number ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION sync_account_status_on_phone_change();
  END IF;
END $$;
