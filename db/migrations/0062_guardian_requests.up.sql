-- 0062_guardian_requests
-- Why: G7 guardian actions. A guardian can ask for three things; every one waits for the center (Model B) and does
--   nothing until staff approves:
--     absence_reason   "my child cannot come to this lesson" + a reason            -> approval marks the lesson `excused`
--     payment_promise  "I will pay by this date" (+ optional amount <= the debt)    -> approval records the promise
--     makeup_choice    one offered slot for an OPEN make-up right                   -> approval schedules the make-up lesson
--   The row keeps who asked (guardian), for which student, the facts of the ask and who decided when. The rules are in
--   rules/guardian.py (checks before saving, status transitions, the effect of an approval).
-- Queries the indexes serve:
--   Q-gr-1  pending requests of a center (staff inbox)              -> guardian_requests_pending
--   Q-gr-2  requests of one guardian (cabinet "my requests")        -> guardian_requests_guardian
--   Q-gr-3  an approved promise that still holds for a student      -> guardian_requests_promise
-- Duplicates: one open absence request per (student, lesson), one open promise per student, one open make-up choice per right.

CREATE TABLE guardian_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  guardian_id        BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('absence_reason','payment_promise','makeup_choice')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  lesson_id          BIGINT,                       -- absence_reason: the lesson
  reason             TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 300),
  promise_date       DATE,                         -- payment_promise
  promise_amount     NUMERIC(14,2) CHECK (promise_amount IS NULL OR promise_amount > 0),
  entitlement_id     BIGINT,                       -- makeup_choice: the open right
  slot_lesson_id     BIGINT,                       -- makeup_choice: the chosen slot (a lesson of another group of the course)
  decided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  branch_id          BIGINT NOT NULL,
  CONSTRAINT guardian_requests_org_fk         FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_guardian_fk    FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_student_fk     FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_lesson_fk      FOREIGN KEY (org_id, lesson_id) REFERENCES lessons(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_entitlement_fk FOREIGN KEY (org_id, entitlement_id) REFERENCES absence_entitlements(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_slot_fk        FOREIGN KEY (org_id, slot_lesson_id) REFERENCES lessons(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_branch_fk      FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT guardian_requests_public_id_key  UNIQUE (public_id),
  CONSTRAINT guardian_requests_org_id_key     UNIQUE (org_id, id),
  CONSTRAINT guardian_requests_decided        CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT guardian_requests_shape CHECK (
       (kind = 'absence_reason'  AND lesson_id IS NOT NULL AND reason IS NOT NULL AND promise_date IS NULL AND promise_amount IS NULL AND entitlement_id IS NULL AND slot_lesson_id IS NULL)
    OR (kind = 'payment_promise' AND promise_date IS NOT NULL AND lesson_id IS NULL AND reason IS NULL AND entitlement_id IS NULL AND slot_lesson_id IS NULL)
    OR (kind = 'makeup_choice'   AND entitlement_id IS NOT NULL AND slot_lesson_id IS NOT NULL AND lesson_id IS NULL AND reason IS NULL AND promise_date IS NULL AND promise_amount IS NULL))
);
CREATE INDEX guardian_requests_pending ON guardian_requests (org_id, id) WHERE status = 'pending';
CREATE INDEX guardian_requests_guardian ON guardian_requests (org_id, guardian_id, id DESC);
CREATE INDEX guardian_requests_promise ON guardian_requests (org_id, student_id, promise_date) WHERE kind = 'payment_promise' AND status IN ('pending','approved');
CREATE INDEX guardian_requests_org_branch ON guardian_requests (org_id, branch_id);
CREATE UNIQUE INDEX guardian_requests_open_absence ON guardian_requests (student_id, lesson_id) WHERE kind = 'absence_reason' AND status = 'pending';
CREATE UNIQUE INDEX guardian_requests_open_promise ON guardian_requests (student_id) WHERE kind = 'payment_promise' AND status = 'pending';
CREATE UNIQUE INDEX guardian_requests_open_makeup ON guardian_requests (entitlement_id) WHERE kind = 'makeup_choice' AND status = 'pending';

CREATE TRIGGER trg_guardian_requests_updated_at BEFORE UPDATE ON guardian_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_guardian_requests_audit AFTER INSERT OR UPDATE OR DELETE ON guardian_requests FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_0_branch_stamp BEFORE INSERT ON guardian_requests FOR EACH ROW EXECUTE FUNCTION guardian_branch_stamp();

INSERT INTO branch_catalog (table_name, kind, mode, p1_table, p1_col, ord) VALUES
  ('guardian_requests', 'strict', 'parent', 'students', 'student_id', 77);

ALTER TABLE guardian_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guardian_requests FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY branch_scope ON guardian_requests AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id())
  WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id());
-- a guardian session sees and creates only its own guardian's requests
CREATE POLICY guardian_fence ON guardian_requests AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR guardian_id = app_guardian_id())
  WITH CHECK (app_guardian_id() IS NULL OR guardian_id = app_guardian_id());
GRANT SELECT, INSERT, UPDATE ON guardian_requests TO nazoratly_app;
