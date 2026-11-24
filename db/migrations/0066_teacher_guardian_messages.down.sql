-- 0066_teacher_guardian_messages (down)
DO $$ BEGIN IF to_regclass('branch_catalog') IS NOT NULL THEN DELETE FROM branch_catalog WHERE table_name = 'teacher_guardian_messages'; END IF; END $$;
DROP TRIGGER trg_teacher_guardian_messages_no_change ON teacher_guardian_messages;
DROP TRIGGER trg_teacher_guardian_messages_no_truncate ON teacher_guardian_messages;
DROP TABLE teacher_guardian_messages;
