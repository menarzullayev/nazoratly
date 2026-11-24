-- 0025_schedule_changes
-- Why: group G2 (schedule and rooms) of docs/superpowers/specs/2026-11-24-product-expansion-2-design.md.
--   (1) a substitute teacher per lesson (payroll follows the substitute) and the trail of a moved/cancelled lesson;
--   (2) lesson_changes: an append-only log of every move / cancel / substitute with the payroll effect computed then;
--   (3) schedule_notices: guardian message DRAFTS for a moved or cancelled lesson. Nothing is queued for sending until a
--       person approves a notice (Model B); approval queues an outbox message and the outbox trigger re-checks the
--       guardian link and the active notifications consent.
-- Queries the indexes serve:
--   Q-sch-1  lessons of a substitute teacher in a date range     -> lessons_substitute
--   Q-sch-2  history of one lesson                               -> lesson_changes_lesson
--   Q-sch-3  pending notices of a center, oldest first            -> schedule_notices_pending
--   Q-sch-4  notices of one change                                -> schedule_notices_change_student_guardian_key

ALTER TABLE lessons ADD COLUMN substitute_teacher_id BIGINT;
ALTER TABLE lessons ADD COLUMN cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) > 0);
ALTER TABLE lessons ADD COLUMN original_date DATE;
ALTER TABLE lessons ADD COLUMN original_start_time TIME;
ALTER TABLE lessons ADD CONSTRAINT lessons_substitute_fk FOREIGN KEY (org_id, substitute_teacher_id)
  REFERENCES teachers(org_id, id) ON DELETE RESTRICT;
ALTER TABLE lessons ADD CONSTRAINT lessons_original_pair CHECK ((original_date IS NULL) = (original_start_time IS NULL));
CREATE INDEX lessons_substitute ON lessons (org_id, substitute_teacher_id, lesson_date) WHERE substitute_teacher_id IS NOT NULL;

CREATE TABLE lesson_changes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  lesson_id          BIGINT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('move','cancel','substitute')),
  old_date           DATE NOT NULL,
  old_start_time     TIME NOT NULL,
  old_end_time       TIME NOT NULL,
  new_date           DATE,
  new_start_time     TIME,
  new_end_time       TIME,
  old_teacher_id     BIGINT,
  new_teacher_id     BIGINT,
  old_room_id        BIGINT,
  new_room_id        BIGINT,
  reason             TEXT CHECK (reason IS NULL OR length(btrim(reason)) > 0),
  payroll_effect     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lesson_changes_lesson_fk FOREIGN KEY (org_id, lesson_id) REFERENCES lessons(org_id, id) ON DELETE CASCADE,
  CONSTRAINT lesson_changes_old_teacher_fk FOREIGN KEY (org_id, old_teacher_id) REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lesson_changes_new_teacher_fk FOREIGN KEY (org_id, new_teacher_id) REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lesson_changes_old_room_fk FOREIGN KEY (org_id, old_room_id) REFERENCES rooms(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lesson_changes_new_room_fk FOREIGN KEY (org_id, new_room_id) REFERENCES rooms(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lesson_changes_public_id_key UNIQUE (public_id),
  CONSTRAINT lesson_changes_org_id_key UNIQUE (org_id, id),
  CONSTRAINT lesson_changes_time CHECK (old_end_time > old_start_time AND (new_end_time IS NULL OR new_end_time > new_start_time)),
  CONSTRAINT lesson_changes_move_shape CHECK (kind <> 'move' OR (new_date IS NOT NULL AND new_start_time IS NOT NULL AND new_end_time IS NOT NULL))
);
CREATE INDEX lesson_changes_lesson ON lesson_changes (org_id, lesson_id, created_at);

CREATE TABLE schedule_notices (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  change_id          BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  guardian_id        BIGINT NOT NULL,
  body               TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  outbox_id          BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_notices_change_fk   FOREIGN KEY (org_id, change_id)   REFERENCES lesson_changes(org_id, id) ON DELETE CASCADE,
  CONSTRAINT schedule_notices_student_fk  FOREIGN KEY (org_id, student_id)  REFERENCES students(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT schedule_notices_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT schedule_notices_outbox_fk   FOREIGN KEY (org_id, outbox_id)   REFERENCES outbox_messages(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT schedule_notices_public_id_key UNIQUE (public_id),
  CONSTRAINT schedule_notices_org_id_key UNIQUE (org_id, id),
  CONSTRAINT schedule_notices_change_student_guardian_key UNIQUE (change_id, student_id, guardian_id),
  CONSTRAINT schedule_notices_decision CHECK (
    (status = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL)),
  CONSTRAINT schedule_notices_outbox_only_approved CHECK (outbox_id IS NULL OR status = 'approved')
);
CREATE INDEX schedule_notices_pending ON schedule_notices (org_id, created_at) WHERE status = 'pending';
CREATE INDEX schedule_notices_student ON schedule_notices (org_id, student_id);

-- A decided notice never changes its text or its addressee, and a decision is final.
CREATE FUNCTION guard_schedule_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body <> OLD.body OR NEW.student_id <> OLD.student_id OR NEW.guardian_id <> OLD.guardian_id OR NEW.change_id <> OLD.change_id THEN
    RAISE EXCEPTION 'notice content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'notice already %', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_schedule_notices_guard BEFORE UPDATE ON schedule_notices FOR EACH ROW EXECUTE FUNCTION guard_schedule_notice();
CREATE TRIGGER trg_schedule_notices_updated_at BEFORE UPDATE ON schedule_notices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_lesson_changes_audit AFTER INSERT OR UPDATE OR DELETE ON lesson_changes FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_schedule_notices_audit AFTER INSERT OR UPDATE OR DELETE ON schedule_notices FOR EACH ROW EXECUTE FUNCTION audit_row();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lesson_changes','schedule_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
-- the change log is append-only for the application role
GRANT SELECT, INSERT ON lesson_changes TO nazoratly_app;
GRANT SELECT, INSERT, UPDATE ON schedule_notices TO nazoratly_app;
