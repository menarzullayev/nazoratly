-- 0060_guardian_links (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM guardian_link_codes) OR EXISTS (SELECT 1 FROM guardian_link_requests) THEN
    RAISE EXCEPTION 'cannot roll back 0060: guardian link codes or link requests exist';
  END IF;
END $$;
DROP FUNCTION guardian_find_by_phone(text);
DROP FUNCTION guardian_find_by_telegram(bigint);
DROP FUNCTION guardian_find_student_by_qr(text);
DROP FUNCTION guardian_find_code(text);
DELETE FROM branch_catalog WHERE table_name IN ('guardian_link_codes','guardian_link_requests');
DROP TABLE guardian_link_attempts;
DROP TABLE guardian_link_requests;
DROP TABLE guardian_link_codes;
DROP FUNCTION guardian_branch_stamp();
ALTER TABLE student_guardians DROP COLUMN linked_via;
DROP FUNCTION app_guardian_id();
