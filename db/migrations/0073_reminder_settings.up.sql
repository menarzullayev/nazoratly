-- 0073_reminder_settings (up)
-- Why: parity with the Sheets edition's debt reminder drafts (menu "Eslatma loyihalarini yaratish"). These are the same
--   four settings with the same defaults. They are center-wide (a branch cannot override them, as in Sheets).

ALTER TABLE org_settings ADD COLUMN reminder_cooldown_days INTEGER NOT NULL DEFAULT 7
  CHECK (reminder_cooldown_days BETWEEN 0 AND 365);
ALTER TABLE org_settings ADD COLUMN reminder_min_overdue BIGINT NOT NULL DEFAULT 50000
  CHECK (reminder_min_overdue BETWEEN 0 AND 1000000000);
ALTER TABLE org_settings ADD COLUMN reminder_template TEXT
  CHECK (reminder_template IS NULL OR length(reminder_template) BETWEEN 1 AND 2000);
ALTER TABLE org_settings ADD COLUMN installment_remind_days INTEGER NOT NULL DEFAULT 3
  CHECK (installment_remind_days BETWEEN 0 AND 30);
