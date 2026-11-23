-- 0012_makeup
-- Why: capability 4.2 of docs/superpowers/specs/2026-11-23-product-expansion-design.md (excused absence and make-up).
--   (1) org_settings: what an excused absence does (make-up right / credit / nothing), right expiry, lapsing;
--   (2) lessons.kind: a make-up lesson is a lesson row of kind 'makeup';
--   (3) absence_entitlements: one row per excused (lesson, student): a make-up right or a money credit.
-- Queries the indexes serve:
--   Q-ent-1  open/scheduled rights of a center by expiry     -> absence_entitlements_status
--   Q-ent-2  rights of a student                             -> absence_entitlements_student
--   Q-ent-3  open credits of a student (charge generation)   -> absence_entitlements_credits

ALTER TABLE org_settings ADD COLUMN excused_mode TEXT NOT NULL DEFAULT 'makeup'
  CHECK (excused_mode IN ('makeup','credit','none'));
ALTER TABLE org_settings ADD COLUMN makeup_expiry_days INTEGER NOT NULL DEFAULT 30
  CHECK (makeup_expiry_days BETWEEN 0 AND 365);
ALTER TABLE org_settings ADD COLUMN makeup_lapses BOOLEAN NOT NULL DEFAULT true;

-- credits can cover a whole tuition fee: a fully covered charge is recorded with amount 0 (keeps generation idempotent)
ALTER TABLE charges DROP CONSTRAINT charges_amount_check;
ALTER TABLE charges ADD CONSTRAINT charges_amount_check CHECK (amount >= 0);

ALTER TABLE lessons ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','makeup'));

CREATE TABLE absence_entitlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL,
  public_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id       BIGINT NOT NULL,
  enrollment_id    BIGINT NOT NULL,
  group_id         BIGINT NOT NULL,
  missed_lesson_id BIGINT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('makeup','credit')),
  amount           NUMERIC(14,2) CHECK (amount >= 0),
  expires_on       DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','scheduled','used','cancelled')),
  makeup_lesson_id BIGINT,
  used_on          DATE,
  applied_charge_id BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT absence_entitlements_student_fk    FOREIGN KEY (org_id, student_id)       REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_enrollment_fk FOREIGN KEY (org_id, enrollment_id)    REFERENCES enrollments(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_group_fk      FOREIGN KEY (org_id, group_id)         REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_missed_fk     FOREIGN KEY (org_id, missed_lesson_id) REFERENCES lessons(org_id, id)      ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_makeup_fk     FOREIGN KEY (org_id, makeup_lesson_id) REFERENCES lessons(org_id, id)      ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_charge_fk     FOREIGN KEY (org_id, applied_charge_id) REFERENCES charges(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT absence_entitlements_public_id_key UNIQUE (public_id),
  CONSTRAINT absence_entitlements_org_id_key    UNIQUE (org_id, id),
  -- one entitlement per excused lesson and student
  CONSTRAINT absence_entitlements_once          UNIQUE (missed_lesson_id, student_id),
  -- a credit carries money, a make-up right does not
  CONSTRAINT absence_entitlements_amount_kind   CHECK ((kind = 'credit') = (amount IS NOT NULL)),
  CONSTRAINT absence_entitlements_used_pair     CHECK ((status = 'used') = (used_on IS NOT NULL OR applied_charge_id IS NOT NULL)),
  CONSTRAINT absence_entitlements_scheduled     CHECK (status <> 'scheduled' OR makeup_lesson_id IS NOT NULL)
);
CREATE INDEX absence_entitlements_status  ON absence_entitlements (org_id, status, expires_on);
CREATE INDEX absence_entitlements_student ON absence_entitlements (student_id, status);
CREATE INDEX absence_entitlements_credits ON absence_entitlements (student_id, created_at, id) WHERE kind = 'credit' AND status = 'open';

CREATE TRIGGER trg_absence_entitlements_updated_at BEFORE UPDATE ON absence_entitlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_absence_entitlements_audit AFTER INSERT OR UPDATE OR DELETE ON absence_entitlements FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE absence_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE absence_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON absence_entitlements FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON absence_entitlements TO nazoratly_app;
