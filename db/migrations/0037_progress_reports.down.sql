-- 0037_progress_reports (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM progress_reports WHERE status = 'approved') THEN
    RAISE EXCEPTION 'cannot roll back 0037: approved progress reports exist (they were sent to guardians)';
  END IF;
END $$;
DROP TABLE progress_report_files;
DROP TABLE progress_reports;
DROP FUNCTION guard_progress_report();
DROP FUNCTION guard_progress_report_file();
