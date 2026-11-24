-- 0038_certificates (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM certificates) THEN
    RAISE EXCEPTION 'cannot roll back 0038: issued certificates exist (they are immutable records)';
  END IF;
END $$;
DROP FUNCTION certificate_verify(TEXT);
DROP TABLE certificate_files;
DROP TABLE certificates;
DROP TABLE certificate_counters;
DROP FUNCTION next_certificate_serial(INTEGER);
DROP FUNCTION guard_certificate();
