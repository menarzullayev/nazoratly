-- 0036_exams (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM exams) THEN
    RAISE EXCEPTION 'cannot roll back 0036: exams exist (delete them first)';
  END IF;
END $$;
DROP TABLE exam_results;
DROP TABLE exams;
DROP FUNCTION check_exam_result();
DROP FUNCTION check_exam_change();
