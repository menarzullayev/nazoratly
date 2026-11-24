-- 0067_staff_notifications (down)
DO $$ BEGIN IF to_regclass('branch_catalog') IS NOT NULL THEN DELETE FROM branch_catalog WHERE table_name = 'staff_notifications'; END IF; END $$;
DROP FUNCTION staff_notice_complete(bigint, boolean, text, integer, boolean);
DROP FUNCTION staff_notice_claim(integer);
DROP FUNCTION lesson_reminded(bigint);
DROP FUNCTION active_org_ids();
DROP TABLE staff_notifications;
