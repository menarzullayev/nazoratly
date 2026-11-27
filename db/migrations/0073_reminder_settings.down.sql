-- 0073_reminder_settings (down)
ALTER TABLE org_settings DROP COLUMN installment_remind_days;
ALTER TABLE org_settings DROP COLUMN reminder_template;
ALTER TABLE org_settings DROP COLUMN reminder_min_overdue;
ALTER TABLE org_settings DROP COLUMN reminder_cooldown_days;
