-- 0021_discount_lines
-- Why: G1. What discounts a charge got, kept as lines so reports can split them by kind (scholarship separately), and
--   the early-payment offer a charge carries until it is earned.
--   charges.gross_amount   fee after the legacy enrollment discount, before lasting discounts (NULL on older charges)
--   charges.early_discount so'm off if the charge is paid by early_pay_by; early_granted_at when it was earned (the
--                          charge amount is reduced at that moment and a discount line of kind early_pay is written)
-- discount_lines.charge_id is NULL for a month that was fully free (no charge exists: amount > 0 is required).
-- Queries: Q-disc-3 lines of a month by kind (reports) -> discount_lines_month; Q-disc-4 lines of a charge -> discount_lines_charge
ALTER TABLE charges ADD COLUMN gross_amount NUMERIC(14,2) CHECK (gross_amount IS NULL OR gross_amount > 0);
ALTER TABLE charges ADD COLUMN early_discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (early_discount >= 0);
ALTER TABLE charges ADD COLUMN early_pay_by DATE;
ALTER TABLE charges ADD COLUMN early_granted_at TIMESTAMPTZ;
ALTER TABLE charges ADD COLUMN early_source_id BIGINT;      -- the early_pay rule that made the offer
ALTER TABLE charges ADD CONSTRAINT charges_early_source_fk FOREIGN KEY (org_id, early_source_id) REFERENCES student_discounts(org_id, id) ON DELETE RESTRICT;
ALTER TABLE charges ADD CONSTRAINT charges_early_pair CHECK ((early_discount > 0) = (early_pay_by IS NOT NULL) AND (early_discount > 0) = (early_source_id IS NOT NULL));
ALTER TABLE charges ADD CONSTRAINT charges_early_granted CHECK (early_granted_at IS NULL OR early_discount > 0);

CREATE TABLE discount_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL,
  student_id    BIGINT NOT NULL,
  enrollment_id BIGINT NOT NULL,
  charge_id     BIGINT,
  period_month  DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  kind          TEXT NOT NULL CHECK (kind IN ('family','individual','scholarship','early_pay')),
  source_id     BIGINT,                                   -- the student_discounts rule (NULL for the family discount)
  percent       NUMERIC(5,2),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discount_lines_org_fk        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT discount_lines_student_fk    FOREIGN KEY (org_id, student_id)    REFERENCES students(org_id, id)          ON DELETE RESTRICT,
  CONSTRAINT discount_lines_enrollment_fk FOREIGN KEY (org_id, enrollment_id) REFERENCES enrollments(org_id, id)       ON DELETE RESTRICT,
  CONSTRAINT discount_lines_charge_fk     FOREIGN KEY (org_id, charge_id)     REFERENCES charges(org_id, id)           ON DELETE RESTRICT,
  CONSTRAINT discount_lines_source_fk     FOREIGN KEY (org_id, source_id)     REFERENCES student_discounts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT discount_lines_family_source CHECK ((kind = 'family') = (source_id IS NULL))
);
-- re-running generation (or granting twice) never duplicates a line
CREATE UNIQUE INDEX discount_lines_once ON discount_lines (enrollment_id, period_month, kind, (COALESCE(source_id, 0)));
CREATE INDEX discount_lines_month ON discount_lines (org_id, period_month, kind);
CREATE INDEX discount_lines_charge ON discount_lines (charge_id) WHERE charge_id IS NOT NULL;
CREATE INDEX discount_lines_student ON discount_lines (org_id, student_id);

CREATE TRIGGER trg_discount_lines_audit AFTER INSERT OR UPDATE OR DELETE ON discount_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE discount_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discount_lines FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT ON discount_lines TO nazoratly_app;
