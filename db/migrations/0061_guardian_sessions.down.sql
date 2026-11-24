-- 0061_guardian_sessions (down)
DROP FUNCTION guardian_session_find(text);
DELETE FROM branch_catalog WHERE table_name IN ('guardian_login_codes','guardian_sessions');
DROP TABLE guardian_sessions;
DROP TABLE guardian_login_codes;
