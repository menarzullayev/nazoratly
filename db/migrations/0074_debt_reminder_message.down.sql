-- 0074_debt_reminder_message (down)
DROP FUNCTION outbox_reminder_facts(bigint);
-- NOT VALID: notifications already written stay readable; no new `paid_claim` row can be added
ALTER TABLE staff_notifications DROP CONSTRAINT staff_notifications_kind_check;
ALTER TABLE staff_notifications ADD CONSTRAINT staff_notifications_kind_check
  CHECK (kind IN ('lesson_unmarked','unmarked_digest')) NOT VALID;
ALTER TABLE org_settings DROP COLUMN pay_info;
