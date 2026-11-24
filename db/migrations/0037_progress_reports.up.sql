-- 0037_progress_reports (up)
-- Why: G4: the monthly progress report of a student in a group (attendance + grade + notes + exam results) as a PDF.
--   A report is created as a DRAFT (the person can regenerate it); a person APPROVES it for a guardian, which queues the
--   Telegram message through the outbox. An approved report is frozen: what was sent never changes (Model B).
-- Queries the indexes serve:
--   Q-rep-1  reports of a group/month by status   -> progress_reports_group_month
--   Q-rep-2  reports of a student (cabinet)       -> progress_reports_student

CREATE TABLE progress_reports (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL,
  public_id             UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id            BIGINT NOT NULL,
  group_id              BIGINT NOT NULL,
  period_month          DATE NOT NULL CHECK (EXTRACT(day FROM period_month) = 1),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  snapshot              JSONB NOT NULL,
  generated_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  CONSTRAINT progress_reports_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT progress_reports_group_fk   FOREIGN KEY (org_id, group_id)   REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT progress_reports_public_id_key UNIQUE (public_id),
  CONSTRAINT progress_reports_org_id_key UNIQUE (org_id, id),
  CONSTRAINT progress_reports_period_key UNIQUE (student_id, group_id, period_month),
  CONSTRAINT progress_reports_approved_pair CHECK ((status = 'approved') = (approved_at IS NOT NULL))
);
CREATE INDEX progress_reports_group_month ON progress_reports (org_id, group_id, period_month, status);
CREATE INDEX progress_reports_student ON progress_reports (org_id, student_id, period_month DESC);

-- The PDF travels in its own table so audit snapshots of report rows stay small (same as documents).
CREATE TABLE progress_report_files (
  org_id    BIGINT NOT NULL,
  report_id BIGINT PRIMARY KEY,
  pdf       BYTEA NOT NULL CHECK (octet_length(pdf) > 0),
  CONSTRAINT progress_report_files_report_fk FOREIGN KEY (org_id, report_id) REFERENCES progress_reports(org_id, id) ON DELETE CASCADE
);

-- Approval is one-way and freezes the report: no change of content, no deletion, no way back to a draft.
CREATE FUNCTION guard_progress_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved progress report cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved progress report is frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.student_id <> OLD.student_id OR NEW.group_id <> OLD.group_id OR NEW.period_month <> OLD.period_month THEN
    RAISE EXCEPTION 'a progress report keeps its student, group and month' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_progress_reports_guard BEFORE UPDATE OR DELETE ON progress_reports FOR EACH ROW EXECUTE FUNCTION guard_progress_report();

CREATE FUNCTION guard_progress_report_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM progress_reports WHERE org_id = COALESCE(NEW.org_id, OLD.org_id) AND id = COALESCE(NEW.report_id, OLD.report_id);
  IF st = 'approved' THEN
    RAISE EXCEPTION 'the PDF of an approved progress report is frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_progress_report_files_guard BEFORE UPDATE OR DELETE ON progress_report_files FOR EACH ROW EXECUTE FUNCTION guard_progress_report_file();

CREATE TRIGGER trg_progress_reports_audit AFTER INSERT OR UPDATE OR DELETE ON progress_reports FOR EACH ROW EXECUTE FUNCTION audit_row();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['progress_reports','progress_report_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON progress_reports, progress_report_files TO nazoratly_app;
