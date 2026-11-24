-- 0035_learning_marks (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM learning_marks) THEN
    RAISE EXCEPTION 'cannot roll back 0035: teachers'' notes and grades exist (delete them first)';
  END IF;
END $$;
DROP TABLE learning_marks;
DROP FUNCTION check_learning_mark();
