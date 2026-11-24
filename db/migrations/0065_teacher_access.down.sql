-- 0065_teacher_access (down)
DO $$ BEGIN IF to_regclass('branch_catalog') IS NOT NULL THEN DELETE FROM branch_catalog WHERE table_name IN ('teacher_invitations','teacher_app_settings'); END IF; END $$;
DROP FUNCTION teacher_invite_accept(text, bigint, text);
DROP FUNCTION teacher_invite_peek(text);
DROP TABLE teacher_app_settings;
DROP TABLE teacher_invitations;
ALTER TABLE teachers DROP COLUMN guardian_messaging_enabled;
