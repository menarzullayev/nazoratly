-- 0022_refunds
-- Why: G1. Four kinds of refund, all booked through the journal (a refund that stays as credit moves no money).
--   wrong_payment      money back for a mistaken payment (cash or bank)
--   leaving            the proportional remainder of a month when a student leaves (cash, bank or credit)
--   package_remainder  value of the unused lessons of a package (cash, bank or credit)
--   to_credit          paid money kept as the student's credit, no cash
-- Model: refunds are append-only. payments.refunded is the part of a payment given back in cash/bank: it is no longer
-- the student's credit (v_student_balance) and cannot be allocated (check_allocation) or voided away.
-- A refund that reduces a charge (leaving, package_remainder, to_credit) records `charge_reduction`.
-- Queries: Q-ref-1 refunds of a student -> refunds_student; Q-ref-2 refunds of a day (reports) -> refunds_date;
--          Q-ref-3 split of a refund over payments -> refund_payments_refund
ALTER TABLE payments ADD COLUMN refunded NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (refunded >= 0);
ALTER TABLE payments ADD CONSTRAINT payments_refunded_le_amount CHECK (refunded <= amount);

CREATE TABLE refunds (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('wrong_payment','leaving','package_remainder','to_credit')),
  payout             TEXT NOT NULL CHECK (payout IN ('cash','bank','credit')),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),              -- money that left (cash/bank) or became credit
  charge_reduction   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (charge_reduction >= 0),
  charge_id          BIGINT,
  payment_id         BIGINT,                                                  -- wrong_payment: the mistaken payment
  package_id         BIGINT,
  left_on            DATE,
  reason             TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  refunded_on        DATE NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT refunds_student_fk  FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id)       ON DELETE RESTRICT,
  CONSTRAINT refunds_charge_fk   FOREIGN KEY (org_id, charge_id)  REFERENCES charges(org_id, id)        ON DELETE RESTRICT,
  CONSTRAINT refunds_payment_fk  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)       ON DELETE RESTRICT,
  CONSTRAINT refunds_package_fk  FOREIGN KEY (org_id, package_id) REFERENCES lesson_packages(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT refunds_public_id_key UNIQUE (public_id),
  CONSTRAINT refunds_org_id_key    UNIQUE (org_id, id),
  CONSTRAINT refunds_payout_kind   CHECK ((kind = 'to_credit') = (payout = 'credit') OR kind IN ('leaving','package_remainder')),
  CONSTRAINT refunds_wrong_payment CHECK ((kind = 'wrong_payment') = (payment_id IS NOT NULL)),
  CONSTRAINT refunds_charge_kinds  CHECK ((kind IN ('leaving','package_remainder','to_credit')) = (charge_id IS NOT NULL)),
  CONSTRAINT refunds_package_kind  CHECK ((kind = 'package_remainder') = (package_id IS NOT NULL)),
  CONSTRAINT refunds_leaving_date  CHECK ((kind = 'leaving') = (left_on IS NOT NULL))
);
CREATE INDEX refunds_student ON refunds (org_id, student_id, refunded_on);
CREATE INDEX refunds_date ON refunds (org_id, refunded_on);
CREATE INDEX refunds_charge ON refunds (charge_id) WHERE charge_id IS NOT NULL;
CREATE INDEX refunds_payment ON refunds (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX refunds_package ON refunds (package_id) WHERE package_id IS NOT NULL;

-- which payments a cash/bank refund was taken from (newest first); empty for credit payouts
CREATE TABLE refund_payments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL,
  refund_id  BIGINT NOT NULL,
  payment_id BIGINT NOT NULL,
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  CONSTRAINT refund_payments_refund_fk  FOREIGN KEY (org_id, refund_id)  REFERENCES refunds(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT refund_payments_payment_fk FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT refund_payments_pair_key   UNIQUE (refund_id, payment_id)
);
CREATE INDEX refund_payments_payment ON refund_payments (payment_id);

-- allocations (money applied to charges) plus what was given back never exceed the payment
CREATE OR REPLACE FUNCTION check_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p payments%ROWTYPE;
  c charges%ROWTYPE;
  p_sum NUMERIC;
  c_sum NUMERIC;
BEGIN
  SELECT * INTO p FROM payments WHERE org_id = NEW.org_id AND id = NEW.payment_id FOR UPDATE;
  SELECT * INTO c FROM charges  WHERE org_id = NEW.org_id AND id = NEW.charge_id  FOR UPDATE;
  IF p.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment % is voided', p.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'charge % is voided', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF p.student_id <> c.student_id THEN
    RAISE EXCEPTION 'payment % and charge % belong to different students', p.id, c.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO p_sum FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF p_sum + p.refunded > p.amount THEN
    RAISE EXCEPTION 'allocations (%) and refunds (%) exceed payment amount (%)', p_sum, p.refunded, p.amount USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO c_sum FROM payment_allocations WHERE charge_id = NEW.charge_id;
  IF c_sum > c.amount THEN
    RAISE EXCEPTION 'allocations (%) exceed charge amount (%)', c_sum, c.amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION guard_payment_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alloc NUMERIC;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO alloc FROM payment_allocations WHERE payment_id = NEW.id;
  IF NEW.amount < alloc + NEW.refunded THEN
    RAISE EXCEPTION 'payment amount % is below allocated % plus refunded %', NEW.amount, alloc, NEW.refunded USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refunded < OLD.refunded THEN
    RAISE EXCEPTION 'a refund cannot be taken back' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refunded > OLD.refunded AND NEW.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided payment cannot be refunded' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount <> OLD.amount AND OLD.refunded > 0 THEN
    RAISE EXCEPTION 'the amount of a refunded payment cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'cannot change student of an allocated payment' USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'remove allocations before voiding payment %', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refunded > 0 AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'payment % has refunds and cannot be voided', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- credit = money received minus what was applied to charges minus what was given back in cash/bank
CREATE OR REPLACE VIEW v_student_balance WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.org_id,
       COALESCE(ch.outstanding_total, 0) AS outstanding_total,
       COALESCE(ch.overdue_total, 0)     AS overdue_total,
       COALESCE(pm.unallocated, 0)       AS credit
FROM students s
LEFT JOIN LATERAL (
  SELECT sum(b.outstanding) AS outstanding_total,
         sum(b.overdue_outstanding) AS overdue_total
  FROM v_charge_balance b WHERE b.student_id = s.id) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT sum(p.amount - p.refunded) - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa
                                   JOIN payments p2 ON p2.id = pa.payment_id
                                   WHERE p2.student_id = s.id AND p2.voided_at IS NULL), 0) AS unallocated
  FROM payments p WHERE p.student_id = s.id AND p.voided_at IS NULL) pm ON TRUE
WHERE s.deleted_at IS NULL;

-- journal: refunds and cash-close adjustments are source documents of their own
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN
  ('manual','reversal','payment','payment_void','expense','expense_void','bill_payment','bill_payment_void',
   'payroll_accrual','payroll_payment','refund','cash_close'));

CREATE TRIGGER trg_refunds_audit AFTER INSERT OR UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_refund_payments_audit AFTER INSERT OR UPDATE OR DELETE ON refund_payments FOR EACH ROW EXECUTE FUNCTION audit_row();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['refunds','refund_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;
-- append-only: the application can read and add refunds, never change or delete them
GRANT SELECT, INSERT ON refunds, refund_payments TO nazoratly_app;
GRANT SELECT ON v_student_balance TO nazoratly_app;
