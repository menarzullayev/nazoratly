-- 0035_learning_marks (up)
-- Why: G4 of docs/superpowers/specs/2026-11-24-product-expansion-2-design.md: a lesson or month NOTE and GRADE written by
--   the teacher (later shown in the guardian cabinet). One row per student and lesson, or per student, group and month.
-- Queries the indexes serve:
--   Q-mark-1  marks of a student (cabinet, report)           -> learning_marks_student
--   Q-mark-2  marks of a group in a month (teacher's screen)  -> learning_marks_group_month
--   Q-mark-3  one mark per lesson/student, one per month      -> learning_marks_lesson_key / learning_marks_month_key

CREATE TABLE learning_marks (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL,
  public_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id     BIGINT NOT NULL,
  group_id       BIGINT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('lesson','month')),
  lesson_id      BIGINT,
  period_month   DATE,                                         -- first day of the month (scope 'month')
  grade          SMALLINT CHECK (grade BETWEEN 1 AND 5),
  note           TEXT CHECK (note IS NULL OR (length(btrim(note)) BETWEEN 1 AND 1000)),
  author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT learning_marks_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT learning_marks_group_fk   FOREIGN KEY (org_id, group_id)   REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT learning_marks_lesson_fk  FOREIGN KEY (org_id, lesson_id)  REFERENCES lessons(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT learning_marks_public_id_key UNIQUE (public_id),
  CONSTRAINT learning_marks_org_id_key UNIQUE (org_id, id),
  CONSTRAINT learning_marks_scope_shape CHECK (
       (scope = 'lesson' AND lesson_id IS NOT NULL AND period_month IS NULL)
    OR (scope = 'month'  AND lesson_id IS NULL AND period_month IS NOT NULL AND EXTRACT(day FROM period_month) = 1)),
  CONSTRAINT learning_marks_has_content CHECK (grade IS NOT NULL OR note IS NOT NULL)
);
CREATE UNIQUE INDEX learning_marks_lesson_key ON learning_marks (student_id, lesson_id) WHERE scope = 'lesson';
CREATE UNIQUE INDEX learning_marks_month_key  ON learning_marks (student_id, group_id, period_month) WHERE scope = 'month';
CREATE INDEX learning_marks_student ON learning_marks (org_id, student_id, created_at DESC);
CREATE INDEX learning_marks_group_month ON learning_marks (org_id, group_id, period_month);
CREATE INDEX learning_marks_lesson ON learning_marks (org_id, lesson_id) WHERE lesson_id IS NOT NULL;

-- A mark is only for a student of the group (enrolled now or before) and a lesson of THAT group.
CREATE FUNCTION check_learning_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.org_id = NEW.org_id AND e.group_id = NEW.group_id AND e.student_id = NEW.student_id) THEN
    RAISE EXCEPTION 'student % is not enrolled in group %', NEW.student_id, NEW.group_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.scope = 'lesson' AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.org_id = NEW.org_id AND l.id = NEW.lesson_id AND l.group_id = NEW.group_id) THEN
    RAISE EXCEPTION 'lesson % does not belong to group %', NEW.lesson_id, NEW.group_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_learning_marks_check BEFORE INSERT OR UPDATE OF student_id, group_id, lesson_id, scope ON learning_marks
  FOR EACH ROW EXECUTE FUNCTION check_learning_mark();
CREATE TRIGGER trg_learning_marks_updated_at BEFORE UPDATE ON learning_marks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_learning_marks_audit AFTER INSERT OR UPDATE OR DELETE ON learning_marks FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE learning_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON learning_marks FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON learning_marks TO nazoratly_app;
