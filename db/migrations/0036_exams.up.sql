-- 0036_exams (up)
-- Why: G4: simple exam/test results. An exam is ONE group event (title, date, maximum score); each student of the group
--   gets at most one score. No question bank and no online test.
-- Queries the indexes serve:
--   Q-exam-1  exams of a group by date             -> exams_group_date
--   Q-exam-2  results of an exam / of a student    -> exam_results_exam_student_key / exam_results_student

CREATE TABLE exams (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  group_id           BIGINT NOT NULL,
  title              TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  held_on            DATE NOT NULL,
  max_score          NUMERIC(8,2) NOT NULL CHECK (max_score > 0),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exams_group_fk FOREIGN KEY (org_id, group_id) REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT exams_public_id_key UNIQUE (public_id),
  CONSTRAINT exams_org_id_key UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX exams_group_title_date_key ON exams (group_id, held_on, lower(btrim(title)));
CREATE INDEX exams_group_date ON exams (org_id, group_id, held_on DESC);

CREATE TABLE exam_results (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  exam_id            BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  score              NUMERIC(8,2) NOT NULL CHECK (score >= 0),
  note               TEXT CHECK (note IS NULL OR (length(btrim(note)) BETWEEN 1 AND 500)),
  entered_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_results_exam_fk    FOREIGN KEY (org_id, exam_id)    REFERENCES exams(org_id, id) ON DELETE CASCADE,
  CONSTRAINT exam_results_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_results_exam_student_key UNIQUE (exam_id, student_id)
);
CREATE INDEX exam_results_student ON exam_results (org_id, student_id);

-- The score never exceeds the exam's maximum and belongs to a student of the exam's group.
CREATE FUNCTION check_exam_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e exams%ROWTYPE;
BEGIN
  SELECT * INTO e FROM exams WHERE org_id = NEW.org_id AND id = NEW.exam_id;
  IF NEW.score > e.max_score THEN
    RAISE EXCEPTION 'score % is above the exam maximum %', NEW.score, e.max_score USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrollments en WHERE en.org_id = NEW.org_id AND en.group_id = e.group_id AND en.student_id = NEW.student_id) THEN
    RAISE EXCEPTION 'student % is not enrolled in the group of exam %', NEW.student_id, NEW.exam_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_exam_results_check BEFORE INSERT OR UPDATE OF score, student_id, exam_id ON exam_results
  FOR EACH ROW EXECUTE FUNCTION check_exam_result();

-- Lowering the maximum below an entered score, or moving the exam to another group, is refused.
CREATE FUNCTION check_exam_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_id <> OLD.group_id THEN
    RAISE EXCEPTION 'an exam cannot move to another group' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_score < OLD.max_score AND EXISTS (SELECT 1 FROM exam_results r WHERE r.exam_id = NEW.id AND r.score > NEW.max_score) THEN
    RAISE EXCEPTION 'a score is above the new maximum %', NEW.max_score USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_exams_change BEFORE UPDATE OF max_score, group_id ON exams FOR EACH ROW EXECUTE FUNCTION check_exam_change();

CREATE TRIGGER trg_exams_updated_at BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exam_results_updated_at BEFORE UPDATE ON exam_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exams_audit AFTER INSERT OR UPDATE OR DELETE ON exams FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_exam_results_audit AFTER INSERT OR UPDATE OR DELETE ON exam_results FOR EACH ROW EXECUTE FUNCTION audit_row();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exams','exam_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON exams, exam_results TO nazoratly_app;
