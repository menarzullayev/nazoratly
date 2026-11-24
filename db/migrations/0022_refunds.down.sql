-- 0022_refunds (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM refunds) THEN
    RAISE EXCEPTION 'cannot roll back 0022: refunds exist (they are part of the books)';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE source_type IN ('refund','cash_close')) THEN
    RAISE EXCEPTION 'cannot roll back 0022: the journal has refund or cash-close entries (it is immutable)';
  END IF;
END $$;

DROP TABLE refund_payments;
DROP TABLE refunds;

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN
  ('manual','reversal','payment','payment_void','expense','expense_void','bill_payment','bill_payment_void',
   'payroll_accrual','payroll_payment'));

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
  SELECT sum(p.amount) - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa
                                   JOIN payments p2 ON p2.id = pa.payment_id
                                   WHERE p2.student_id = s.id AND p2.voided_at IS NULL), 0) AS unallocated
  FROM payments p WHERE p.student_id = s.id AND p.voided_at IS NULL) pm ON TRUE
WHERE s.deleted_at IS NULL;

CREATE OR REPLACE FUNCTION guard_payment_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alloc NUMERIC;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO alloc FROM payment_allocations WHERE payment_id = NEW.id;
  IF NEW.amount < alloc THEN
    RAISE EXCEPTION 'payment amount % is below allocated %', NEW.amount, alloc USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'cannot change student of an allocated payment' USING ERRCODE = 'check_violation';
  END IF;
  IF alloc > 0 AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'remove allocations before voiding payment %', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

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
  IF p_sum > p.amount THEN
    RAISE EXCEPTION 'allocations (%) exceed payment amount (%)', p_sum, p.amount USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO c_sum FROM payment_allocations WHERE charge_id = NEW.charge_id;
  IF c_sum > c.amount THEN
    RAISE EXCEPTION 'allocations (%) exceed charge amount (%)', c_sum, c.amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE payments DROP CONSTRAINT payments_refunded_le_amount;
ALTER TABLE payments DROP COLUMN refunded;
