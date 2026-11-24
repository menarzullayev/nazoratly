-- 0025_schedule_changes (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lesson_changes) THEN
    RAISE EXCEPTION 'cannot roll back 0025: lesson changes exist (the history of moved/cancelled/substituted lessons would be lost)';
  END IF;
  IF EXISTS (SELECT 1 FROM lessons WHERE substitute_teacher_id IS NOT NULL OR original_date IS NOT NULL OR cancel_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0025: lessons carry substitute / move / cancel data';
  END IF;
END $$;

DROP TABLE schedule_notices;
DROP FUNCTION guard_schedule_notice();
DROP TABLE lesson_changes;
DROP INDEX lessons_substitute;
ALTER TABLE lessons DROP CONSTRAINT lessons_original_pair;
ALTER TABLE lessons DROP CONSTRAINT lessons_substitute_fk;
ALTER TABLE lessons DROP COLUMN original_start_time;
ALTER TABLE lessons DROP COLUMN original_date;
ALTER TABLE lessons DROP COLUMN cancel_reason;
ALTER TABLE lessons DROP COLUMN substitute_teacher_id;
