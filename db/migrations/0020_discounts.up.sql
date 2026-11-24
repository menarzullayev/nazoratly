-- 0020_discounts
-- Why: G1 money rules (docs/superpowers/specs/2026-11-24-product-expansion-2-design.md section 4): lasting discounts.
--   (1) family discount percents per center (2nd and 3rd+ child), (2) per-student discount rules: individual
--   (percent or amount), scholarship (percent, 100 = free) and early payment (percent + pay-by day of the month).
-- Queries the indexes serve:
--   Q-disc-1  rules of a student that are valid in a month (charge generation)  -> student_discounts_student
--   Q-disc-2  rules by kind for reports                                         -> student_discounts_kind
ALTER TABLE org_settings ADD COLUMN family_discount_2nd_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (family_discount_2nd_percent BETWEEN 0 AND 100);
ALTER TABLE org_settings ADD COLUMN family_discount_3rd_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (family_discount_3rd_percent BETWEEN 0 AND 100);

CREATE TABLE student_discounts (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL,
  enrollment_id      BIGINT,                         -- NULL = every tuition charge of the student
  kind               TEXT NOT NULL CHECK (kind IN ('individual','scholarship','early_pay')),
  percent            NUMERIC(5,2),
  amount             NUMERIC(14,2),                  -- so'm off ONE charge (per charge when enrollment_id is NULL)
  pay_by_day         SMALLINT,                       -- early_pay: the day of the billed month the money must arrive by
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  valid_from         DATE NOT NULL,
  valid_to           DATE,                           -- NULL = until ended
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_discounts_org_fk        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT student_discounts_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)    ON DELETE RESTRICT,
  CONSTRAINT student_discounts_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_discounts_public_id_key UNIQUE (public_id),
  CONSTRAINT student_discounts_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT student_discounts_one_value     CHECK ((percent IS NULL) <> (amount IS NULL)),
  CONSTRAINT student_discounts_percent_range CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  CONSTRAINT student_discounts_amount_pos    CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT student_discounts_scholarship   CHECK (kind <> 'scholarship' OR percent IS NOT NULL),
  CONSTRAINT student_discounts_early         CHECK (kind <> 'early_pay' OR (percent IS NOT NULL AND percent < 100 AND COALESCE(pay_by_day BETWEEN 1 AND 28, false))),
  CONSTRAINT student_discounts_pay_by_only   CHECK (kind = 'early_pay' OR pay_by_day IS NULL),
  CONSTRAINT student_discounts_dates         CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX student_discounts_student ON student_discounts (org_id, student_id, valid_from);
CREATE INDEX student_discounts_kind ON student_discounts (org_id, kind);
CREATE INDEX student_discounts_enrollment ON student_discounts (org_id, enrollment_id) WHERE enrollment_id IS NOT NULL;

CREATE TRIGGER trg_student_discounts_updated_at BEFORE UPDATE ON student_discounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_discounts_audit AFTER INSERT OR UPDATE OR DELETE ON student_discounts FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE student_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_discounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_discounts FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON student_discounts TO nazoratly_app;
