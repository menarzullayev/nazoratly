-- 0034_lead_reminders
-- Why: G3 internal lead follow-up reminders. How many quiet days make an open lead "silent" is a per-center setting; the list
--   itself is computed from leads and lead_interactions on demand (rules/growth.py lead_reminders). Nothing is stored or sent
--   to a lead.
ALTER TABLE org_settings ADD COLUMN lead_reminder_days INTEGER NOT NULL DEFAULT 3
  CHECK (lead_reminder_days BETWEEN 1 AND 60);
